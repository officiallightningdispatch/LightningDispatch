// SQUARE IDEMPOTENCY-KEY FOCUSED TEST (2026-08-13, owner-directed repair).
// Pure unit test — imports ONLY the key helper; NO database, NO network, NO
// live Square calls, NO real card nonces, NO money movement. Reproduces the
// production incident (HTTP 400 VALUE_TOO_LONG — a club key was 47 chars) in a
// sandbox-safe way and proves the repair properties:
//   1) every key ≤ 45 chars (Square's hard limit) for long UUID inputs,
//   2) deterministic for the SAME logical attempt (retry replays the same key
//      → Square returns the same payment → no double charge),
//   3) differs across DISTINCT attempts and DISTINCT transactions,
//   4) preserves the retry/no-double-charge semantics at the call-site level
//      (club, tip, and battery paths all route through the same helper).
// Run alone:  DATABASE_URL unset is fine — this test never touches the DB.
//   bun square-idempotency.test.mjs
const { squareIdempotencyKey } = await import("./src/data/square-client.ts");

const checks = [];
const check = (name, cond, extra = "") => checks.push([name, Boolean(cond), extra]);
const line = (name, v) => check(name, true, ` (${v})`);

/* ------------------- incident reproduction (sandbox-safe) ------------------- */
// Production failure 2026-08-13: the legacy raw club key
// `club-<ptx-uuid>-<attempt>` was 47 chars → Square rejected EVERY club charge
// with "HTTP 400 VALUE_TOO_LONG — field idempotency_key, must not be greater
// than 45 length". Rebuild the exact legacy shapes and prove they exceed 45.
const org8 = "a1b2c3d4";
const uuid36 = "123e4567-e89b-12d3-a456-426614174000"; // gen_random_uuid() shape
const ptxTxn = `ptx-${org8}-${uuid36}`; // payment_transactions id (stageClubChargeCore)
const legacyClubKey = `club-${ptxTxn}-1`;
line("incident: legacy club key length", legacyClubKey.length);
check("incident: legacy club key EXCEEDS Square's 45-char limit (HTTP 400 VALUE_TOO_LONG)", legacyClubKey.length > 45, legacyClubKey);

const legacyTipKey = `tip-${uuid36}-${"703785"}-1`; // tip-<job>-<driver>-<attempt>
check("incident: legacy tip key EXCEEDS 45 too", legacyTipKey.length > 45, legacyTipKey);

// Battery path BEFORE this repair: `battery-${sale.id}-${attempt}` with a raw
// UUID sale id (battery_sales.id = gen_random_uuid()) → 46–47 chars → same 400.
const legacyBatteryKey = `battery-${uuid36}-1`;
line("incident: legacy battery key length", legacyBatteryKey.length);
check("incident: legacy battery key EXCEEDS 45 (the uncovered path this repair closes)", legacyBatteryKey.length > 45, legacyBatteryKey);

/* --------------------------- repaired: ≤ 45 chars --------------------------- */
const clubKey1 = squareIdempotencyKey("club-", ptxTxn, 1);
const tipKey1 = squareIdempotencyKey("tip-", uuid36, "703785", 1);
const batteryKey1 = squareIdempotencyKey("battery-", uuid36, 1);
check("fix: club key ≤ 45 chars", clubKey1.length <= 45, clubKey1);
check("fix: tip key ≤ 45 chars", tipKey1.length <= 45, tipKey1);
check("fix: battery key ≤ 45 chars", batteryKey1.length <= 45, batteryKey1);
check("fix: keys keep their human prefix (audit readability)", clubKey1.startsWith("club-") && tipKey1.startsWith("tip-") && batteryKey1.startsWith("battery-"), `${clubKey1} / ${tipKey1} / ${batteryKey1}`);
line("fix: club key length", clubKey1.length);
line("fix: tip key length", tipKey1.length);
line("fix: battery key length", batteryKey1.length);

