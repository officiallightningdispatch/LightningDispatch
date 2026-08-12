// DB safety (2026-08-12): org deletes guarded by assertQaOrg — see src/data/db-guard.ts + /home/team/shared/db-safety-rules.md.
// Hermetic contractor-management tests (2026-08-11, plan milestone 2 — "Driver
// import + Towbook credentials" / "Contractor management"): the owner portal
// surface — list contractor accounts (role 'contractor') with sign-in status
// DERIVED from existing tables (towbook_sessions session_kind='driver'), add a
// contractor manually (name + Towbook driver ID + optional email → LD users row
// in the exact shape driver-auth expects: login_handle derived, random unusable
// password hash, towbook_driver_id set so their existing Towbook login links),
// and bulk-import the REAL contractor list from Towbook (GET /api/drivers via
// the owner's connected session — the same roster endpoint driver-auth reads,
// the same session-decrypt path the AI dispatcher uses). Real network calls
// never happen: the Towbook roster fetch is an injectable mock fetchImpl.
// DB-backed against throwaway QA orgs deleted at the end (zero rows left).
//   DATABASE_URL=... bun contractor-management.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
// Test key for THIS process only (env-first resolution overrides the stable
// key file — same pattern as the other suites).
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 9).toString("base64");
const {
  listContractorsCore,
  addContractorCore,
  importContractorsCore,
  removeContractorCore,
  deriveLoginHandle,
} = await import("./src/data/contractor-management-core.ts");
const { encryptSession } = await import("./src/data/towbook-key.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

const ORG = `qa-contractor-${randomUUID()}`;   // full add + status + import flow
const ORG2 = `qa-contractor2-${randomUUID()}`; // no owner session → import gate
const OWNER = `qa-contractor-owner-${randomUUID()}`;
const ADMIN = `qa-contractor-admin-${randomUUID()}`;
const CONTRACTOR = `qa-contractor-driver-${randomUUID()}`; // wrong-role actor
const OTHER_HANDLE_USER = `qa-contractor-handle-${randomUUID()}`; // handle/email conflicts
// Numeric tag so the handle-conflict fixture is unique per run (the roster's
// conflicting driver id must produce the SAME derived login handle).
const HANDLE_TAG = String(Math.floor(Math.random() * 1_000_000_000));

const ACTOR = { orgId: ORG, id: OWNER, role: "owner" };
const ADMIN_ACTOR = { orgId: ORG, id: ADMIN, role: "admin" };
const WRONG_ACTOR = { orgId: ORG, id: CONTRACTOR, role: "contractor" };

// Mock Towbook: GET /api/drivers only (the import is GET-only — the suite
// asserts no other method/url is ever called). Records every call.
function makeFetch(roster, { status = 200, unexpected = () => { throw new Error("unexpected call") } } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    calls.push({ method, url: u });
    if (method === "GET" && u.endsWith("/api/drivers")) {
      if (status !== 200) {
        return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify({ error: "boom" }), json: async () => ({ error: "boom" }) };
      }
      return { status: 200, ok: true, text: async () => JSON.stringify(roster), json: async () => JSON.parse(JSON.stringify(roster)) };
    }
    return unexpected();
  };
  return { fetchImpl, calls };
}

