// DB safety (2026-09-06): org deletes guarded by assertQaOrg — see
// src/data/db-guard.ts + /home/team/shared/db-safety-rules.md.
// Hermetic tests for SLICE 2b of automated payouts (owner-approved 2026-09-03):
// Stripe Connect WEEKLY AUTO-PAYOUT CORE (batch Transfers reusing the Slice 2a
// stripe_payouts ledger with kind='weekly_payout'). The Stripe client is MOCKED
// via dependency injection (opts.client / opts.env) — no real Stripe network.
// The money-move gate is OFF by default and fail-closed. Covers:
//   - gate returns payouts_not_enabled (no Stripe call) when disabled;
//   - fail-closed stripe_not_configured when the key is absent;
//   - per-contractor bank_not_linked / bank_not_ready skips (batch continues);
//   - success → ledger kind 'weekly_payout' + succeeded + stripe_transfer_id +
//     audit row + correct server-supplied amount;
//   - idempotency: re-running the same period fires NO second transfer and
//     returns the existing row's state;
//   - Stripe error → failed row + failure_message, no fake success;
//   - mixed batch (some linked, some not, some not-ready).
// DB-backed against a throwaway QA org deleted at the end (zero rows left).
//   DATABASE_URL=... bun stripe-payouts-weekly.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 9).toString("base64");
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_CONNECT_PAYOUTS_ENABLED;

const {
  runWeeklyPayoutCore,
  previewWeeklyPayoutsCore,
} = await import("./src/data/stripe-payouts-weekly-core.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");

const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

const TAG = randomUUID().slice(0, 8);
const ORG = `qa-stripe-weekly-${TAG}`;
const D1 = `qa-sw-d1-${TAG}`; // linked + ready → success
const D2 = `qa-sw-d2-${TAG}`; // linked + ready → success (idempotency / error)
const D3 = `qa-sw-d3-${TAG}`; // no profile → skippedNotLinked
const D4 = `qa-sw-d4-${TAG}`; // linked but payouts_enabled=false → skippedNotReady
const email = (u) => `${u}-${randomUUID()}@lightning.test`;
// actor_user_id must reference a real users.id (audit_log FK) — use D1.
const ACTOR = { orgId: ORG, actorUserId: D1, actorRole: "owner" };
const PERIOD = `qa-sw-period-${TAG}`;
const ENV_ON = { STRIPE_SECRET_KEY: "sk_test_hermetic", STRIPE_CONNECT_PAYOUTS_ENABLED: "true" };
const ENV_OFF = { STRIPE_SECRET_KEY: "sk_test_hermetic", STRIPE_CONNECT_PAYOUTS_ENABLED: "false" };

/* ------------------------- fake Stripe clients (injected) ------------------------- */
let transferCalls = 0;
const transfersByKey = new Map();
const fakeStripe = {
  transfers: {
    async create(params, opts) {
      transferCalls += 1;
      const key = (opts && opts.idempotencyKey) || "";
      transfersByKey.set(key, params);
      return { id: `tr_w_${transferCalls}` };
    },
  },
};
let errorTransferCalls = 0;
const errorStripe = {
  transfers: {
    async create() {
      errorTransferCalls += 1;
      throw new Error("mock Stripe weekly decline");
    },
  },
};

/* ------------------------------ cleanup (ALWAYS runs) ------------------------------ */
async function cleanup() {
  await q`DELETE FROM audit_log WHERE org_id=${ORG}`;
  await q`DELETE FROM stripe_payouts WHERE org_id=${ORG}`;
  await q`DELETE FROM contractor_profiles WHERE org_id=${ORG}`;
  await q`DELETE FROM organization_memberships WHERE org_id=${ORG}`;
  await q`DELETE FROM users WHERE id IN (${D1}, ${D2}, ${D3}, ${D4})`;
  assertQaOrg(ORG);
  await q`DELETE FROM organizations WHERE id=${ORG}`;
}

