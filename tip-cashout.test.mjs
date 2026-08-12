// DB safety (2026-08-12): org deletes guarded by assertQaOrg — see src/data/db-guard.ts.
// Hermetic tests for IMMEDIATE TIP CASH-OUT + MANUAL BANK PAYOUT RAIL
// (owner-directed 2026-08-12, Plaid DROPPED, $0 fees, no automated money
// movement). Covers: ONE-TAP request submit (server-computed available tips =
// paid completion_tips minus every cash-out, verified-rail gate), double-submit
// protection (partial unique index = one open request per contractor),
// owner mark-paid idempotency, payday manifest EXCLUSION of paid cash-outs
// (a cashed-out tip never appears again; a REQUESTED-but-unpaid cash-out stays
// in the manifest), bank micro-deposit verification state machine (owner
// records the test deposit → contractor confirms the amount → verified; owner
// direct-verify also allowed), sensitive-number handling (routing/account
// stored encrypted under bank.key — never plaintext, never in audit text,
// full numbers owner-only, masked everywhere else), role gates (driver submit
// only; owner/admin mark paid), audit rows on every transition, and zero QA
// rows after (orgs/users/jobs/tips/cashouts/audit = 0).
//   DATABASE_URL=... bun tip-cashout.test.mjs
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
if (!process.env.DATABASE_URL) {
  try {
    const pid = execSync("pgrep -f 'bun run serve.ts' | head -1").toString().trim();
    if (pid) {
      const env = await readFile(`/proc/${pid}/environ`, "utf8");
      const hit = env.split("\0").find((e) => e.startsWith("DATABASE_URL="));
      if (hit) process.env.DATABASE_URL = hit.slice("DATABASE_URL=".length);
    }
  } catch { /* tests then fail fast with a clear neon error */ }
}
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
const {
  getMyTipCashoutStateCore, submitTipCashoutCore, listTipCashoutRequestsCore,
  markTipCashoutPaidCore, availableTipsCore,
} = await import("./src/data/tip-cashout-core.ts");
const {
  setMyPayoutMethodCore, getMyPayoutMethodCore, listPayoutMethodsCore,
  getContractorPayoutMethodCore, verifyPayoutMethodCore, setBankDepositCore,
  confirmBankDepositCore, computePaydayCore, periodBoundariesFor,
} = await import("./src/data/payouts-core.ts");
const { encryptBankValue, decryptBankValue } = await import("./src/data/bank-key.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
await ensureSchema();
const checks = [];
const check = (name, cond, extra = "") => { checks.push([name, Boolean(cond), extra]); if (!cond) throw new Error(`FAIL: ${name} ${extra}`); };
const TAG = randomUUID().slice(0, 8);
const ORG = `qa-cashout-${TAG}`;
const ORG2 = `qa-cashout2-${TAG}`;
const OWNER = `qa-co-owner-${TAG}`;
const ADMIN = `qa-co-admin-${TAG}`;
const D1 = `qa-co-d1-${TAG}`;      // venmo VERIFIED — main cash-out driver
const D2 = `qa-co-d2-${TAG}`;      // bank UNVERIFIED — rail gate + micro-deposit
const D3 = `qa-co-d3-${TAG}`;      // NO method — rail gate
const D4 = `qa-co-d4-${TAG}`;      // cash_app VERIFIED — partial payday exclusion
const OTHER = `qa-co-other-${TAG}`; // ORG2 owner
const tb = (seed) => String(([...seed].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 899_000_000) + 1_000_000);
const TB1 = tb(D1), TB2 = tb(D2), TB3 = tb(D3), TB4 = tb(D4);
const ACTOR = { orgId: ORG, id: OWNER, role: "owner" };
const ADMIN_ACTOR = { orgId: ORG, id: ADMIN, role: "admin" };
const D1_ACTOR = { orgId: ORG, id: D1, role: "contractor" };
const D2_ACTOR = { orgId: ORG, id: D2, role: "contractor" };
const OTHER_ACTOR = { orgId: ORG2, id: OTHER, role: "owner" };
const iso = (d) => new Date(d).toISOString();
const ROUTING = "021000021";
const ACCOUNT = "987654321012";
/* ---- cleanup (guarded, ALWAYS runs) ---- */
const cleanup = async () => {
  await q`DELETE FROM audit_log WHERE org_id IN (${ORG}, ${ORG2}) OR actor_user_id IN (${OWNER}, ${ADMIN}, ${D1}, ${D2}, ${D3}, ${D4}, ${OTHER})`;
  await q`DELETE FROM tip_cashouts WHERE org_id IN (${ORG}, ${ORG2})`;
  await q`DELETE FROM payout_records WHERE org_id IN (${ORG}, ${ORG2})`;
  await q`DELETE FROM pay_periods WHERE org_id IN (${ORG}, ${ORG2})`;
  await q`DELETE FROM payment_transactions WHERE org_id IN (${ORG}, ${ORG2})`;
  await q`DELETE FROM completion_tips WHERE org_id IN (${ORG}, ${ORG2})`;
  await q`DELETE FROM status_events WHERE org_id IN (${ORG}, ${ORG2})`;
  await q`DELETE FROM job_completions WHERE org_id IN (${ORG}, ${ORG2})`;
  await q`DELETE FROM dispatch_jobs WHERE org_id IN (${ORG}, ${ORG2})`;
  await q`DELETE FROM payout_methods WHERE org_id IN (${ORG}, ${ORG2})`;
  await q`DELETE FROM contractor_profiles WHERE org_id IN (${ORG}, ${ORG2})`;
  await q`DELETE FROM organization_memberships WHERE org_id IN (${ORG}, ${ORG2})`;
  await q`DELETE FROM users WHERE id IN (${OWNER}, ${ADMIN}, ${D1}, ${D2}, ${D3}, ${D4}, ${OTHER})`;
  assertQaOrg(ORG); assertQaOrg(ORG2);
  await q`DELETE FROM organizations WHERE id IN (${ORG}, ${ORG2})`;
};
try {
/* ------------------------- fixtures ------------------------- */
await q`INSERT INTO organizations(id, name) VALUES(${ORG}, ${"qa tip cashout"}), (${ORG2}, ${"qa tip cashout 2"})`;
await q`INSERT INTO users(id, name, email, password_hash, towbook_driver_id) VALUES
  (${OWNER}, ${"QA Owner"}, ${`${OWNER}@qa.local`}, ${"x"}, NULL),
  (${ADMIN}, ${"QA Admin"}, ${`${ADMIN}@qa.local`}, ${"x"}, NULL),
  (${D1}, ${"Jane Cash"}, ${`${D1}@qa.local`}, ${"x"}, ${TB1}),
  (${D2}, ${"Pat Bank"}, ${`${D2}@qa.local`}, ${"x"}, ${TB2}),
  (${D3}, ${"Sam NoMethod"}, ${`${D3}@qa.local`}, ${"x"}, ${TB3}),
  (${D4}, ${"Alex App"}, ${`${D4}@qa.local`}, ${"x"}, ${TB4}),
  (${OTHER}, ${"QA Other"}, ${`${OTHER}@qa.local`}, ${"x"}, NULL)`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES
  (${ORG}, ${OWNER}, 'owner'), (${ORG}, ${ADMIN}, 'admin'),
  (${ORG}, ${D1}, 'contractor'), (${ORG}, ${D2}, 'contractor'), (${ORG}, ${D3}, 'contractor'), (${ORG}, ${D4}, 'contractor'),
  (${ORG2}, ${OTHER}, 'owner')`;
await q`INSERT INTO contractor_profiles(org_id, user_id, payrate_cents) VALUES
  (${ORG}, ${D1}, 10000), (${ORG}, ${D2}, 15000), (${ORG}, ${D4}, 5000)`;
// Methods: D1 venmo VERIFIED, D2 bank UNVERIFIED (full encrypted numbers),
// D4 cash_app VERIFIED. D3 none.
const M1 = `pm-co-${TAG}-1`, M2 = `pm-co-${TAG}-2`, M4 = `pm-co-${TAG}-4`;
await q`INSERT INTO payout_methods(id, org_id, contractor_id, rail, handle, bank_institution_name, bank_last4, bank_routing_encrypted, bank_account_encrypted, status, is_default, created_at, updated_at) VALUES
  (${M1}, ${ORG}, ${D1}, 'venmo', ${"@jane"}, NULL, NULL, NULL, NULL, 'verified', TRUE, NOW(), NOW()),
  (${M2}, ${ORG}, ${D2}, 'bank', NULL, ${"Chase"}, ${"4321"}, ${await encryptBankValue(ROUTING)}, ${await encryptBankValue(ACCOUNT)}, 'connected_unverified', TRUE, NOW(), NOW()),
  (${M4}, ${ORG}, ${D4}, 'cash_app', ${"$alex"}, NULL, NULL, NULL, NULL, 'verified', TRUE, NOW(), NOW())`;
// closed pay period (last week) + completed jobs + paid tips
const closed = periodBoundariesFor(new Date(Date.now() - 8 * 86400000));
const PERIOD = `pay-${ORG}-closed`;
await q`INSERT INTO pay_periods(id, org_id, starts_at, ends_at, payout_due_on, status) VALUES
  (${PERIOD}, ${ORG}, ${iso(closed.startsAt)}, ${iso(closed.endsAt)}, ${closed.payoutDueOn}, 'open')`;
const J1 = `qa-co-j1-${TAG}`, J2 = `qa-co-j2-${TAG}`, J4 = `qa-co-j4-${TAG}`;
await q`INSERT INTO dispatch_jobs(id, org_id, towbook_job_id, customer_name, phone, lat, lng, area, service_type, status, created_at, completed_at, assigned_driver_towbook_id) VALUES
  (${J1}, ${ORG}, ${"cash001"}, ${"C1"}, ${"9145550101"}, 41.1, -73.5, ${"CT"}, ${"Tire"}, 'completed', ${iso(new Date(closed.startsAt.getTime() + 3600e3))}, ${iso(new Date(closed.startsAt.getTime() + 3600e3))}, ${TB1}),
  (${J2}, ${ORG}, ${"cash002"}, ${"C2"}, ${"9145550102"}, 41.1, -73.5, ${"CT"}, ${"Jump"}, 'completed', ${iso(new Date(closed.startsAt.getTime() + 7200e3))}, ${iso(new Date(closed.startsAt.getTime() + 7200e3))}, ${TB1}),
  (${J4}, ${ORG}, ${"cash003"}, ${"C4"}, ${"9145550104"}, 41.1, -73.5, ${"CT"}, ${"Lock"}, 'completed', ${iso(new Date(closed.startsAt.getTime() + 8600e3))}, ${iso(new Date(closed.startsAt.getTime() + 8600e3))}, ${TB4})`;
// D1: ONE tip $25 in window (cashed out later → excluded from payday).
// D2: tip $30 in window (bank unverified → cash-out REFUSED, tip stays in payday).
// D4: tip A $8 in window (early) then tip B $10 in window (later, after A's cash-out).
const T1 = `qa-co-t1-${TAG}`, T2A = `qa-co-t2a-${TAG}`, T2B = `qa-co-t2b-${TAG}`, T4A = `qa-co-t4a-${TAG}`, T4B = `qa-co-t4b-${TAG}`;
await q`INSERT INTO completion_tips(id, org_id, job_id, driver_id, driver_towbook_id, amount_cents, currency, status, idempotency_key, created_at) VALUES
  (${T1}, ${ORG}, ${J1}, ${D1}, ${TB1}, 2500, 'USD', 'paid', ${`tip-co-${TAG}-1`}, ${iso(new Date(closed.startsAt.getTime() + 5000e3))}),
  (${T2A}, ${ORG}, ${J2}, ${D2}, ${TB2}, 3000, 'USD', 'paid', ${`tip-co-${TAG}-2a`}, ${iso(new Date(closed.startsAt.getTime() + 5500e3))}),
  (${T4A}, ${ORG}, ${J4}, ${D4}, ${TB4}, 800, 'USD', 'paid', ${`tip-co-${TAG}-4a`}, ${iso(new Date(closed.startsAt.getTime() + 6000e3))})`;

/* ------------------------- driver state + submit ------------------------- */
let req1;
{
  const st = await getMyTipCashoutStateCore({ orgId: ORG, id: D1 });
  check("state: D1 available = $25 paid tip, method verified", st.ok && st.data.availableCents === 2500 && st.data.availableTipCount === 1 && st.data.methodVerified === true && st.data.method.rail === "venmo", JSON.stringify(st));
  const res = await submitTipCashoutCore({ orgId: ORG, id: D1, actorUserId: D1, actorRole: "contractor" });
  req1 = res.ok ? res.data : null;
  check("submit: ok, amount = full available $25, rail venmo", res.ok && req1.amountCents === 2500 && req1.rail === "venmo" && req1.status === "requested" && req1.contractorId === D1, JSON.stringify(res));
  check("submit: masked handle snapshot (never full)", res.ok && req1.handleMasked !== "@jane" && req1.handleMasked.includes("••"), JSON.stringify(req1));
  const covered = await q`SELECT covered_tip_ids::text AS c FROM tip_cashouts WHERE id=${req1.id}`;
  check("submit: covered_tip_ids snapshots EXACTLY the $25 tip row", covered.length === 1 && JSON.parse(covered[0].c).length === 1 && JSON.parse(covered[0].c)[0] === T1, JSON.stringify(covered));
  const st2 = await getMyTipCashoutStateCore({ orgId: ORG, id: D1 });
  check("state: after submit available = 0 (tips reserved), openRequest set", st2.ok && st2.data.availableCents === 0 && st2.data.openRequest != null && st2.data.openRequest.amountCents === 2500, JSON.stringify(st2));
  const aud = await q`SELECT action, detail FROM audit_log WHERE org_id=${ORG} AND action='tip_cashout_requested'`;
  check("audit: tip_cashout_requested with amount + masked only", aud.length === 1 && JSON.stringify(aud[0].detail).includes("2500") && !JSON.stringify(aud[0].detail).includes("@jane"), JSON.stringify(aud));
}

/* ------------------------- double-submit protection ------------------------- */
{
  const again = await submitTipCashoutCore({ orgId: ORG, id: D1, actorUserId: D1, actorRole: "contractor" });
  check("double: second submit refused (open request exists)", again.ok === false && again.code === "invalid_input" && again.message.includes("already"), JSON.stringify(again));
  const rows = await q`SELECT COUNT(*)::int AS c FROM tip_cashouts WHERE org_id=${ORG} AND contractor_id=${D1} AND status='requested'`;
  check("double: still exactly ONE open request", Number(rows[0].c) === 1, JSON.stringify(rows));
}

/* ------------------------- rail verification gate ------------------------- */
{
  const bankSubmit = await submitTipCashoutCore({ orgId: ORG, id: D2, actorUserId: D2, actorRole: "contractor" });
  check("gate: UNVERIFIED bank rail refuses cash-out (verified rail required)", bankSubmit.ok === false && bankSubmit.code === "invalid_input" && bankSubmit.message.includes("verified"), JSON.stringify(bankSubmit));
  const noMethod = await submitTipCashoutCore({ orgId: ORG, id: D3, actorUserId: D3, actorRole: "contractor" });
  check("gate: no method refuses cash-out", noMethod.ok === false && noMethod.code === "invalid_input", JSON.stringify(noMethod));
  // a driver with NO available tips cannot request
  const zero = await availableTipsCore(ORG, D3);
  check("gate: D3 has zero available tips (no paid tips)", zero.totalCents === 0, JSON.stringify(zero));
}

/* ------------------------- owner list + role gates ------------------------- */
{
  const list = await listTipCashoutRequestsCore(ACTOR);
  check("owner: list shows D1's open request (masked)", list.ok && list.data.open.length === 1 && list.data.open[0].contractorId === D1 && list.data.open[0].amountCents === 2500 && list.data.open[0].handleMasked !== "@jane", JSON.stringify(list));
  check("owner: openTotalCents = $25", list.ok && list.data.openTotalCents === 2500 && list.data.paid.length === 0, JSON.stringify(list));
  const denied = await listTipCashoutRequestsCore(D1_ACTOR);
  check("roles: contractor cannot list requests", denied.ok === false && denied.code === "unauthorized", JSON.stringify(denied));
  const markDenied = await markTipCashoutPaidCore(D1_ACTOR, { cashoutId: req1.id });
  check("roles: contractor cannot mark paid", markDenied.ok === false && markDenied.code === "unauthorized", JSON.stringify(markDenied));
  const otherOrg = await listTipCashoutRequestsCore(OTHER_ACTOR);
  check("org: other-org owner sees no qa requests", otherOrg.ok && otherOrg.data.open.length === 0 && otherOrg.data.paid.length === 0, JSON.stringify(otherOrg));
}

/* ------------------------- payday: requested-but-unpaid stays ------------------------- */
{
  const c1 = await computePaydayCore(ACTOR, PERIOD);
  check("payday: REQUESTED cash-out does NOT hide the tip yet (still owed)", c1.ok && c1.data.records.find((r) => r.contractorId === D1)?.tipsCents === 2500, JSON.stringify(c1.data?.records));
}

/* ------------------------- owner mark paid (idempotent) ------------------------- */
{
  const mp = await markTipCashoutPaidCore(ACTOR, { cashoutId: req1.id, note: "venmo sent" });
  check("markpaid: D1 cash-out → paid, note + paidAt", mp.ok && mp.data.status === "paid" && mp.data.note === "venmo sent" && mp.data.paidAt != null, JSON.stringify(mp));
  const again = await markTipCashoutPaidCore(ACTOR, { cashoutId: req1.id });
  check("markpaid: already-paid refuses double-mark (idempotent)", again.ok === false && again.code === "invalid_input" && again.message.includes("already"), JSON.stringify(again));
  const audit = await q`SELECT action FROM audit_log WHERE org_id=${ORG} AND entity_type='tip_cashout' ORDER BY occurred_at`;
  check("audit: requested + paid rows recorded", audit.filter((a) => a.action === "tip_cashout_requested").length === 1 && audit.filter((a) => a.action === "tip_cashout_paid").length === 1, JSON.stringify(audit));
  const list = await listTipCashoutRequestsCore(ACTOR);
  check("owner: request moved to paid list", list.ok && list.data.open.length === 0 && list.data.paid.length === 1 && list.data.paid[0].id === req1.id, JSON.stringify(list));
}

/* ------------------------- payday EXCLUSION of paid cash-out ------------------------- */
{
  const c2 = await computePaydayCore(ACTOR, PERIOD);
  check("payday: paid cash-out tip EXCLUDED — D1 tipsCents = 0", c2.ok && c2.data.records.find((r) => r.contractorId === D1)?.tipsCents === 0, JSON.stringify(c2.data?.records));
  // recompute idempotency — never comes back
  const c3 = await computePaydayCore(ACTOR, PERIOD);
  check("payday: recompute still excludes (cashed-out tip never reappears)", c3.ok && c3.data.records.find((r) => r.contractorId === D1)?.tipsCents === 0, JSON.stringify(c3.data?.records));
  // D2 (bank unverified — cash-out refused) tip still counted
  check("payday: D2 tips still counted ($30 — no cash-out)", c3.ok && c3.data.records.find((r) => r.contractorId === D2)?.tipsCents === 3000, JSON.stringify(c3.data?.records));
  // D4: tip A cashed out + paid, tip B not — PARTIAL exclusion
  const c4 = await submitTipCashoutCore({ orgId: ORG, id: D4, actorUserId: D4, actorRole: "contractor" });
  check("d4: cash-out covers $8 available (only tip A)", c4.ok && c4.data.amountCents === 800, JSON.stringify(c4));
  const covered4 = await q`SELECT covered_tip_ids::text AS c FROM tip_cashouts WHERE id=${c4.data.id}`;
  check("d4: covered tip = T4A only", covered4.length === 1 && JSON.parse(covered4[0].c)[0] === T4A, JSON.stringify(covered4));
  // T4B + T4C arrive AFTER the request → NOT covered by the $8 cash-out
  await q`INSERT INTO completion_tips(id, org_id, job_id, driver_id, driver_towbook_id, amount_cents, currency, status, idempotency_key, created_at) VALUES
    (${T4B}, ${ORG}, ${J4}, ${D4}, ${TB4}, 1000, 'USD', 'paid', ${`tip-co-${TAG}-4b`}, ${iso(new Date(closed.startsAt.getTime() + 9500e3))}),
    (${`qa-co-t4c-${TAG}`}, ${ORG}, ${J4}, ${D4}, ${TB4}, 1200, 'USD', 'paid', ${`tip-co-${TAG}-4c`}, ${iso(new Date(closed.startsAt.getTime() + 9600e3))})`;
  const st4 = await getMyTipCashoutStateCore({ orgId: ORG, id: D4 });
  check("d4: after late tips available = $22 (T4B $10 + T4C $12)", st4.ok && st4.data.availableCents === 2200, JSON.stringify(st4));
  await markTipCashoutPaidCore(ACTOR, { cashoutId: c4.data.id });
  const c5 = await computePaydayCore(ACTOR, PERIOD);
  check("payday: PARTIAL exclusion — D4 tips = $22 (T4B+T4C), T4A excluded", c5.ok && c5.data.records.find((r) => r.contractorId === D4)?.tipsCents === 2200, JSON.stringify(c5.data?.records));
  // D1 can now cash out again (available = 0 → refused)
  const d1again = await submitTipCashoutCore({ orgId: ORG, id: D1, actorUserId: D1, actorRole: "contractor" });
  check("d1: no tips left → refuse", d1again.ok === false && d1again.code === "invalid_input" && d1again.message.includes("No tips"), JSON.stringify(d1again));
}

/* ------------------------- bank micro-deposit verification ------------------------- */
{
  // owner records the test deposit ($0.12) on D2's bank method
  const dep = await setBankDepositCore(ACTOR, { methodId: M2, amountCents: 12 });
  check("bank: owner records test deposit on unverified bank method", dep.ok && dep.data && dep.data.bankDepositCents === 12 && dep.data.bankDepositSentAt != null, JSON.stringify(dep));
  const wrong = await confirmBankDepositCore({ orgId: ORG, id: D2, actorUserId: D2, actorRole: "contractor" }, { amountCents: 11 });
  check("bank: wrong amount refused", wrong.ok === false && wrong.code === "invalid_input", JSON.stringify(wrong));
  const beforeConfirm = await getMyPayoutMethodCore({ orgId: ORG, id: D2 });
  check("bank: driver sees depositSent flag but NEVER the amount", beforeConfirm.ok && beforeConfirm.data.bankDepositSent === true && !("bankDepositCents" in beforeConfirm.data), JSON.stringify(beforeConfirm));
  const right = await confirmBankDepositCore({ orgId: ORG, id: D2, actorUserId: D2, actorRole: "contractor" }, { amountCents: 12 });
  check("bank: correct amount → verified", right.ok && right.data.status === "verified", JSON.stringify(right));
  const aud = await q`SELECT action FROM audit_log WHERE org_id=${ORG} AND action='bank_micro_deposit_confirmed'`;
  check("audit: bank_micro_deposit_confirmed recorded", aud.length === 1, JSON.stringify(aud));
  const again = await confirmBankDepositCore({ orgId: ORG, id: D2, actorUserId: D2, actorRole: "contractor" }, { amountCents: 12 });
  check("bank: already verified → refused", again.ok === false && again.code === "invalid_input", JSON.stringify(again));
  // owner DIRECT verify path (existing verifyPayoutMethodCore) on D4's method → re-verify after reject
  const vv = await verifyPayoutMethodCore(ACTOR, M4);
  check("bank/owner: direct verify still works (owner marks verified)", vv.ok && vv.data && vv.data.status === "verified", JSON.stringify(vv));
  // contractor cannot set the deposit
  const depDenied = await setBankDepositCore(D2_ACTOR, { methodId: M2, amountCents: 12 });
  check("roles: contractor cannot record a test deposit", depDenied.ok === false && depDenied.code === "unauthorized", JSON.stringify(depDenied));
  // D2 now VERIFIED → can cash out their $30 tip
  const d2cash = await submitTipCashoutCore({ orgId: ORG, id: D2, actorUserId: D2, actorRole: "contractor" });
  check("bank: verified bank rail unlocks cash-out ($30)", d2cash.ok && d2cash.data.amountCents === 3000 && d2cash.data.rail === "bank", JSON.stringify(d2cash));
  check("bank: cash-out handleMasked is institution + last4 (never account)", d2cash.ok && d2cash.data.handleMasked.includes("Chase") && d2cash.data.handleMasked.includes("4321") && !JSON.stringify(d2cash).includes(ACCOUNT), JSON.stringify(d2cash));
  const d2st = await getMyTipCashoutStateCore({ orgId: ORG, id: D2 });
  check("bank: driver state never leaks the account number", d2st.ok && !JSON.stringify(d2st.data).includes(ACCOUNT) && !JSON.stringify(d2st.data).includes(ROUTING), JSON.stringify(d2st));
}

/* ------------------------- sensitive-number handling ------------------------- */
{
  const rows = await q`SELECT bank_routing_encrypted, bank_account_encrypted FROM payout_methods WHERE org_id=${ORG} AND contractor_id=${D2}`;
  check("pii: stored ENCRYPTED (v1 envelope), never plaintext", rows.length === 1 && String(rows[0].bank_routing_encrypted).startsWith("v1.") && String(rows[0].bank_account_encrypted).startsWith("v1.") && !String(rows[0].bank_routing_encrypted).includes(ROUTING) && !String(rows[0].bank_account_encrypted).includes(ACCOUNT), JSON.stringify(rows));
  const ownerList = await listPayoutMethodsCore(ACTOR);
  const d2row = ownerList.ok ? ownerList.data.find((m) => m.contractorId === D2) : null;
  check("pii: OWNER sees full decrypted routing+account (owner-only surface)", ownerList.ok && d2row && d2row.bankRoutingNumberFull === ROUTING && d2row.bankAccountNumberFull === ACCOUNT, JSON.stringify(d2row));
  const d2mine = await getMyPayoutMethodCore({ orgId: ORG, id: D2 });
  check("pii: contractor read NEVER contains full numbers (masked only)", d2mine.ok && d2mine.data.bankLast4 === "4321" && !JSON.stringify(d2mine.data).includes(ACCOUNT) && !JSON.stringify(d2mine.data).includes(ROUTING), JSON.stringify(d2mine));
  const d2OwnerRead = await getContractorPayoutMethodCore(ACTOR, D2);
  check("pii: owner contractor-detail read has full numbers", d2OwnerRead.ok && d2OwnerRead.data.bankRoutingNumberFull === ROUTING && d2OwnerRead.data.bankAccountNumberFull === ACCOUNT, JSON.stringify(d2OwnerRead));
  const audAll = await q`SELECT detail FROM audit_log WHERE org_id=${ORG}`;
  check("pii: NO audit detail ever contains the account/routing or full bank numbers", audAll.every((a) => !JSON.stringify(a.detail).includes(ACCOUNT) && !JSON.stringify(a.detail).includes(ROUTING) && !JSON.stringify(a.detail).includes("@jane") && !JSON.stringify(a.detail).includes("$alex")), JSON.stringify(audAll.map((a) => a.detail)));
  // encryption round-trip + tamper behavior
  const enc = await encryptBankValue("123456789");
  const dec = await decryptBankValue(enc);
  check("crypto: encrypt/decrypt round-trip", dec === "123456789" && enc.startsWith("v1.") && !enc.includes("123456789"), enc);
  let threw = false;
  try { await decryptBankValue("v1.bad.bad.bad"); } catch { threw = true; }
  check("crypto: garbage envelope throws (never leaks)", threw === true, "");
}

/* ------------------------- cross-org isolation + overview ------------------------- */
{
  const list = await listTipCashoutRequestsCore(ACTOR);
  check("owner: all open requests listed (D2 bank $30, D4 closed earlier)", list.ok && list.data.open.some((r) => r.contractorId === D2) && list.data.open.some((r) => r.contractorId === D1) === false, JSON.stringify(list.data.open.map((r) => r.contractorId)));
  const other = await listTipCashoutRequestsCore(OTHER_ACTOR);
  check("org: ORG2 owner sees nothing from ORG", other.ok && other.data.open.length === 0 && other.data.paid.length === 0, JSON.stringify(other));
}
} finally {
  await cleanup();
}
/* ================= POST-CLEANUP VERIFICATION (zero QA rows) ================= */
const leftover = await q`SELECT
  (SELECT count(*) FROM tip_cashouts WHERE org_id LIKE 'qa-cashout%' OR org_id LIKE 'qa-co-%') AS cashouts,
  (SELECT count(*) FROM payout_records WHERE org_id LIKE 'qa-cashout%' OR org_id LIKE 'qa-co-%') AS records,
  (SELECT count(*) FROM pay_periods WHERE org_id LIKE 'qa-cashout%' OR org_id LIKE 'qa-co-%') AS periods,
  (SELECT count(*) FROM payment_transactions WHERE org_id LIKE 'qa-cashout%' OR org_id LIKE 'qa-co-%') AS txns,
  (SELECT count(*) FROM payout_methods WHERE org_id LIKE 'qa-cashout%' OR org_id LIKE 'qa-co-%') AS methods,
  (SELECT count(*) FROM completion_tips WHERE org_id LIKE 'qa-cashout%' OR org_id LIKE 'qa-co-%') AS tips,
  (SELECT count(*) FROM dispatch_jobs WHERE org_id LIKE 'qa-cashout%' OR org_id LIKE 'qa-co-%') AS jobs,
  (SELECT count(*) FROM contractor_profiles WHERE org_id LIKE 'qa-cashout%' OR org_id LIKE 'qa-co-%') AS profiles,
  (SELECT count(*) FROM audit_log WHERE org_id LIKE 'qa-cashout%' OR org_id LIKE 'qa-co-%' OR actor_user_id LIKE 'qa-co-%') AS audit,
  (SELECT count(*) FROM organizations WHERE id LIKE 'qa-cashout%' OR name LIKE 'qa tip cashout%') AS orgs,
  (SELECT count(*) FROM users WHERE id LIKE 'qa-co-%' OR email LIKE 'qa-co-%') AS users,
  (SELECT count(*) FROM organization_memberships WHERE org_id LIKE 'qa-cashout%' OR org_id LIKE 'qa-co-%') AS mems`;
check("cleanup: zero QA rows", Object.values(leftover[0]).every((v) => Number(v) === 0), JSON.stringify(leftover[0]));
console.log(`\ntip-cashout.test.mjs: ${checks.length}/${checks.length} passed`);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
process.exit(checks.every(([, c]) => c) ? 0 : 1);