async function setup() {
  await ensureSchema();
  for (const [org, owner, admin, contractor] of [
    [ORG, OWNER, ADMIN, CONTRACTOR],
    [ORG2, `qa-contractor2-owner-${randomUUID()}`, null, null],
  ]) {
    await q`INSERT INTO organizations(id, name) VALUES(${org}, 'qa contractor')`;
    await q`INSERT INTO users(id, name, email, password_hash) VALUES(${owner}, 'QA Contractor Owner', ${`qa-contractor-owner-${randomUUID()}@lightning.test`}, 'x')`;
    await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${org}, ${owner}, 'owner')`;
    if (admin) {
      await q`INSERT INTO users(id, name, email, password_hash) VALUES(${admin}, 'QA Contractor Admin', ${`qa-contractor-admin-${randomUUID()}@lightning.test`}, 'x')`;
      await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${org}, ${admin}, 'admin')`;
    }
    if (contractor) {
      await q`INSERT INTO users(id, name, email, password_hash) VALUES(${contractor}, 'QA Contractor Driver', ${`qa-contractor-driver-${randomUUID()}@lightning.test`}, 'x')`;
      await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${org}, ${contractor}, 'contractor')`;
    }
    if (org === ORG) {
      // The owner's connected Towbook session — same row the AI dispatcher uses.
      await q`INSERT INTO towbook_sessions(org_id, encrypted_session, status, session_kind)
        VALUES(${org}, ${await encryptSession(JSON.stringify({ cookies: "xtl=fake", baseUrl: "https://app.towbook.com" }))}, 'connected', 'owner')`;
      // A user whose login_handle + email collide with derived values (conflict rails).
      await q`INSERT INTO users(id, name, email, password_hash, login_handle) VALUES(${OTHER_HANDLE_USER}, 'QA Handle Taker', ${`qa-contractor-handle-${randomUUID()}@lightning.test`}, 'x', ${`qa-handle-taker-${HANDLE_TAG}`})`;
    }
  }
}

await setup();

/* ================= 1) list: empty org + deriveLoginHandle ================= */
{
  // ORG's only contractor-role user at this point is the wrong-role fixture
  // (no Towbook driver id, never signed in).
  const r = await listContractorsCore(ACTOR);
  check("initial list = fixture driver only, not signed in", r.ok === true && r.data.length === 1 && r.data[0].id === CONTRACTOR && r.data[0].status === "not_signed_in" && r.data[0].towbookDriverId === null, JSON.stringify(r));
  check("deriveLoginHandle slug + driver id", deriveLoginHandle("Antone Jerret", "603482") === "antone-jerret-603482");
  check("deriveLoginHandle empty name fallback", deriveLoginHandle("", "603482") === "driver-603482");
  const bad = await listContractorsCore(WRONG_ACTOR);
  check("list: contractor actor → unauthorized", bad.ok === false && bad.code === "unauthorized", JSON.stringify(bad));
}

/* ================ 2) manual add: row shape + audit + status ================ */
{
  const r = await addContractorCore(ACTOR, { name: "QA Add Driver", towbookDriverId: "910001", email: "" });
  check("add ok", r.ok === true, JSON.stringify(r));
  const c = r.ok ? r.data : null;
  check("added row: name + driver id", c && c.name === "QA Add Driver" && c.towbookDriverId === "910001", JSON.stringify(c));
  check("added row: derived login handle", c && c.loginHandle === "qa-add-driver-910001", JSON.stringify(c));
  check("added row: derived email", c && c.email === "qa-add-driver-910001@towbook.driver", JSON.stringify(c));
  check("added row: status not_signed_in", c && c.status === "not_signed_in" && c.lastActivityAt === null, JSON.stringify(c));
  const dbRow = await q`SELECT u.password_hash, u.login_handle, u.email, u.towbook_driver_id FROM users u WHERE u.id=${c.id}`;
  check("row has a (random, unusable) password hash", dbRow.length === 1 && String(dbRow[0].password_hash).includes(":"), JSON.stringify(dbRow));
  check("row stored derived handle + email + driver id", String(dbRow[0].login_handle) === "qa-add-driver-910001" && String(dbRow[0].email) === "qa-add-driver-910001@towbook.driver" && String(dbRow[0].towbook_driver_id) === "910001", JSON.stringify(dbRow));
  const member = await q`SELECT role FROM organization_memberships WHERE org_id=${ORG} AND user_id=${c.id}`;
  check("membership role contractor", member.length === 1 && String(member[0].role) === "contractor", JSON.stringify(member));
  const aud = await q`SELECT action, entity_type, entity_id, actor_role, detail FROM audit_log WHERE org_id=${ORG} AND action='contractor_added'`;
  check("audit contractor_added (entity contractor, owner actor)", aud.length === 1 && String(aud[0].entity_type) === "contractor" && String(aud[0].actor_role) === "owner" && aud[0].detail && aud[0].detail.towbookDriverId === "910001" && String(aud[0].entity_id) === c.id, JSON.stringify(aud));

  // Custom email honored when valid.
  const r2 = await addContractorCore(ACTOR, { name: "QA Email Driver", towbookDriverId: "910008", email: "qa-email-driver-910008@lightning.test" });
  check("add with explicit valid email", r2.ok === true && r2.data.email === "qa-email-driver-910008@lightning.test", JSON.stringify(r2));
  // Invalid email input → clear error, no row.
  const r3 = await addContractorCore(ACTOR, { name: "QA Bad Email", towbookDriverId: "910009", email: "not-an-email" });
  check("add with invalid email → invalid_input", r3.ok === false && r3.code === "invalid_input", JSON.stringify(r3));
  // Non-numeric driver id → clear error.
  const r4 = await addContractorCore(ACTOR, { name: "QA Bad Id", towbookDriverId: "abc" });
  check("add with non-numeric driver id → invalid_input", r4.ok === false && r4.code === "invalid_input", JSON.stringify(r4));
}

/* ======================== 3) duplicate add errors ======================== */
{
  const dup = await addContractorCore(ACTOR, { name: "QA Add Driver Dupe", towbookDriverId: "910001" });
  check("duplicate driver id → duplicate error (no crash)", dup.ok === false && dup.code === "duplicate" && String(dup.message).includes("910001"), JSON.stringify(dup));
  // Handles embed the driver id, so a collision requires a pre-existing row
  // that already holds the derived handle.
  await q`INSERT INTO users(id, name, email, password_hash, login_handle) VALUES(${`qa-handle-conflict-${randomUUID()}`}, 'QA Handle Conflict', ${`qa-contractor-handle-${randomUUID()}@lightning.test`}, 'x', 'qa-add-driver-910021')`;
  const dup2 = await addContractorCore(ACTOR, { name: "QA Add Driver", towbookDriverId: "910021" });
  check("duplicate derived handle → duplicate error (no crash)", dup2.ok === false && dup2.code === "duplicate" && String(dup2.message).includes("qa-add-driver-910021"), JSON.stringify(dup2));
  const dup3 = await addContractorCore(ACTOR, { name: "QA Add Driver Email", towbookDriverId: "910022", email: "qa-add-driver-910001@towbook.driver" });
  check("duplicate email → duplicate error (no crash)", dup3.ok === false && dup3.code === "duplicate", JSON.stringify(dup3));
  const count = await q`SELECT COUNT(*)::int AS n FROM users WHERE towbook_driver_id IN ('910001','910021','910022')`;
  check("no duplicate rows created", Number(count[0].n) === 1, JSON.stringify(count));
}

/* =================== 4) status derivation from existing data =================== */
{
  // The driver has NOT signed in yet → not_signed_in, no last activity.
  const before = await listContractorsCore(ACTOR);
  const a = before.ok ? before.data.find((c) => c.towbookDriverId === "910001") : null;
  check("status not_signed_in before any sign-in", a?.status === "not_signed_in" && a?.lastActivityAt === null, JSON.stringify(a));

  // Sign-in = a driver-kind Towbook session row keyed to that driver.
  await q`INSERT INTO towbook_sessions(org_id, encrypted_session, status, session_kind, towbook_driver_id, updated_at)
    VALUES(${ORG}, ${await encryptSession(JSON.stringify({ cookies: "xtl=d", baseUrl: "https://app.towbook.com" }))}, 'connected', 'driver', '910001', NOW() - INTERVAL '2 hours')`;
  // A GPS ping 1 hour ago — the newest activity.
  await q`INSERT INTO driver_locations(id, org_id, driver_id, towbook_driver_id, job_id, latitude, longitude, accuracy, captured_at)
    VALUES(${`dl-${randomUUID()}`}, ${ORG}, ${a.id}, '910001', NULL, 41.2, -73.2, 20, NOW() - INTERVAL '1 hour')`;

  const after = await listContractorsCore(ACTOR);
  const b = after.ok ? after.data.find((c) => c.towbookDriverId === "910001") : null;
  check("status signed_in with driver session row", b?.status === "signed_in", JSON.stringify(b));
  check("last activity = newest of session/ping", b?.lastActivityAt != null && (Date.now() - Date.parse(b.lastActivityAt)) < 90 * 60 * 1000 && (Date.now() - Date.parse(b.lastActivityAt)) > 30 * 60 * 1000, JSON.stringify(b?.lastActivityAt));
  check("list includes login handle + towbook user id null", b?.loginHandle === "qa-add-driver-910001" && b?.towbookUserId === null, JSON.stringify(b));
}

/* ============================= 5) import upsert ============================= */
{
  // Roster: one NEW driver (910002), one to UPDATE (910004 — exists below),
  // one INACTIVE (endDate present), one with NO NAME, one non-object row, and
  // one whose derived handle collides with the pre-seeded QA Handle Taker
  // (910020). Import must skip all of those with reasons.
  const existingId = `qa-import-existing-${randomUUID()}`;
  await q`INSERT INTO users(id, name, email, password_hash, towbook_driver_id) VALUES(${existingId}, 'QA Old Name', ${`qa-import-existing-${randomUUID()}@lightning.test`}, 'x', '910004')`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${existingId}, 'contractor')`;

  const roster = [
    { id: 910002, name: "QA Import New" },
    { id: 910004, name: "QA Updated Name" },
    { id: 910005, name: "QA Inactive Person", endDate: "2025-01-01T00:00:00" },
    { id: 910006 },
    "garbage-row",
    { id: Number(HANDLE_TAG), name: "QA Handle Taker" },
  ];
  const { fetchImpl, calls } = makeFetch(roster);
  const r = await importContractorsCore(ACTOR, { fetchImpl });
  check("import ok", r.ok === true, JSON.stringify(r));
  const s = r.ok ? r.data : null;
  check("import counts: 1 new, 1 updated, 4 skipped", s && s.imported === 1 && s.updated === 1 && s.skipped.length === 4, JSON.stringify(s));
  const reasons = s ? s.skipped.map((x) => x.reason) : [];
  check("skips: inactive + missing_name + missing_driver_id + handle_conflict", ["inactive_in_towbook", "missing_name", "missing_driver_id", "login_handle_conflict"].every((reason) => reasons.includes(reason)), JSON.stringify(reasons));
  const newRow = await q`SELECT name, login_handle, email, towbook_driver_id FROM users WHERE towbook_driver_id='910002'`;
  check("imported row: name + derived handle/email", newRow.length === 1 && String(newRow[0].name) === "QA Import New" && String(newRow[0].login_handle) === "qa-import-new-910002" && String(newRow[0].email) === "qa-import-new-910002@towbook.driver", JSON.stringify(newRow));
  const updRow = await q`SELECT name FROM users WHERE towbook_driver_id='910004'`;
  check("existing row updated (name refreshed)", updRow.length === 1 && String(updRow[0].name) === "QA Updated Name", JSON.stringify(updRow));
  const noRows = await q`SELECT COUNT(*)::int AS n FROM users WHERE towbook_driver_id IN ('910005','910006')`;
  check("skipped rows not created", Number(noRows[0].n) === 0, JSON.stringify(noRows));
  const handleCount = await q`SELECT COUNT(*)::int AS n FROM users WHERE login_handle=${`qa-handle-taker-${HANDLE_TAG}`}`;
  check("handle-conflict row not duplicated (fixture only)", Number(handleCount[0].n) === 1, JSON.stringify(handleCount));
  check("import is GET-only (no non-GET /api/drivers calls)", calls.every((c) => c.method === "GET" && c.url.endsWith("/api/drivers")), JSON.stringify(calls));
  const aud = await q`SELECT detail FROM audit_log WHERE org_id=${ORG} AND action='contractor_imported'`;
  check("audit contractor_imported with counts", aud.length >= 1 && aud[aud.length - 1].detail?.imported === 1 && aud[aud.length - 1].detail?.updated === 1 && aud[aud.length - 1].detail?.skipped?.length === 4, JSON.stringify(aud));
}