let failed = [];
try {
  await ensureSchema();
  await cleanup();
  await q`INSERT INTO organizations(id, name) VALUES(${ORG}, ${ORG})`;
  await q`INSERT INTO users(id, name, email, password_hash) VALUES
    (${D1}, 'QA SW Driver 1', ${email(D1)}, 'x'),
    (${D2}, 'QA SW Driver 2', ${email(D2)}, 'x'),
    (${D3}, 'QA SW Driver 3', ${email(D3)}, 'x'),
    (${D4}, 'QA SW Driver 4', ${email(D4)}, 'x')`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES
    (${ORG}, ${D1}, 'contractor'), (${ORG}, ${D2}, 'contractor'),
    (${ORG}, ${D3}, 'contractor'), (${ORG}, ${D4}, 'contractor')`;
  // D1 linked+ready; D2 linked+ready; D3 no profile; D4 linked but not ready.
  await q`INSERT INTO contractor_profiles(org_id, user_id, stripe_account_id, stripe_payouts_enabled) VALUES
    (${ORG}, ${D1}, 'acct_qa_sw1', TRUE),
    (${ORG}, ${D2}, 'acct_qa_sw2', TRUE),
    (${ORG}, ${D4}, 'acct_qa_sw4', FALSE)`;

  const records = [
    { contractorId: D1, amountCents: 18400 },
    { contractorId: D2, amountCents: 5200 },
    { contractorId: D3, amountCents: 3300 }, // not linked
    { contractorId: D4, amountCents: 9900 }, // not ready
  ];

  /* ============ 1) money-move gate OFF → payouts_not_enabled, no Stripe call ============ */
  {
    const before = transferCalls;
    const res = await runWeeklyPayoutCore(ACTOR, PERIOD, records, { client: fakeStripe, env: ENV_OFF });
    check("gate: disabled → payouts_not_enabled (structured, no throw)", res.ok === false && res.code === "payouts_not_enabled", JSON.stringify(res));
    check("gate: disabled → ZERO Stripe transfer calls", transferCalls === before, String(transferCalls));
  }

  /* ============ 2) fail-closed stripe_not_configured when key absent ============ */
  {
    const res = await runWeeklyPayoutCore(ACTOR, PERIOD, records, { env: { STRIPE_CONNECT_PAYOUTS_ENABLED: "true" } });
    check("config: no key → stripe_not_configured (structured, no throw)", res.ok === false && res.code === "stripe_not_configured", JSON.stringify(res));
  }

  /* ============ 3) mixed batch: 2 succeed, 1 not-linked, 1 not-ready ============ */
  {
    const res = await runWeeklyPayoutCore(ACTOR, PERIOD, records, { client: fakeStripe, env: ENV_ON });
    check("batch: ok === true", res.ok === true, JSON.stringify(res));
    if (res.ok) {
      check("batch: succeeded has D1 + D2", res.data.succeeded.length === 2
        && res.data.succeeded.some((s) => s.contractorId === D1)
        && res.data.succeeded.some((s) => s.contractorId === D2), JSON.stringify(res.data.succeeded));
      check("batch: skippedNotLinked has D3", res.data.skippedNotLinked.length === 1 && res.data.skippedNotLinked[0].contractorId === D3 && res.data.skippedNotLinked[0].code === "bank_not_linked", JSON.stringify(res.data.skippedNotLinked));
      check("batch: skippedNotReady has D4", res.data.skippedNotReady.length === 1 && res.data.skippedNotReady[0].contractorId === D4 && res.data.skippedNotReady[0].code === "bank_not_ready", JSON.stringify(res.data.skippedNotReady));
      check("batch: failed empty", res.data.failed.length === 0, JSON.stringify(res.data.failed));
      const d1 = res.data.succeeded.find((s) => s.contractorId === D1);
      const d2 = res.data.succeeded.find((s) => s.contractorId === D2);
      check("batch: D1 amount recorded $184.00", d1 && d1.amountCents === 18400, JSON.stringify(d1));
      check("batch: D2 amount recorded $52.00", d2 && d2.amountCents === 5200, JSON.stringify(d2));
      check("batch: D1 transfer id present", d1 && typeof d1.stripeTransferId === "string" && d1.stripeTransferId.startsWith("tr_w_"), JSON.stringify(d1));
      check("batch: exactly 2 Stripe transfers fired", transferCalls === 2, String(transferCalls));
    }
    const rows = await q`SELECT * FROM stripe_payouts WHERE org_id=${ORG} ORDER BY contractor_id`;
    check("ledger: 2 rows (D1, D2), all kind weekly_payout", rows.length === 2 && rows.every((r) => r.kind === "weekly_payout"), JSON.stringify(rows.map((r) => ({ c: r.contractor_id, k: r.kind, s: r.status, a: r.amount_cents }))));
    const d1row = rows.find((r) => r.contractor_id === D1);
    check("ledger: D1 succeeded + stripe_transfer_id", d1row && d1row.status === "succeeded" && String(d1row.stripe_transfer_id).startsWith("tr_w_"), JSON.stringify(d1row));
    const aud = await q`SELECT action FROM audit_log WHERE org_id=${ORG} AND entity_type='stripe_payout'`;
    check("audit: 2 succeeded transitions (one per row)", aud.filter((a) => a.action === "stripe_weekly_payout_succeeded").length === 2, JSON.stringify(aud));
  }

  /* ============ 4) idempotency: replay same period fires NO second transfer ============ */
  {
    const before = transferCalls;
    const res = await runWeeklyPayoutCore(ACTOR, PERIOD, records, { client: fakeStripe, env: ENV_ON });
    check("idem: replay ok", res.ok === true, JSON.stringify(res));
    if (res.ok) {
      check("idem: replay reports D1 + D2 as succeeded (existing rows)", res.data.succeeded.length === 2, JSON.stringify(res.data.succeeded));
      const d1 = res.data.succeeded.find((s) => s.contractorId === D1);
      check("idem: D1 reuses the existing transfer id", d1 && d1.stripeTransferId && d1.stripeTransferId.startsWith("tr_w_"), JSON.stringify(d1));
    }
    check("idem: NO additional Stripe transfer fired", transferCalls === before, `before=${before} after=${transferCalls}`);
    const rows = await q`SELECT COUNT(*)::int AS c FROM stripe_payouts WHERE org_id=${ORG}`;
    check("idem: still exactly 2 ledger rows", Number(rows[0].c) === 2, JSON.stringify(rows));
  }

  /* ============ 5) Stripe error → failed row, no fake success ============ */
  {
    // A NEW period for D2 with the erroring client.
    const beforeError = errorTransferCalls;
    const res = await runWeeklyPayoutCore(ACTOR, `qa-sw-period2-${TAG}`, [{ contractorId: D2, amountCents: 5200 }], { client: errorStripe, env: ENV_ON });
    check("error: batch ok === true (structured, no throw)", res.ok === true, JSON.stringify(res));
    if (res.ok) {
      check("error: failed has D2", res.data.failed.length === 1 && res.data.failed[0].contractorId === D2 && res.data.failed[0].code === "stripe_error", JSON.stringify(res.data.failed));
      check("error: succeeded empty", res.data.succeeded.length === 0, JSON.stringify(res.data.succeeded));
    }
    check("error: Stripe called exactly once", errorTransferCalls - beforeError === 1, String(errorTransferCalls));
    const row = await q`SELECT * FROM stripe_payouts WHERE org_id=${ORG} AND contractor_id=${D2} AND kind='weekly_payout' ORDER BY created_at DESC LIMIT 1`;
    check("error: ledger row status failed + failure_message", row.length === 1 && row[0].status === "failed" && String(row[0].failure_message).includes("decline"), JSON.stringify(row));
    const aud = await q`SELECT action FROM audit_log WHERE org_id=${ORG} AND entity_id=${row[0].id}`;
    check("error: audit stripe_weekly_payout_failed present", aud.some((a) => a.action === "stripe_weekly_payout_failed"), JSON.stringify(aud));

    // Replay of the SAME failed period must NOT re-fire Stripe.
    const replay = await runWeeklyPayoutCore(ACTOR, `qa-sw-period2-${TAG}`, [{ contractorId: D2, amountCents: 5200 }], { client: errorStripe, env: ENV_ON });
    check("error: replay returns existing failed row WITHOUT re-firing", replay.ok === true
      && replay.data.failed.length === 1 && replay.data.failed[0].code === "stripe_error"
      && errorTransferCalls - beforeError === 1, JSON.stringify(replay));
  }

  /* ============ 6) read-only preview (never a money move) ============ */
  {
    const before = transferCalls;
    const res = await previewWeeklyPayoutsCore(ORG, records);
    check("preview: ok", res.ok === true, JSON.stringify(res));
    if (res.ok) {
      check("preview: linked has D1 + D2", res.data.linked.length === 2
        && res.data.linked.some((i) => i.contractorId === D1)
        && res.data.linked.some((i) => i.contractorId === D2), JSON.stringify(res.data.linked));
      check("preview: notLinked has D3", res.data.notLinked.length === 1 && res.data.notLinked[0].contractorId === D3, JSON.stringify(res.data.notLinked));
      check("preview: notReady has D4", res.data.notReady.length === 1 && res.data.notReady[0].contractorId === D4, JSON.stringify(res.data.notReady));
      check("preview: linked amounts are server-supplied", res.data.linked.some((i) => i.contractorId === D1 && i.amountCents === 18400), JSON.stringify(res.data.linked));
    }
    check("preview: ZERO Stripe calls", transferCalls === before, String(transferCalls));
  }
} finally {
  await cleanup();
}

/* ================================ summary + leftover ================================ */
failed = checks.filter(([, ok]) => !ok);
console.log(`stripe-payouts-weekly.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
  console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n"));
}
const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa-stripe-weekly-%') AS orgs,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE 'qa-stripe-weekly-%@lightning.test') AS users,
  (SELECT COUNT(*)::int FROM stripe_payouts sp JOIN organizations o ON o.id=sp.org_id WHERE o.name LIKE 'qa-stripe-weekly-%') AS payouts,
  (SELECT COUNT(*)::int FROM contractor_profiles cp JOIN organizations o ON o.id=cp.org_id WHERE o.name LIKE 'qa-stripe-weekly-%') AS profiles,
  (SELECT COUNT(*)::int FROM audit_log a JOIN organizations o ON o.id=a.org_id WHERE o.name LIKE 'qa-stripe-weekly-%') AS audit`;
const z = Object.values(leftover[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) {
  console.error("FAIL: QA cleanup left rows behind");
  process.exit(1);
}
console.log("stripe-payouts-weekly.test.mjs: cleanup verified — zero QA rows left");
process.exit(failed.length ? 1 : 0);
