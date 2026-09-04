// DB safety (2026-09-04): org deletes guarded by assertQaOrg — see
// src/data/db-guard.ts + /home/team/shared/db-safety-rules.md.
// Hermetic tests for SLICE 1 of automated payouts (owner-approved 2026-09-03):
// Stripe Connect contractor bank-linking. The Stripe client is MOCKED via
// dependency injection (opts.client / opts.now) — no real Stripe network, no
// key required. Covers:
//   - fail-closed when the key is absent (getStripeClient returns not-configured,
//     and the *Core fns surface stripe_not_configured without throwing);
//   - ensureConnectedAccount idempotency (second call reuses the persisted id);
//   - createAccountLink returns a URL;
//   - getContractorConnectStatus reflects charges/payouts enabled flags.
// DB-backed against a throwaway QA org deleted at the end (zero rows left).
//   DATABASE_URL=... bun stripe-connect.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 9).toString("base64");
// Ensure the key is absent for the fail-closed test AND never inherited from the
// host (deterministic).
delete process.env.STRIPE_SECRET_KEY;
const {
  getStripeClient,
  ensureConnectedAccount,
  createAccountLink,
  getContractorConnectStatus,
} = await import("./src/data/stripe-connect-core.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");

const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

const TAG = randomUUID().slice(0, 8);
const ORG = `qa-stripe-connect-${TAG}`;
const DRIVER = `qa-sc-driver-${TAG}`;
const email = (u) => `${u}-${randomUUID()}@lightning.test`;
const ACTOR = { orgId: ORG, contractorId: DRIVER };

/* ------------------------- fake Stripe client (injected) ------------------------- */
let createdAccounts = 0;
let createdLinks = 0;
let retrieveCalls = 0;
const fakeStripe = {
  accounts: {
    async create() {
      createdAccounts += 1;
      return {
        id: `acct_qa_${createdAccounts}`,
        charges_enabled: false,
        payouts_enabled: false,
        details_submitted: false,
      };
    },
    async retrieve() {
      retrieveCalls += 1;
      return {
        id: `acct_qa_${createdAccounts}`,
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
      };
    },
  },
  accountLinks: {
    async create() {
      createdLinks += 1;
      return { url: "https://connect.stripe.com/setup/s/qa-link" };
    },
  },
};

/* ------------------------------ setup / cleanup ------------------------------ */
async function cleanup() {
  const memberIds = await q`SELECT DISTINCT m.user_id FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa-stripe-connect-%'`;
  for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa-stripe-connect-%'`) {
    assertQaOrg(org.id, org.name);
    await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
  }
  for (const m of memberIds) await q`DELETE FROM users WHERE id=${m.user_id}`.catch(() => {});
  await q`DELETE FROM users WHERE email LIKE 'qa-stripe-connect-%@lightning.test'`.catch(() => {});
}
await cleanup();
await ensureSchema();
await q`INSERT INTO organizations(id, name) VALUES(${ORG}, ${ORG})`;
await q`INSERT INTO users(id, name, email, password_hash) VALUES(${DRIVER}, 'QA SC Driver', ${email(DRIVER)}, 'x')`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${DRIVER}, 'contractor')`;

/* ============ 1) fail-closed when key is absent ============ */
{
  const client = getStripeClient({}, () => {
    throw new Error("factory must not be called when the key is absent");
  });
  check("getStripeClient: absent key → not configured (no throw)", client.configured === false, JSON.stringify(client));
  check("getStripeClient: clear reason mentions the env var", /STRIPE_SECRET_KEY/.test(client.configured === false ? client.reason : ""), client.configured === false ? client.reason : "");

  const ensured = await ensureConnectedAccount(ACTOR);
  check("ensureConnectedAccount: no key → stripe_not_configured (no throw)", ensured.ok === false && ensured.code === "stripe_not_configured", JSON.stringify(ensured));

  const link = await createAccountLink(ACTOR, "https://x/return", "https://x/refresh");
  check("createAccountLink: no key → stripe_not_configured (no throw)", link.ok === false && link.code === "stripe_not_configured", JSON.stringify(link));
}

/* ============ 2) ensureConnectedAccount idempotency ============ */
let persistedAccountId = "";
{
  const first = await ensureConnectedAccount(ACTOR, { client: fakeStripe });
  check("ensureConnectedAccount: creates + returns an account id", first.ok === true && /^acct_qa_/.test(first.data.stripeAccountId), JSON.stringify(first));
  check("ensureConnectedAccount: created exactly one Stripe account", createdAccounts === 1, String(createdAccounts));
  if (first.ok) persistedAccountId = first.data.stripeAccountId;

  const second = await ensureConnectedAccount(ACTOR, { client: fakeStripe });
  check("ensureConnectedAccount: idempotent — same id", second.ok === true && second.data.stripeAccountId === persistedAccountId, JSON.stringify(second));
  check("ensureConnectedAccount: no second create on reuse", createdAccounts === 1, String(createdAccounts));
}

/* ============ 3) createAccountLink returns a URL ============ */
{
  const link = await createAccountLink(ACTOR, "https://x/return", "https://x/refresh", { client: fakeStripe });
  check("createAccountLink: ok + onboarding URL", link.ok === true && link.data.url.startsWith("https://connect.stripe.com/"), JSON.stringify(link));
  check("createAccountLink: one link created", createdLinks === 1, String(createdLinks));
}

/* ============ 4) getContractorConnectStatus reflects enabled flags ============ */
{
  const st = await getContractorConnectStatus(ACTOR, { client: fakeStripe });
  check("status: linked", st.ok === true && st.data.linked === true, JSON.stringify(st));
  check("status: reflects account id", st.ok === true && st.data.stripeAccountId === persistedAccountId, JSON.stringify(st));
  check("status: charges_enabled + payouts_enabled true (from retrieve)", st.ok === true && st.data.chargesEnabled === true && st.data.payoutsEnabled === true, JSON.stringify(st));
  check("status: onboardingStatus complete", st.ok === true && st.data.onboardingStatus === "complete", JSON.stringify(st));
  check("status: retrieve called once", retrieveCalls === 1, String(retrieveCalls));
}

/* ================================ summary + cleanup ================================ */
const failed = checks.filter(([, ok]) => !ok);
console.log(`stripe-connect.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
  console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n"));
  process.exit(1);
}
await cleanup();
const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa-stripe-connect-%') AS orgs,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE 'qa-stripe-connect-%@lightning.test') AS users,
  (SELECT COUNT(*)::int FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa-stripe-connect-%') AS members,
  (SELECT COUNT(*)::int FROM contractor_profiles cp JOIN organizations o ON o.id=cp.org_id WHERE o.name LIKE 'qa-stripe-connect-%') AS profiles`;
const z = Object.values(leftover[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) {
  console.error("FAIL: QA cleanup left rows behind");
  process.exit(1);
}
console.log("stripe-connect.test.mjs: cleanup verified — zero QA rows left");