/* ================ 6) import gates: no session / Towbook failure ================ */
{
  const noSession = await importContractorsCore({ orgId: ORG2, id: OWNER, role: "owner" }, { fetchImpl: makeFetch([]).fetchImpl });
  check("import without owner session → towbook_not_connected", noSession.ok === false && noSession.code === "towbook_not_connected", JSON.stringify(noSession));
  const failing = makeFetch([], { status: 500 });
  const failed = await importContractorsCore(ACTOR, { fetchImpl: failing.fetchImpl });
  check("import on Towbook 500 → towbook_failed", failed.ok === false && failed.code === "towbook_failed", JSON.stringify(failed));
  const wrongRole = await importContractorsCore(WRONG_ACTOR, { fetchImpl: makeFetch([]).fetchImpl });
  check("import: contractor actor → unauthorized (no fetch fired)", wrongRole.ok === false && wrongRole.code === "unauthorized", JSON.stringify(wrongRole));
  const badAdd = await addContractorCore(WRONG_ACTOR, { name: "QA Nope", towbookDriverId: "910030" });
  check("add: contractor actor → unauthorized", badAdd.ok === false && badAdd.code === "unauthorized", JSON.stringify(badAdd));
  // Admin role is allowed for all three.
  const adminList = await listContractorsCore(ADMIN_ACTOR);
  check("list: admin actor allowed", adminList.ok === true && adminList.data.length >= 2, JSON.stringify(adminList.ok ? adminList.data.length : adminList));
}

