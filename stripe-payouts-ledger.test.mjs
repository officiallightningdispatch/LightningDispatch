// DB safety (2026-09-06): org deletes guarded by assertQaOrg — see
// src/data/db-guard.ts + /home/team/shared/db-safety-rules.md.
// Hermetic tests for SLICE 3 (UI wiring) of automated payouts — the new
// OWNER-side ledger READ (listStripePayoutsCore) added to stripe-payouts-core.
// Read-only: no Stripe call, no money move. Covers:
//   - an empty org ledger returns [] (ok, no throw);
//   - seeded instant_cashout + weekly_payout rows are returned newest-first,
//     mapped to seroval-safe StripePayout shape (null-or-value, no undefined);
//   - failure_message / stripe_transfer_id null-vs-value round-trip;
//   - no money-move: no Stripe client is ever consulted.
// DB-backed against a throwaway QA org deleted at the end (zero rows left).
//   DATABASE_URL=... bun stripe-payouts-ledger.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 9).toString("base64");
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_CONNECT_PAYOUTS_ENABLED;

const { listStripePayoutsCore } = await import("./src/data/stripe-payouts-core.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");

const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

const TAG = randomUUID().slice(0, 8);
const ORG = `qa-stripe-ledger-${TAG}`;
const D1 = `qa-sl-d1-${TAG}`;
const email = (u) => `${u}-${randomUUID()}@lightning.test`;

async function cleanup() {
  await q`DELETE FROM stripe_payouts WHERE org_id=${ORG}`;
  await q`DELETE FROM contractor_profiles WHERE org_id=${ORG}`;
  await q`DELETE FROM organization_memberships WHERE org_id=${ORG}`;
  await q`DELETE FROM users WHERE id IN (${D1})`;
  assertQaOrg(ORG);
  await q`DELETE FROM organizations WHERE id=${ORG}`;
}

let failed = [];
try {
  await ensureSchema();
  await cleanup();
  await q`INSERT INTO organizations(id, name) VALUES(${ORG}, ${ORG})`;
  await q`INSERT INTO users(id, name, email, password_hash, towbook_driver_id) VALUES
    (${D1}, 'QA SL Driver 1', ${email(D1)}, 'x', ${String(([...D1].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 899_000_000) + 1_000_000)})`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES (${ORG}, ${D1}, 'contractor')`;

  /* ============ 1) empty ledger → ok [] ============ */
  {
    const res = await listStripePayoutsCore({ orgId: ORG });
    check("empty: ok === true and []", res.ok === true && Array.isArray(res.data) && res.data.length === 0, JSON.stringify(res));
  }

  /* ============ 2) two rows return newest-first, seroval-safe ============ */
  {
    const older = `qa-sl-old-${TAG}`;
    const newer = `qa-sl-new-${TAG}`;
    // newer row inserted LAST but with an explicit later created_at (ORDER BY created_at DESC).
    await q`INSERT INTO stripe_payouts(id, org_id, contractor_id, stripe_account_id, amount_cents, kind, status, idempotency_key, stripe_transfer_id, failure_message, created_at) VALUES
      (${older}, ${ORG}, ${D1}, 'acct_qa_sl', 2500, 'instant_cashout', 'failed', 'k-old', NULL, 'mock decline', NOW() - INTERVAL '1 hour'),
      (${newer}, ${ORG}, ${D1}, 'acct_qa_sl', 18400, 'weekly_payout', 'succeeded', 'k-new', 'tr_qa_sl_1', NULL, NOW())`;

    const res = await listStripePayoutsCore({ orgId: ORG });
    check("rows: ok === true and 2 rows", res.ok === true && Array.isArray(res.data) && res.data.length === 2, JSON.stringify(res));
    if (res.ok) {
      const [first, second] = res.data;
      check("rows: newest-first (weekly_payout first)", first.kind === "weekly_payout" && second.kind === "instant_cashout", JSON.stringify([first.kind, second.kind]));
      check("rows: weekly amount/status/transfer id mapped", first.amountCents === 18400 && first.status === "succeeded" && first.stripeTransferId === "tr_qa_sl_1", JSON.stringify(first));
      check("rows: instant failure_message + null transfer id (null, not undefined)", second.amountCents === 2500 && second.status === "failed" && second.failureMessage === "mock decline" && second.stripeTransferId === null, JSON.stringify(second));
      check("rows: null-or-value fields never undefined", [first, second].every((p) => Object.values(p).every((v) => v !== undefined)), JSON.stringify([first, second]));
      check("rows: covered ids are arrays (default [])", Array.isArray(first.coveredTipIds) && Array.isArray(first.coveredPlugIds) && Array.isArray(second.coveredTipIds), JSON.stringify({ first, second }));
      check("rows: createdAt/updatedAt are ISO strings", !Number.isNaN(Date.parse(first.createdAt)) && !Number.isNaN(Date.parse(second.createdAt)), JSON.stringify({ first, second }));
    }
  }

  /* ============ 3) org scoping: another org sees nothing ============ */
  {
    const OTHER = `qa-stripe-ledger-other-${TAG}`;
    await q`INSERT INTO organizations(id, name) VALUES(${OTHER}, ${OTHER})`;
    const res = await listStripePayoutsCore({ orgId: OTHER });
    check("scope: other org → []", res.ok === true && res.data.length === 0, JSON.stringify(res));
    assertQaOrg(OTHER);
    await q`DELETE FROM organizations WHERE id=${OTHER}`;
  }
} finally {
  await cleanup();
}

/* ================================ summary + leftover ================================ */
failed = checks.filter(([, ok]) => !ok);
console.log(`stripe-payouts-ledger.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
  console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n"));
}
const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa-stripe-ledger-%') AS orgs,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE 'qa-stripe-ledger-%@lightning.test') AS users,
  (SELECT COUNT(*)::int FROM stripe_payouts sp JOIN organizations o ON o.id=sp.org_id WHERE o.name LIKE 'qa-stripe-ledger-%') AS payouts,
  (SELECT COUNT(*)::int FROM contractor_profiles cp JOIN organizations o ON o.id=cp.org_id WHERE o.name LIKE 'qa-stripe-ledger-%') AS profiles`;
const z = Object.values(leftover[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) {
  console.error("FAIL: QA cleanup left rows behind");
  process.exit(1);
}
console.log("stripe-payouts-ledger.test.mjs: cleanup verified — zero QA rows left");
process.exit(failed.length ? 1 : 0);
