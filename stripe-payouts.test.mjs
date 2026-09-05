// DB safety (2026-09-06): org deletes guarded by assertQaOrg — see
// src/data/db-guard.ts + /home/team/shared/db-safety-rules.md.
// Hermetic tests for SLICE 2a of automated payouts (owner-approved 2026-09-03):
// Stripe Connect INSTANT CASH-OUT CORE + immutable stripe_payouts ledger. The
// Stripe client is MOCKED via dependency injection (opts.client / opts.env) — no
// real Stripe network. The money-move gate is OFF by default and fail-closed.
// Covers:
//   - gate returns payouts_not_enabled (no Stripe call) when disabled, even with
//     a key + injected client present;
//   - fail-closed stripe_not_configured when the key is absent;
//   - bank_not_linked / bank_not_ready when no stripe_account_id / payouts off;
//   - amount is server-authoritative and matches the seeded eligible pool;
//   - successful transfer → ledger 'succeeded' + stripe_transfer_id + audit row +
//     covered tip/plug ids + availableTipsCore excludes them (no double-cover);
//   - idempotency: a duplicate logical attempt does NOT fire a second transfer;
//   - Stripe error → ledger 'failed' + failure_message, no fake success.
// DB-backed against a throwaway QA org deleted at the end (zero rows left).
//   DATABASE_URL=... bun stripe-payouts.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 9).toString("base64");
// Ensure the key is absent for the fail-closed test AND never inherited from the
// host (deterministic).
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_CONNECT_PAYOUTS_ENABLED;

const {
  computeInstantCashoutAmountCore,
  requestInstantCashoutCore,
  getInstantCashoutStatusCore,
} = await import("./src/data/stripe-payouts-core.ts");
const { availableTipsCore } = await import("./src/data/tip-cashout-core.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");

const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

const TAG = randomUUID().slice(0, 8);
const ORG = `qa-stripe-payouts-${TAG}`;
const D1 = `qa-sp-d1-${TAG}`; // main driver — success path
const D2 = `qa-sp-d2-${TAG}`; // second driver — error / idempotency path
const email = (u) => `${u}-${randomUUID()}@lightning.test`;
const tb = (seed) => String(([...seed].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 899_000_000) + 1_000_000);
const TB1 = tb(D1), TB2 = tb(D2);
const ACTOR1 = { orgId: ORG, contractorId: D1, actorUserId: D1, actorRole: "contractor" };
const ACTOR2 = { orgId: ORG, contractorId: D2, actorUserId: D2, actorRole: "contractor" };
const ENV_ON = { STRIPE_SECRET_KEY: "sk_test_hermetic", STRIPE_CONNECT_PAYOUTS_ENABLED: "true" };
const ENV_OFF = { STRIPE_SECRET_KEY: "sk_test_hermetic", STRIPE_CONNECT_PAYOUTS_ENABLED: "false" };

/* ------------------------- fake Stripe clients (injected) ------------------------- */
let transferCalls = 0;
const fakeStripe = {
  transfers: {
    async create(params) {
      transferCalls += 1;
      return { id: `tr_qa_${transferCalls}` };
    },
  },
};
let errorTransferCalls = 0;
const errorStripe = {
  transfers: {
    async create() {
      errorTransferCalls += 1;
      throw new Error("mock Stripe decline");
    },
  },
};

/* ------------------------------ cleanup (ALWAYS runs) ------------------------------ */
async function cleanup() {
  await q`DELETE FROM audit_log WHERE org_id=${ORG}`;
  await q`DELETE FROM stripe_payouts WHERE org_id=${ORG}`;
  await q`DELETE FROM completion_tips WHERE org_id=${ORG}`;
  await q`DELETE FROM tire_plug_transactions WHERE org_id=${ORG}`;
  await q`DELETE FROM dispatch_jobs WHERE org_id=${ORG}`;
  await q`DELETE FROM contractor_profiles WHERE org_id=${ORG}`;
  await q`DELETE FROM organization_memberships WHERE org_id=${ORG}`;
  await q`DELETE FROM users WHERE id IN (${D1}, ${D2})`;
  assertQaOrg(ORG);
  await q`DELETE FROM organizations WHERE id=${ORG}`;
}