/* ============== 7) final list shape after everything ============== */
{
  const r = await listContractorsCore(ACTOR);
  check("final list ok", r.ok === true, JSON.stringify(r));
  const ids = r.ok ? r.data.map((c) => c.towbookDriverId) : [];
  check("final roster contains added + imported drivers", ["910001", "910002", "910004", "910008"].every((d) => ids.includes(d)), JSON.stringify(ids));
  check("final roster excludes skipped drivers", !ids.includes("910005") && !ids.includes("910006") && !ids.includes(HANDLE_TAG), JSON.stringify(ids));
}

/* ============ 8) BUG 2: owner/admin-kind session + LD portal session count ============ */
{
  // The owner logs into Towbook with their own DRIVER login; connectTowbook
  // stores that driver id on the owner-kind session row. The roster must count
  // ANY live session keyed to the user — driver-kind, owner/admin-kind Towbook
  // sessions (by towbook_driver_id), and live LD portal sessions (by user_id).
  const ownerSession = await q`SELECT org_id FROM towbook_sessions WHERE org_id=${ORG} AND session_kind='owner'`;
  const sessId = String(ownerSession[0].org_id);
  const userRow = await q`SELECT id FROM users WHERE towbook_driver_id='910008'`;
  const userId = String(userRow[0].id);

  // 8a. No session → not signed in (910008 has no driver-kind session yet).
  let list = await listContractorsCore(ACTOR);
  let row = list.ok ? list.data.find((c) => c.towbookDriverId === "910008") : null;
  check("BUG2: no session → not signed in", row?.status === "not_signed_in" && row?.lastActivityAt === null, JSON.stringify(row));

  // 8b. Owner-kind session linked to that driver → the roster row shows signed in.
  await q`UPDATE towbook_sessions SET towbook_driver_id='910008' WHERE org_id=${sessId}`;
  list = await listContractorsCore(ACTOR);
  row = list.ok ? list.data.find((c) => c.towbookDriverId === "910008") : null;
  check("BUG2: owner-kind session for the owner's user → roster row signed in", row?.status === "signed_in" && row?.lastActivityAt != null, JSON.stringify(row));

  // 8c. Unlink the owner session → back to not signed in (no other session).
  await q`UPDATE towbook_sessions SET towbook_driver_id=NULL WHERE org_id=${sessId}`;
  list = await listContractorsCore(ACTOR);
  row = list.ok ? list.data.find((c) => c.towbookDriverId === "910008") : null;
  check("BUG2: owner session unlinked → not signed in again", row?.status === "not_signed_in", JSON.stringify(row));

  // 8d. A live LD portal session (sessions row for the user) counts as signed in.
  const expiredId = `sess-${randomUUID()}`, liveId = `sess-${randomUUID()}`;
  await q`INSERT INTO sessions(id, user_id, expires_at) VALUES(${expiredId}, ${userId}, NOW() - INTERVAL '1 hour')`;
  list = await listContractorsCore(ACTOR);
  row = list.ok ? list.data.find((c) => c.towbookDriverId === "910008") : null;
  check("BUG2: expired LD session does not count", row?.status === "not_signed_in", JSON.stringify(row));
  await q`INSERT INTO sessions(id, user_id, expires_at) VALUES(${liveId}, ${userId}, NOW() + INTERVAL '1 day')`;
  list = await listContractorsCore(ACTOR);
  row = list.ok ? list.data.find((c) => c.towbookDriverId === "910008") : null;
  check("BUG2: live LD portal session → signed in", row?.status === "signed_in" && row?.lastActivityAt != null, JSON.stringify(row));
  // Cleanup: remove the test sessions (org cleanup cascades users, but keep the
  // session table tidy for the remove-flow section that checks invalidation).
  await q`DELETE FROM sessions WHERE id IN (${expiredId}, ${liveId})`;
}