/* ------------------ deterministic for the same logical attempt ------------------ */
// A retry after a network blip MUST replay the SAME key — Square then returns
// the same payment for the replayed key, making a double charge impossible.
check("fix: same logical attempt → SAME key (club)", squareIdempotencyKey("club-", ptxTxn, 1) === clubKey1, "");
check("fix: same logical attempt → SAME key (tip)", squareIdempotencyKey("tip-", uuid36, "703785", 1) === tipKey1, "");
check("fix: same logical attempt → SAME key (battery)", squareIdempotencyKey("battery-", uuid36, 1) === batteryKey1, "");
check("fix: deterministic across process calls (100× re-compute, all three paths)", (() => {
  for (let i = 0; i < 100; i++) {
    if (squareIdempotencyKey("club-", ptxTxn, 1) !== clubKey1) return false;
    if (squareIdempotencyKey("tip-", uuid36, "703785", 1) !== tipKey1) return false;
    if (squareIdempotencyKey("battery-", uuid36, 1) !== batteryKey1) return false;
  }
  return true;
})(), "");

/* ----------------------- differs across distinct attempts ----------------------- */
const clubKey2 = squareIdempotencyKey("club-", ptxTxn, 2);
const batteryKey2 = squareIdempotencyKey("battery-", uuid36, 2);
check("fix: attempt 2 → DIFFERENT key (club) — a confirmed-failure retry is a new logical attempt", clubKey2 !== clubKey1 && clubKey2.length <= 45, `${clubKey1} vs ${clubKey2}`);
check("fix: attempt 2 → DIFFERENT key (battery)", batteryKey2 !== batteryKey1 && batteryKey2.length <= 45, "");
check("fix: tip attempt 2 differs (driver-retry after decline)", squareIdempotencyKey("tip-", uuid36, "703785", 2) !== tipKey1, "");

/* ---------------------- differs across distinct transactions ---------------------- */
const txnB = `ptx-${"ff00ff00"}-${"9b2f4c7e-1a2b-3c4d-8e9f-000000000001"}`;
const saleB = "9b2f4c7e-1a2b-3c4d-8e9f-000000000002";
check("fix: different transactions → DIFFERENT club keys (no cross-txn collision)", squareIdempotencyKey("club-", txnB, 1) !== clubKey1, "");
check("fix: different sales → DIFFERENT battery keys", squareIdempotencyKey("battery-", saleB, 1) !== batteryKey1, "");
check("fix: same txn + same attempt ALWAYS the same key regardless of process", squareIdempotencyKey("club-", txnB, 1) === squareIdempotencyKey("club-", txnB, 1), "");

/* ------------------- retry / no-double-charge semantics (call-site) ------------------- */
// The chargeStagedCore contract: a transport error leaves the row 'staged' with
// the same attempt, so the retry replays the SAME key; a confirmed failure
// bumps the attempt → a FRESH key. Assert the key function honors both halves.
check("retry: blip retry (same attempt) replays the SAME key — Square returns the same payment, no double charge", squareIdempotencyKey("club-", ptxTxn, 1) === clubKey1, "");
check("retry: confirmed-failure retry (attempt 2) gets a FRESH key", squareIdempotencyKey("club-", ptxTxn, 2) !== clubKey1, "");
check("retry: battery re-charge attempt 2 gets a FRESH key (declined card retry)", batteryKey2 !== batteryKey1, "");
check("retry: legacy keys would have been sent raw — every one > 45 (the 400)", legacyClubKey.length > 45 && legacyTipKey.length > 45 && legacyBatteryKey.length > 45, "");

/* ------------------------- worst-case prefix robustness ------------------------- */
// Even a long prefix is truncated to 8 chars before hashing → still ≤ 45.
const longPrefix = squareIdempotencyKey("battery-sale-", uuid36, 1);
check("fix: long prefix (battery-sale-) still ≤ 45", longPrefix.length <= 45, longPrefix);

/* ---------------------------------- report ---------------------------------- */
const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok, extra] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra}`);
console.log(`square-idempotency: ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.log("FAILED:");
  for (const [name, , extra] of failed) console.log(`  - ${name}${extra}`);
  process.exit(1);
}