let failed = [];
try {
  await ensureSchema();
  await cleanup();
  await q`INSERT INTO organizations(id, name) VALUES(${ORG}, ${ORG})`;
  await q`INSERT INTO users(id, name, email, password_hash, towbook_driver_id) VALUES
    (${D1}, 'QA SP Driver 1', ${email(D1)}, 'x', ${TB1}),
    (${D2}, 'QA SP Driver 2', ${email(D2)}, 'x', ${TB2})`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES
    (${ORG}, ${D1}, 'contractor'), (${ORG}, ${D2}, 'contractor')`;
  const J1 = `qa-sp-j1-${TAG}`, J2 = `qa-sp-j2-${TAG}`;
  await q`INSERT INTO dispatch_jobs(id, org_id, towbook_job_id, customer_name, phone, lat, lng, area, service_type, status, created_at) VALUES
    (${J1}, ${ORG}, ${"sp001"}, ${"C1"}, ${"9145550101"}, 41.1, -73.5, ${"CT"}, ${"Tire"}, 'completed', NOW()),
    (${J2}, ${ORG}, ${"sp002"}, ${"C2"}, ${"9145550102"}, 41.1, -73.5, ${"CT"}, ${"Jump"}, 'completed', NOW())`;
  // D1 eligible pool: two tips ($25 + $10) + one tire plug ($15) = $50.00.
  const T1 = `qa-sp-t1-${TAG}`, T2 = `qa-sp-t2-${TAG}`, P1 = `qa-sp-p1-${TAG}`;
  await q`INSERT INTO completion_tips(id, org_id, job_id, driver_id, driver_towbook_id, amount_cents, currency, status, idempotency_key, created_at) VALUES
    (${T1}, ${ORG}, ${J1}, ${D1}, ${TB1}, 2500, 'USD', 'paid', ${`sp-${TAG}-t1`}, NOW()),
    (${T2}, ${ORG}, ${J1}, ${D1}, ${TB1}, 1000, 'USD', 'paid', ${`sp-${TAG}-t2`}, NOW())`;
  await q`INSERT INTO tire_plug_transactions(id, org_id, job_id, contractor_user_id, amount_cents, status, created_at, paid_at) VALUES
    (${P1}, ${ORG}, ${J2}, ${D1}, 1500, 'paid', NOW(), NOW())`;

  /* ============ 0) server-authoritative eligible amount ============ */
  {
    const avail = await availableTipsCore(ORG, D1);
    check("pool: available = $50.00 (tips $25+$10 + plug $15), count 3", avail.totalCents === 5000 && avail.tipCount === 3, JSON.stringify(avail));
    const amt = await computeInstantCashoutAmountCore(ORG, D1);
    check("amount: server-computed $50.00 + exact covered ids", amt.ok && amt.data.totalCents === 5000
      && amt.data.coveredTipIds.length === 2 && amt.data.coveredTipIds.includes(T1) && amt.data.coveredTipIds.includes(T2)
      && amt.data.coveredPlugIds.length === 1 && amt.data.coveredPlugIds[0] === P1, JSON.stringify(amt));
  }

  /* ============ 1) money-move gate OFF → payouts_not_enabled, no Stripe call ============ */
  {
    await q`INSERT INTO contractor_profiles(org_id, user_id, stripe_account_id, stripe_payouts_enabled) VALUES
      (${ORG}, ${D1}, 'acct_qa_1', TRUE) ON CONFLICT (org_id, user_id) DO UPDATE SET stripe_account_id='acct_qa_1', stripe_payouts_enabled=TRUE`;
    const before = transferCalls;
    const res = await requestInstantCashoutCore(ACTOR1, { client: fakeStripe, env: ENV_OFF });
    check("gate: disabled → payouts_not_enabled (structured, no throw)", res.ok === false && res.code === "payouts_not_enabled" && res.message === "Automated payouts are not enabled.", JSON.stringify(res));
    check("gate: disabled → ZERO Stripe transfer calls", transferCalls === before, String(transferCalls));
    // case-insensitive trim " TRUE " must enable it (exact "true" after trim)
    const res2 = await requestInstantCashoutCore(ACTOR1, { client: fakeStripe, env: { STRIPE_SECRET_KEY: "sk_x", STRIPE_CONNECT_PAYOUTS_ENABLED: " TRUE " } });
    check("gate: ' TRUE ' (trim + case) enables the transfer", res2.ok === true, JSON.stringify(res2));
    const rows = await q`SELECT status FROM stripe_payouts WHERE org_id=${ORG} AND contractor_id=${D1} ORDER BY created_at DESC LIMIT 1`;
    check("gate: enabled call succeeded and left a row", rows.length === 1 && rows[0].status === "succeeded", JSON.stringify(rows));
  }

  /* ============ 2) fail-closed stripe_not_configured when key absent ============ */
  {
    await q`INSERT INTO contractor_profiles(org_id, user_id, stripe_account_id, stripe_payouts_enabled) VALUES
      (${ORG}, ${D2}, 'acct_qa_2', TRUE) ON CONFLICT (org_id, user_id) DO UPDATE SET stripe_account_id='acct_qa_2', stripe_payouts_enabled=TRUE`;
    await q`INSERT INTO completion_tips(id, org_id, job_id, driver_id, driver_towbook_id, amount_cents, currency, status, idempotency_key, created_at) VALUES
      (${`qa-sp-td2-${TAG}`}, ${ORG}, ${J2}, ${D2}, ${TB2}, 900, 'USD', 'paid', ${`sp-${TAG}-td2`}, NOW())`;
    const res = await requestInstantCashoutCore(ACTOR2, { env: { STRIPE_CONNECT_PAYOUTS_ENABLED: "true" } });
    check("config: no key → stripe_not_configured (structured, no throw)", res.ok === false && res.code === "stripe_not_configured", JSON.stringify(res));
  }

  /* ============ 3) bank not linked / not ready ============ */
  {
    await q`DELETE FROM contractor_profiles WHERE org_id=${ORG} AND user_id=${D2}`;
    const notLinked = await requestInstantCashoutCore(ACTOR2, { client: fakeStripe, env: ENV_ON });
    check("bank: no stripe_account_id → bank_not_linked", notLinked.ok === false && notLinked.code === "bank_not_linked", JSON.stringify(notLinked));
    await q`INSERT INTO contractor_profiles(org_id, user_id, stripe_account_id, stripe_payouts_enabled) VALUES
      (${ORG}, ${D2}, 'acct_qa_2', FALSE) ON CONFLICT (org_id, user_id) DO UPDATE SET stripe_account_id='acct_qa_2', stripe_payouts_enabled=FALSE`;
    const notReady = await requestInstantCashoutCore(ACTOR2, { client: fakeStripe, env: ENV_ON });
    check("bank: payouts_enabled=false → bank_not_ready", notReady.ok === false && notReady.code === "bank_not_ready", JSON.stringify(notReady));
  }

  /* ============ 4) successful transfer → succeeded + coverage + exclusion ============ */
  {
    const row = await q`SELECT * FROM stripe_payouts WHERE org_id=${ORG} AND contractor_id=${D1} ORDER BY created_at DESC LIMIT 1`;
    check("success: row status succeeded + stripe_transfer_id", row.length === 1 && row[0].status === "succeeded" && String(row[0].stripe_transfer_id).startsWith("tr_qa_"), JSON.stringify(row));
    check("success: amount $50.00 recorded", Number(row[0].amount_cents) === 5000, JSON.stringify(row));
    const coveredTips = Array.isArray(row[0].covered_tip_ids) ? row[0].covered_tip_ids : JSON.parse(row[0].covered_tip_ids);
    const coveredPlugs = Array.isArray(row[0].covered_tire_plug_ids) ? row[0].covered_tire_plug_ids : JSON.parse(row[0].covered_tire_plug_ids);
    check("success: covered_tip_ids snapshot T1+T2", coveredTips.length === 2 && coveredTips.includes(T1) && coveredTips.includes(T2), JSON.stringify(coveredTips));
    check("success: covered_tire_plug_ids snapshot P1", coveredPlugs.length === 1 && coveredPlugs[0] === P1, JSON.stringify(coveredPlugs));
    const aud = await q`SELECT action FROM audit_log WHERE org_id=${ORG} AND entity_type='stripe_payout' AND entity_id=${row[0].id}`;
    check("success: audit_log stripe_payout_succeeded present", aud.some((a) => a.action === "stripe_payout_succeeded"), JSON.stringify(aud));
    const after = await availableTipsCore(ORG, D1);
    check("coverage: availableTipsCore excludes covered rows (now $0)", after.totalCents === 0 && after.tipCount === 0, JSON.stringify(after));
  }

  /* ============ 5) idempotency: duplicate attempt does NOT double-transfer ============ */
  {
    await q`UPDATE contractor_profiles SET stripe_payouts_enabled=TRUE WHERE org_id=${ORG} AND user_id=${D2}`;
    const beforeCalls = transferCalls;
    const [r1, r2] = await Promise.all([
      requestInstantCashoutCore(ACTOR2, { client: fakeStripe, env: ENV_ON }),
      requestInstantCashoutCore(ACTOR2, { client: fakeStripe, env: ENV_ON }),
    ]);
    const rows = await q`SELECT * FROM stripe_payouts WHERE org_id=${ORG} AND contractor_id=${D2}`;
    check("idem: exactly ONE ledger row created for D2", rows.length === 1, JSON.stringify(rows));
    check("idem: ONE Stripe transfer fired for the pair", transferCalls - beforeCalls === 1, `before=${beforeCalls} after=${transferCalls}`);
    check("idem: at least one call succeeded", r1.ok === true || r2.ok === true, JSON.stringify({ r1, r2 }));
    // A concurrent retry may legitimately return the existing row's state (both
    // ok with the SAME id), or a structured non-move error — never a second row.
    const bothOkSameId = r1.ok === true && r2.ok === true && r1.data.id === r2.data.id;
    const oneErrOneOk = (r1.ok === true) !== (r2.ok === true);
    check("idem: duplicate is a no-op (same id or structured non-move)", bothOkSameId || oneErrOneOk, JSON.stringify({ r1, r2 }));
    check("idem: row reached succeeded", rows[0].status === "succeeded", JSON.stringify(rows));
  }

  /* ============ 6) Stripe error → failed row, no fake success ============ */
  {
    await q`INSERT INTO completion_tips(id, org_id, job_id, driver_id, driver_towbook_id, amount_cents, currency, status, idempotency_key, created_at) VALUES
      (${`qa-sp-td2b-${TAG}`}, ${ORG}, ${J2}, ${D2}, ${TB2}, 1200, 'USD', 'paid', ${`sp-${TAG}-td2b`}, NOW())`;
    const beforeError = errorTransferCalls;
    const res = await requestInstantCashoutCore(ACTOR2, { client: errorStripe, env: ENV_ON });
    check("error: returns stripe_error (structured, no throw)", res.ok === false && res.code === "stripe_error", JSON.stringify(res));
    const row = await q`SELECT * FROM stripe_payouts WHERE org_id=${ORG} AND contractor_id=${D2} ORDER BY created_at DESC LIMIT 1`;
    check("error: ledger row status failed + failure_message", row.length === 1 && row[0].status === "failed" && String(row[0].failure_message).includes("decline"), JSON.stringify(row));
    check("error: Stripe was called exactly once", errorTransferCalls - beforeError === 1, String(errorTransferCalls));
    // A retry of the SAME logical key must NOT re-fire Stripe — returns the
    // existing failed row (coverage released → same amount/covered set).
    const retry = await requestInstantCashoutCore(ACTOR2, { client: errorStripe, env: ENV_ON });
    check("error: retry returns existing failed row WITHOUT re-firing Stripe", retry.ok === true && retry.data.status === "failed" && errorTransferCalls - beforeError === 1, JSON.stringify(retry));
    const aud = await q`SELECT action FROM audit_log WHERE org_id=${ORG} AND entity_id=${row[0].id}`;
    check("error: audit_log stripe_payout_failed present", aud.some((a) => a.action === "stripe_payout_failed"), JSON.stringify(aud));
  }

  /* ============ 7) read-only status (never a money move) ============ */
  {
    const st = await getInstantCashoutStatusCore(ACTOR1);
    check("status: read-only — linked, payoutsEnabled, eligible $0 (consumed), lastPayout succeeded", st.ok === true
      && st.data.linked === true && st.data.payoutsEnabled === true && st.data.eligibleTotalCents === 0
      && st.data.lastPayout != null && st.data.lastPayout.status === "succeeded", JSON.stringify(st));
    const st2 = await getInstantCashoutStatusCore(ACTOR2);
    check("status: D2 eligible $12.00 (failed row released its coverage)", st2.ok === true && st2.data.eligibleTotalCents === 1200, JSON.stringify(st2));
  }
} finally {
  await cleanup();
}

/* ================================ summary + leftover ================================ */
failed = checks.filter(([, ok]) => !ok);
console.log(`stripe-payouts.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
  console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n"));
}
const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa-stripe-payouts-%') AS orgs,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE 'qa-stripe-payouts-%@lightning.test') AS users,
  (SELECT COUNT(*)::int FROM stripe_payouts sp JOIN organizations o ON o.id=sp.org_id WHERE o.name LIKE 'qa-stripe-payouts-%') AS payouts,
  (SELECT COUNT(*)::int FROM completion_tips ct JOIN organizations o ON o.id=ct.org_id WHERE o.name LIKE 'qa-stripe-payouts-%') AS tips,
  (SELECT COUNT(*)::int FROM tire_plug_transactions t JOIN organizations o ON o.id=t.org_id WHERE o.name LIKE 'qa-stripe-payouts-%') AS plugs,
  (SELECT COUNT(*)::int FROM contractor_profiles cp JOIN organizations o ON o.id=cp.org_id WHERE o.name LIKE 'qa-stripe-payouts-%') AS profiles,
  (SELECT COUNT(*)::int FROM audit_log a JOIN organizations o ON o.id=a.org_id WHERE o.name LIKE 'qa-stripe-payouts-%') AS audit`;
const z = Object.values(leftover[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) {
  console.error("FAIL: QA cleanup left rows behind");
  process.exit(1);
}
console.log("stripe-payouts.test.mjs: cleanup verified — zero QA rows left");
process.exit(failed.length ? 1 : 0);