/* ============ 9) BUG 1: removed (deactivated) contractor never appears; re-import skips ============ */
{
  const add = await addContractorCore(ACTOR, { name: "QA Remove Driver", towbookDriverId: "910100", email: "" });
  check("BUG1: add the driver to remove", add.ok === true, JSON.stringify(add));
  const driverId = "910100";
  const userRow = await q`SELECT id FROM users WHERE towbook_driver_id=${driverId}`;
  const userId = String(userRow[0].id);
  // Give them a live LD session so removal must invalidate it.
  await q`INSERT INTO sessions(id, user_id, expires_at) VALUES(${`sess-${randomUUID()}`}, ${userId}, NOW() + INTERVAL '1 day')`;

  // Mock Towbook for the remove push: editor partial → disable POST → verify.
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    const json = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body), json: async () => JSON.parse(JSON.stringify(body)), headers: { get: () => null } });
    const html = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => body, json: async () => body, headers: { get: () => null } });
    if (method === "GET" && u.includes("/ajax/settings/drivers/")) {
      return html(200, `<input name="RequestVerificationToken" type="hidden" value="TOK${driverId}" /><input name="Name" value="QA Remove Driver" />`);
    }
    if (method === "POST" && u.endsWith(`/api/drivers/${driverId}/disable`)) return json(200, { ok: true });
    if (method === "GET" && u.includes("/api/drivers/full?includeDeleted=true")) return json(200, [{ id: Number(driverId), name: "QA Remove Driver", deleted: true }]);
    throw new Error(`unexpected ${method} ${u}`);
  };

  const removed = await removeContractorCore(ACTOR, { contractorId: userId, reason: "qa test" }, { fetchImpl });
  check("BUG1: remove ok + verified on Towbook", removed.ok === true && removed.data.towbook.status === "verified" && removed.data.sessionsInvalidated >= 1, JSON.stringify(removed));

  // The roster MUST NOT contain the removed contractor (deactivated_at filter).
  let list = await listContractorsCore(ACTOR);
  const ids = list.ok ? list.data.map((c) => c.towbookDriverId) : [];
  check("BUG1: roster excludes the removed contractor", !ids.includes(driverId), JSON.stringify(ids));
  // Soft-deactivate: the users row still exists for history, sessions revoked.
  const dbRow = await q`SELECT deactivated_at FROM users WHERE id=${userId}`;
  check("BUG1: row soft-deactivated (never hard-deleted)", dbRow.length === 1 && dbRow[0].deactivated_at != null, JSON.stringify(dbRow));
  const sessLeft = await q`SELECT COUNT(*)::int AS n FROM sessions WHERE user_id=${userId}`;
  check("BUG1: sessions invalidated", Number(sessLeft[0].n) === 0, JSON.stringify(sessLeft));

  // Re-import the SAME driver from Towbook → must skip, never re-add.
  const m = makeFetch([{ id: Number(driverId), name: "QA Remove Driver" }]);
  const re = await importContractorsCore(ACTOR, { fetchImpl: m.fetchImpl });
  const s = re.ok ? re.data : null;
  check("BUG1: re-import skips the deactivated driver", s && s.imported === 0 && s.skipped.some((x) => String(x.towbookDriverId) === driverId && x.reason === "deactivated_in_lightning_dispatch"), JSON.stringify(s));
  const still = await q`SELECT COUNT(*)::int AS n, MAX(deactivated_at) AS d FROM users WHERE towbook_driver_id=${driverId}`;
  check("BUG1: re-import never re-adds / never re-activates", Number(still[0].n) === 1 && still[0].d != null, JSON.stringify(still));
  // Records-on-demand (owner batch 2026-08-12): removed contractors stay hidden
  // by default; includeRemoved lists them with removedAt so the UI can label.
  const plainList = await listContractorsCore(ACTOR);
  const allList = await listContractorsCore(ACTOR, { includeRemoved: true });
  check("includeRemoved: removed hidden by default", plainList.ok === true && !plainList.data.some((c) => String(c.towbookDriverId) === driverId), JSON.stringify(plainList.ok ? plainList.data.map((c) => c.towbookDriverId) : plainList));
  const incRow = allList.ok ? allList.data.find((c) => String(c.towbookDriverId) === driverId) : null;
  check("includeRemoved: removed listed on demand with removedAt set", incRow != null && incRow.removedAt != null, JSON.stringify(incRow));
  // Legacy role normalization (owner batch 2026-08-12): every 'manager'
  // membership reads as 'owner' — all managers get owner access.
  const { normalizeRole } = await import("./src/data/auth-server.ts");
  check("normalizeRole: manager normalizes to owner", normalizeRole("manager") === "owner" && normalizeRole("owner") === "owner" && normalizeRole("contractor") === "contractor" && normalizeRole("dispatcher") === "dispatcher" && normalizeRole("admin") === "admin", JSON.stringify(normalizeRole("manager")));
  // BUG 3 data source: the Performance tab count = active roster length.
  check("BUG3: performance roster count = listContractorsCore length (active only)", list.ok === true && !list.data.some((c) => c.removedAt), JSON.stringify(list.ok ? list.data.map((c) => c.towbookDriverId) : list));
}

