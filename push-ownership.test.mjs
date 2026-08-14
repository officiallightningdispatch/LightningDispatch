// PUSH-SUBSCRIPTION OWNERSHIP — ACCOUNT-SCOPED UNIQUENESS REGRESSION (2026-08-14)
// =============================================================================
// Root cause (proven read-only on prod): migration 35 declared
// `endpoint TEXT NOT NULL UNIQUE` (constraint push_subscriptions_endpoint_key —
// a GLOBAL unique) and savePushSubscriptionCore upserted with
// `ON CONFLICT (endpoint) DO UPDATE SET org_id=EXCLUDED.org_id,
// user_id=EXCLUDED.user_id`. When a DIFFERENT user re-saved the same endpoint
// (shared phone / sign-in switch), the row silently RE-PARENTED to the last
// saver. Live evidence: 24hourbattery's Apple endpoint was later saved by
// another driver — 24hourbattery ended with ZERO push_subscriptions rows, and
// the self-test delivered to the endpoint under the WRONG account.
//
// Fix under test: migration 46 drops the endpoint-global constraint and creates
// an ACCOUNT-SCOPED unique index (org_id, user_id, endpoint);
// savePushSubscriptionCore now conflicts on (org_id, user_id, endpoint) and no
// longer re-parents org/user on update. Result:
//   · user A and user B in the SAME org may each hold a row for the SAME
//     endpoint (B's save INSERTS B's own row instead of stealing A's);
//   · a repeated save by A updates ONLY A's row (same-user idempotency —
//     A's count stays 1; B's row untouched);
//   · delete by A removes only A's row.
//
// Hermetic by team convention (push-repair pattern): runs ONLY against a
// `qa-pushownership-*` fixture org under the assertQaOrg guard; snapshots every
// non-QA push_subscriptions row BEFORE and AFTER and requires byte-identical
// row sets — the "production records untouched" proof. NEVER sends a push
// (save/list/delete only; fake https://push.example.test endpoints).
//
// RUN ALONE, SEQUENTIALLY (never parallel with other suites — suites collide):
//   DATABASE_URL=... bun push-ownership.test.mjs
// This pass runs it against a scratch Postgres so the production DB is not
// touched at all; the gate pass runs the same file against the real DB (where
// migration 46 then applies as part of the gated release).
import { randomUUID, randomBytes } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
const { ensureSchema } = await import("./src/data/migrations.ts");
const { ensureAuthSchema } = await import("./src/data/auth-server.ts");
const {
  savePushSubscriptionCore,
  listPushSubscriptionsCore,
  deletePushSubscriptionCore,
} = await import("./src/data/push-core.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");

const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};
const b64url = (b) => Buffer.from(b).toString("base64url");
const TAG = randomUUID().slice(0, 8);
const ORG = `qa-pushownership-${TAG}`;
const USER_A = `pushown-a-${TAG}`;
const USER_B = `pushown-b-${TAG}`;
const ENDPOINT = `https://push.example.test/shared-endpoint-${TAG}`;
const actor = (uid) => ({ id: uid, orgId: ORG, role: "contractor" });
const key = (n) => b64url(randomBytes(65)); // P-256 uncompressed point (65B)
const secret = (n) => b64url(randomBytes(16)); // RFC 8291 auth (16B)
const K_A1 = key("a1"), K_A2 = key("a2"), K_B1 = key("b1"), K_B2 = key("b2");
const S_A1 = secret("a1"), S_A2 = secret("a2"), S_B1 = secret("b1");

const nonQaSubs = async () =>
  (await q`SELECT id, org_id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE org_id NOT LIKE 'qa-%' ORDER BY id`)
    .map((r) => `${r.id}|${r.org_id}|${r.user_id}|${r.endpoint}|${r.p256dh}|${r.auth}`);

let prodBefore = [];
try {
  /* ============ (0) SCHEMA — MIGRATION 46 APPLIED (append-only) ============ */
  await ensureAuthSchema(); // organizations / users / organization_memberships
  await ensureSchema();     // migrations 1..46 — 46 corrects the uniqueness
  const endpointConstraint = await q`SELECT 1 FROM pg_constraint WHERE conname='push_subscriptions_endpoint_key' AND conrelid='push_subscriptions'::regclass`;
  check("migration 46: endpoint-GLOBAL unique constraint is GONE (push_subscriptions_endpoint_key)", endpointConstraint.length === 0);
  const scopeIdx = await q`SELECT indexdef FROM pg_indexes WHERE tablename='push_subscriptions' AND indexname='push_subscriptions_org_user_endpoint_uidx'`;
  check("migration 46: ACCOUNT-SCOPED unique index (org_id, user_id, endpoint) exists", scopeIdx.length === 1 && scopeIdx[0].indexdef.includes("UNIQUE") && scopeIdx[0].indexdef.includes("(org_id, user_id, endpoint)"), scopeIdx[0]?.indexdef ?? "missing");
  const v46 = await q`SELECT 1 FROM schema_migrations WHERE version=46`;
  check("migration 46: recorded in schema_migrations (append-only)", v46.length === 1);

  /* ============ (1) PRODUCTION BASELINE (non-QA rows, byte-identical after) ============ */
  prodBefore = await nonQaSubs();
  console.log(`PROD-BEFORE nonQa push_subscriptions rows=${prodBefore.length}`);

  /* ============================ (2) QA FIXTURE ============================ */
  await q`INSERT INTO organizations(id, name) VALUES(${ORG}, 'qa push-ownership')`;
  for (const [uid, name] of [[USER_A, "QA Push-Ownership User A"], [USER_B, "QA Push-Ownership User B"]]) {
    await q`INSERT INTO users(id, name, email, password_hash) VALUES(${uid}, ${name}, ${`qa-pushown-${uid}-${randomUUID()}@lightning.test`}, 'x')`;
    await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${uid}, 'contractor')`;
  }

  /* ================== (3) THE REGRESSION — SAME ENDPOINT, TWO USERS ================== */
  // A saves the endpoint first — 1 row, owned by A.
  const a1 = await savePushSubscriptionCore(actor(USER_A), { endpoint: ENDPOINT, p256dh: K_A1, auth: S_A1, userAgent: "qa-a/1" });
  check("A saves endpoint → ok, row owned by A", a1.ok && a1.subscription.orgId === ORG && a1.subscription.userId === USER_A && a1.subscription.endpoint === ENDPOINT, JSON.stringify(a1));
  check("A saves endpoint → exactly 1 row for A", Number((await q`SELECT COUNT(*)::int c FROM push_subscriptions WHERE org_id=${ORG} AND user_id=${USER_A} AND endpoint=${ENDPOINT}`)[0].c) === 1);

  // B saves the SAME endpoint — THE FIX: B gets B's OWN row; A's row survives.
  // (Old code: ON CONFLICT (endpoint) re-parented the single row to B — A lost it.)
  const b1 = await savePushSubscriptionCore(actor(USER_B), { endpoint: ENDPOINT, p256dh: K_B1, auth: S_B1, userAgent: "qa-b/1" });
  check("B saves SAME endpoint → ok (B's own row, no conflict)", b1.ok && b1.subscription.userId === USER_B, JSON.stringify(b1));
  const bothRows = await q`SELECT user_id, p256dh FROM push_subscriptions WHERE org_id=${ORG} AND endpoint=${ENDPOINT} ORDER BY user_id`;
  check("FIX: same endpoint now has TWO rows — one per user (no re-parenting)", bothRows.length === 2 && bothRows[0].user_id === USER_A && bothRows[1].user_id === USER_B, JSON.stringify(bothRows));
  check("FIX: A's row still carries A's original keys (not overwritten by B)", bothRows.find((r) => r.user_id === USER_A)?.p256dh === K_A1, JSON.stringify(bothRows));

  // Repeated save by A (new keys) — updates A's row ONLY; count stays 1; B untouched.
  const a2 = await savePushSubscriptionCore(actor(USER_A), { endpoint: ENDPOINT, p256dh: K_A2, auth: S_A2, userAgent: "qa-a/2" });
  check("A re-saves same endpoint → ok", a2.ok === true, JSON.stringify(a2));
  check("same-user idempotency: A still has exactly 1 row for the endpoint", Number((await q`SELECT COUNT(*)::int c FROM push_subscriptions WHERE org_id=${ORG} AND user_id=${USER_A} AND endpoint=${ENDPOINT}`)[0].c) === 1);
  const afterAResave = await q`SELECT user_id, p256dh, auth FROM push_subscriptions WHERE org_id=${ORG} AND endpoint=${ENDPOINT} ORDER BY user_id`;
  check("A re-save updated A's row (p256dh/auth refreshed)", afterAResave.find((r) => r.user_id === USER_A)?.p256dh === K_A2 && afterAResave.find((r) => r.user_id === USER_A)?.auth === S_A2, JSON.stringify(afterAResave));
  check("A re-save did NOT touch B's row (B still holds B's original keys)", afterAResave.find((r) => r.user_id === USER_B)?.p256dh === K_B1 && afterAResave.find((r) => r.user_id === USER_B)?.auth === S_B1, JSON.stringify(afterAResave));
  check("FIX: still exactly 2 rows for the shared endpoint after A's re-save", afterAResave.length === 2, JSON.stringify(afterAResave));

  // B re-saves (new keys) — B's row updated, A's row untouched.
  await savePushSubscriptionCore(actor(USER_B), { endpoint: ENDPOINT, p256dh: K_B2, auth: S_B1, userAgent: "qa-b/2" });
  const afterBResave = await q`SELECT user_id, p256dh FROM push_subscriptions WHERE org_id=${ORG} AND endpoint=${ENDPOINT} ORDER BY user_id`;
  check("B re-save updated B's row only", afterBResave.find((r) => r.user_id === USER_B)?.p256dh === K_B2 && afterBResave.find((r) => r.user_id === USER_A)?.p256dh === K_A2, JSON.stringify(afterBResave));

  /* =============== (4) LIST — EACH USER SEES ONLY THEIR OWN ROW =============== */
  const listA = await listPushSubscriptionsCore(actor(USER_A));
  const listB = await listPushSubscriptionsCore(actor(USER_B));
  check("list(A) = exactly A's row (endpoint + A's keys)", listA.ok && listA.subscriptions.length === 1 && listA.subscriptions[0].endpoint === ENDPOINT && listA.subscriptions[0].p256dh === K_A2, JSON.stringify(listA));
  check("list(B) = exactly B's row (endpoint + B's keys)", listB.ok && listB.subscriptions.length === 1 && listB.subscriptions[0].endpoint === ENDPOINT && listB.subscriptions[0].p256dh === K_B2, JSON.stringify(listB));

  /* ============== (5) DB-LEVEL ENFORCEMENT — UNIQUE INDEX ACTIVE ============== */
  // A raw duplicate (same org, same user, same endpoint) must violate 23505 —
  // the account-scoped unique index is what makes same-user idempotency work
  // at the storage layer, not just in the upsert.
  let dupCode = null;
  try {
    await q`INSERT INTO push_subscriptions(id, org_id, user_id, endpoint, p256dh, auth, user_agent) VALUES(${'sub-dup-' + TAG}, ${ORG}, ${USER_A}, ${ENDPOINT}, ${K_A1}, ${S_A1}, 'qa-dup')`;
  } catch (e) {
    dupCode = e && typeof e === "object" && e !== null && "code" in e ? String(e.code) : String(e);
  }
  check("DB enforces account-scoped uniqueness: duplicate (org,user,endpoint) → SQLSTATE 23505", dupCode === "23505", String(dupCode));

  /* ================ (6) DELETE — REMOVES ONLY THE CALLER'S ROW ================ */
  const delA = await deletePushSubscriptionCore(actor(USER_A), ENDPOINT);
  check("A deletes endpoint → deleted=true", delA.ok && delA.deleted === true, JSON.stringify(delA));
  check("A delete removed ONLY A's row (B's row survives)", Number((await q`SELECT COUNT(*)::int c FROM push_subscriptions WHERE org_id=${ORG} AND endpoint=${ENDPOINT}`)[0].c) === 1 && Number((await q`SELECT COUNT(*)::int c FROM push_subscriptions WHERE org_id=${ORG} AND user_id=${USER_B} AND endpoint=${ENDPOINT}`)[0].c) === 1);
  const delA2 = await deletePushSubscriptionCore(actor(USER_A), ENDPOINT);
  check("A delete again → deleted=false (idempotent, no error)", delA2.ok && delA2.deleted === false, JSON.stringify(delA2));

  console.log(`push-ownership.test.mjs: ${checks.filter(([, ok]) => ok).length}/${checks.length} passed so far`);
} finally {
  /* ================== (7) CLEANUP — ALWAYS RUNS (guard-protected) ================== */
  const memberIds = await q`SELECT DISTINCT m.user_id FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa push-ownership%'`;
  for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa push-ownership%'`) {
    assertQaOrg(org.id, org.name); // HARD GUARD — refuses anything not provably QA
    await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
  }
  for (const u of memberIds) await q`DELETE FROM users WHERE id=${u.user_id}`.catch(() => {});
  const leftover = await q`SELECT
    (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa push-ownership%') AS orgs,
    (SELECT COUNT(*)::int FROM push_subscriptions WHERE org_id LIKE 'qa-pushownership%') AS subs,
    (SELECT COUNT(*)::int FROM users WHERE email LIKE 'qa-pushown-%@lightning.test') AS users,
    (SELECT COUNT(*)::int FROM organization_memberships WHERE org_id LIKE 'qa-pushownership%') AS members`;
  console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
  if (!Object.values(leftover[0]).every((v) => Number(v) === 0)) {
    console.error("FAIL: QA cleanup left rows behind (push_subscriptions included)");
    process.exit(1);
  }
  console.log("push-ownership.test.mjs: cleanup verified — zero QA rows left");
}

/* ============== (8) FINAL PROOF — NON-QA ROWS BYTE-IDENTICAL ============== */
const prodAfter = await nonQaSubs();
const identical = prodBefore.length === prodAfter.length && prodBefore.every((s, i) => s === prodAfter[i]);
check("PRODUCTION RECORDS UNTOUCHED: non-QA push_subscriptions row-set byte-identical before/after", identical, `before=${prodBefore.length} after=${prodAfter.length}`);
const failed = checks.filter(([, ok]) => !ok);
console.log(`push-ownership.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }
console.log("push-ownership.test.mjs: ACCOUNT-SCOPED OWNERSHIP REPAIR VERIFIED — a shared endpoint can never re-parent between users again.");