/* ================================ summary + cleanup ================================ */
const failed = checks.filter(([, ok]) => !ok);
console.log(`contractor-management.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }

// Prove cleanup: deleting the QA orgs cascades every row they created; users
// that were members are deleted explicitly (users has no org FK). Org NAME is
// 'qa contractor' (space) — the hyphenated ids are the QA org ids.
const memberIds = await q`SELECT DISTINCT m.user_id FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa contractor%'`;
for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa contractor%'`) {
  assertQaOrg(org.id, org.name);
  await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
}
for (const m of memberIds) await q`DELETE FROM users WHERE id=${m.user_id}`.catch(() => {});
// Fixture users without memberships (handle/email-conflict fixtures).
await q`DELETE FROM users WHERE email LIKE 'qa-contractor-%@lightning.test'`.catch(() => {});
// Safety net for any row created between the user insert and its membership.
await q`DELETE FROM users WHERE email LIKE '%@towbook.driver' AND name LIKE 'QA %'`.catch(() => {});

const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa contractor%') AS orgs,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE 'qa-contractor-%@lightning.test') AS fixture_users,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE '%@towbook.driver' AND name LIKE 'QA %') AS api_users,
  (SELECT COUNT(*)::int FROM audit_log a JOIN organizations o ON o.id=a.org_id WHERE o.name LIKE 'qa contractor%') AS audit,
  (SELECT COUNT(*)::int FROM towbook_sessions s JOIN organizations o ON o.id=s.org_id WHERE o.name LIKE 'qa contractor%') AS sessions,
  (SELECT COUNT(*)::int FROM driver_locations d JOIN organizations o ON o.id=d.org_id WHERE o.name LIKE 'qa contractor%') AS locations,
  (SELECT COUNT(*)::int FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa contractor%') AS members`;
const z = Object.values(leftover[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) { console.error("FAIL: QA cleanup left rows behind"); process.exit(1); }
console.log("contractor-management.test.mjs: cleanup verified — zero QA rows left");
