// DB safety (2026-08-12): org deletes guarded by assertQaOrg — see src/data/db-guard.ts + /home/team/shared/db-safety-rules.md.
// Hermetic contractor edit/remove tests (2026-08-11, owner-directed "Contractor
// edit/remove with Towbook propagation"): owner edits a contractor's name/email
// (LD users row + audit 'contractor_updated' + Towbook push via the driver
// editor form POST /ajax/Settings/Drivers/Details when supported — verified
// read-back, escalation on genuine failure, clear degrade when unsupported),
// and removes a contractor (soft-deactivate deactivated_at — NEVER a hard
// delete; sessions invalidated so the contractor can't authenticate or be
// dispatched; Towbook POST /api/drivers/{id}/disable when supported; re-import
// never re-adds). Real network calls never happen: the Towbook editor/roster/
// disable endpoints are an injectable mock fetchImpl that records every call.
// DB-backed against throwaway QA orgs deleted at the end (zero rows left).
//   DATABASE_URL=... bun contractor-edit-remove.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 11).toString("base64");
const {
  editContractorCore,
  removeContractorCore,
  addContractorCore,
  importContractorsCore,
  listContractorsCore,
} = await import("./src/data/contractor-management-core.ts");
const { isDriverDeactivated } = await import("./src/data/driver-gps-core.ts");
const { encryptSession } = await import("./src/data/towbook-key.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

const ORG = `qa-edit-${randomUUID()}`;
const ORG2 = `qa-edit2-${randomUUID()}`; // no owner session → skip gates
const OWNER = `qa-edit-owner-${randomUUID()}`;
const ADMIN = `qa-edit-admin-${randomUUID()}`;
const CONTRACTOR = `qa-edit-driver-${randomUUID()}`; // wrong-role actor
const OTHER_USER = `qa-edit-other-${randomUUID()}`; // email-conflict fixture
const ACTOR = { orgId: ORG, id: OWNER, role: "owner" };
const ADMIN_ACTOR = { orgId: ORG, id: ADMIN, role: "admin" };
const WRONG_ACTOR = { orgId: ORG, id: CONTRACTOR, role: "contractor" };

const DRIVER_EDIT = "921001"; // edit happy path
const DRIVER_EMAIL = "921002"; // real-email push
const DRIVER_UNSUP = "921003"; // editor 404 → unsupported
const DRIVER_REJ = "921004"; // POST 500 → escalate
const DRIVER_REMOVE = "921005"; // remove happy path
const DRIVER_REMOVE_UNSUP = "921006"; // disable 404 → unsupported
const DRIVER_REMOVE_REJ = "921007"; // disable 500 → escalate + local stands
const DRIVER_SKIP = "921008"; // no owner session (ORG2)

/** A realistic driver-editor partial (the shape GET /ajax/settings/drivers/{id}
 *  returns): hidden antiforgery token + the Details form fields incl. Name,
 *  Email, Id, UserId, a select and a textarea. */
function editorHtml({ driverId, name, email, userId = "990001", notes = "some notes" }) {
  return `<form action="/ajax/Settings/Drivers/Details" id="tbForm" method="post">
<input name="RequestVerificationToken" type="hidden" value="TOK${driverId}" />
<input id="Id" name="Id" type="hidden" value="${driverId}" />
<input id="UserId" name="UserId" type="hidden" value="${userId}" />
<input id="Name" name="Name" type="text" value="${name}" />
<input id="Email" name="Email" type="text" value="${email}" />
<input id="StartDate" name="StartDate" type="text" value="2025-01-01" />
<input id="OperateHeavyEquipment" name="OperateHeavyEquipment" type="checkbox" />
<select id="LicenseClass" name="LicenseClass"><option value="3" selected>Class C</option></select>
<textarea name="Notes">${notes}</textarea>
</form>`;
}

/** Mock Towbook for the edit/remove write flows. Routes by method+URL;
 *  stateful roster (the edit verify + re-import read it). Records calls. */
function makeFetch({ roster, deleted = new Set(), failEditor = null, failDetails = null, failDisable = null, editorStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    calls.push({ method, url: u, headers: init.headers || {}, body: init.body || null });
    // tbRequest reads res.headers.get("location") for session-expiry redirects.
    const hdrs = (loc = null) => ({ get: (k) => (String(k).toLowerCase() === "location" ? loc : null) });
    const json = (s, b) => ({ status: s, ok: s >= 200 && s < 300, headers: hdrs(), text: async () => JSON.stringify(b), json: async () => JSON.parse(JSON.stringify(b)) });
    const html = (s, h) => ({ status: s, ok: s >= 200 && s < 300, headers: hdrs(), text: async () => h, json: async () => ({}) });
    const mEditor = u.match(/\/ajax\/settings\/drivers\/(\d+)$/);
    if (mEditor) {
      if (failEditor != null) return html(failEditor, "<html>gone</html>");
      const id = mEditor[1];
      const dr = (roster ?? []).find((d) => String(d.id) === id) ?? { id: Number(id), name: "QA Driver " + id, linkedUserId: 990000 + Number(id) };
      const isDel = deleted.has(id);
      return html(editorStatus, editorHtml({ driverId: id, name: isDel ? dr.name : dr.name, email: `${id}@mock.towbook` }));
    }
    if (method === "POST" && u.endsWith("/ajax/Settings/Drivers/Details")) {
      if (failDetails != null) return json(failDetails, { error: "boom" });
      // Apply the edit to the stateful roster so the read-back verify sees it.
      const params = new URLSearchParams(String(init.body || ""));
      const id = params.get("Id") ?? "";
      const row = (roster ?? []).find((d) => String(d.id) === id);
      if (row && params.get("Name")) row.name = params.get("Name");
      if (row && params.get("Email")) row.email = params.get("Email");
      return json(200, { ok: true });
    }
    const mDisable = u.match(/\/api\/drivers\/(\d+)\/disable$/);
    if (mDisable) {
      if (failDisable != null) return json(failDisable, { error: "boom" });
      deleted.add(mDisable[1]);
      return json(200, { ok: true });
    }
    if (method === "GET" && u.includes("/api/drivers/full?includeDeleted=true")) {
      const rows = (roster ?? []).map((d) => ({ ...d, deleted: deleted.has(String(d.id)) }));
      return json(200, rows);
    }
    if (method === "GET" && u.endsWith("/api/drivers")) {
      // Deleted drivers vanish from the base roster (server-side filter).
      return json(200, (roster ?? []).filter((d) => !deleted.has(String(d.id))));
    }
    console.error('MOCK UNMATCHED:', method, u); return { status: 500, ok: false, headers: { get: () => null }, text: async () => 'unmatched', json: async () => ({}) };
  };
  return { fetchImpl, calls, deleted };
}
const posts = (calls) => calls.filter((c) => c.method === "POST");
const gets = (calls) => calls.filter((c) => c.method === "GET");

async function setup() {
  await ensureSchema();
  for (const [org, owner, admin, contractor] of [
    [ORG, OWNER, ADMIN, CONTRACTOR],
    [ORG2, `qa-edit2-owner-${randomUUID()}`, null, null],
  ]) {
    await q`INSERT INTO organizations(id, name) VALUES(${org}, 'qa edit-remove')`;
    await q`INSERT INTO users(id, name, email, password_hash) VALUES(${owner}, 'QA Edit Owner', ${`qa-edit-owner-${randomUUID()}@lightning.test`}, 'x')`;
    await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${org}, ${owner}, 'owner')`;
    if (admin) {
      await q`INSERT INTO users(id, name, email, password_hash) VALUES(${admin}, 'QA Edit Admin', ${`qa-edit-admin-${randomUUID()}@lightning.test`}, 'x')`;
      await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${org}, ${admin}, 'admin')`;
    }
    if (contractor) {
      await q`INSERT INTO users(id, name, email, password_hash) VALUES(${contractor}, 'QA Edit Driver', ${`qa-edit-driver-${randomUUID()}@lightning.test`}, 'x')`;
      await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${org}, ${contractor}, 'contractor')`;
    }
    if (org === ORG) {
      await q`INSERT INTO towbook_sessions(org_id, encrypted_session, status, session_kind)
        VALUES(${org}, ${await encryptSession(JSON.stringify({ cookies: "xtl=fake", baseUrl: "https://app.towbook.com" }))}, 'connected', 'owner')`;
      await q`INSERT INTO users(id, name, email, password_hash) VALUES(${OTHER_USER}, 'QA Other User', ${`qa-edit-other-${randomUUID()}@lightning.test`}, 'x')`;
    }
  }
  // The roster the mocks serve (the 8 QA drivers above).
  const ids = [DRIVER_EDIT, DRIVER_EMAIL, DRIVER_UNSUP, DRIVER_REJ, DRIVER_REMOVE, DRIVER_REMOVE_UNSUP, DRIVER_REMOVE_REJ, DRIVER_SKIP];
  return ids.map((id) => ({ id: Number(id), name: `QA Driver ${id}`, linkedUserId: 990000 + Number(id) }));
}

const ROSTER = await setup();
const rosterFor = (ids) => ROSTER.filter((d) => ids.includes(String(d.id)));
const ROSTER_ALL = rosterFor([DRIVER_EDIT, DRIVER_EMAIL, DRIVER_UNSUP, DRIVER_REJ, DRIVER_REMOVE, DRIVER_REMOVE_UNSUP, DRIVER_REMOVE_REJ]);

// Pre-add the seven ORG drivers via addContractorCore (the owner's normal flow).
const added = {};
for (const d of ROSTER_ALL) {
  const r = await addContractorCore(ACTOR, { name: d.name, towbookDriverId: String(d.id), email: "" });
  check(`add ${d.id} ok`, r.ok === true, JSON.stringify(r));
  added[d.id] = r.ok ? r.data.id : "";
}
// A driver with a real (non-derived) email.
const realEmail = `qa-real-${DRIVER_EMAIL}@lightning.test`;
await q`UPDATE users SET email=${realEmail} WHERE id=${added[DRIVER_EMAIL]}`;

/* ==================== 1) edit happy path: local + Towbook verified ==================== */
{
  const m = makeFetch({ roster: ROSTER_ALL });
  const r = await editContractorCore(ACTOR, { contractorId: added[DRIVER_EDIT], name: "QA Edited Name", email: "qa-edited@lightning.test" }, { fetchImpl: m.fetchImpl });
  check("edit ok", r.ok === true, JSON.stringify(r));
  const t = r.ok ? r.data.towbook : null;
  check("edit towbook verified", t && t.status === "verified" && t.pushed === true && t.escalated === false, JSON.stringify(t));
  const dbRow = await q`SELECT name, email FROM users WHERE id=${added[DRIVER_EDIT]}`;
  check("local row updated (name + email)", dbRow.length === 1 && String(dbRow[0].name) === "QA Edited Name" && String(dbRow[0].email) === "qa-edited@lightning.test", JSON.stringify(dbRow));
  const sequence = m.calls.map((c) => `${c.method} ${c.url.replace("https://app.towbook.com", "")}`);
  check("request sequence: editor GET → Details POST → roster verify",
    sequence.length >= 3 && sequence[0].startsWith("GET /ajax/settings/drivers/") && sequence[1] === "POST /ajax/Settings/Drivers/Details" && sequence[sequence.length - 1].endsWith("/api/drivers"),
    JSON.stringify(sequence));
  const post = posts(m.calls)[0];
  check("Details POST is form-urlencoded with Name overridden + token in body",
    String(post.headers["content-type"]).includes("application/x-www-form-urlencoded") &&
    String(post.body).includes("Name=QA%20Edited%20Name") && String(post.body).includes("Email=qa-edited%40lightning.test") && String(post.body).includes("RequestVerificationToken=TOK" + DRIVER_EDIT),
    JSON.stringify({ headers: post.headers, body: post.body }));
  check("Details POST preserved unrelated fields (StartDate/Notes/LicenseClass)",
    String(post.body).includes("StartDate=2025-01-01") && String(post.body).includes("Notes=some%20notes") && String(post.body).includes("LicenseClass=3"),
    String(post.body));
  const aud = await q`SELECT detail, actor_role FROM audit_log WHERE org_id=${ORG} AND action='contractor_updated' ORDER BY occurred_at DESC LIMIT 1`;
  check("audit contractor_updated (owner, from/to detail)",
    aud.length === 1 && String(aud[0].actor_role) === "owner" && aud[0].detail?.from?.name === "QA Driver " + DRIVER_EDIT && aud[0].detail?.to?.name === "QA Edited Name",
    JSON.stringify(aud));
  const pushAud = await q`SELECT detail FROM audit_log WHERE org_id=${ORG} AND action='contractor_towbook_push' ORDER BY occurred_at DESC LIMIT 1`;
  check("audit contractor_towbook_push with verified status", pushAud.length === 1 && pushAud[0].detail?.status === "verified", JSON.stringify(pushAud));
}

/* ============ 2) email push rules: derived email never pushed; real pushed ============ */
{
  const m = makeFetch({ roster: ROSTER_ALL });
  // Derived @towbook.driver email (the default for imported drivers) → only Name pushed.
  const r1 = await editContractorCore(ACTOR, { contractorId: added[DRIVER_EDIT], name: "QA Rename Only", email: "qa-add-driver-921001@towbook.driver" }, { fetchImpl: m.fetchImpl });
  check("edit with derived email ok + verified", r1.ok === true && r1.data.towbook.status === "verified", JSON.stringify(r1));
  const p1 = posts(m.calls)[0];
  check("derived @towbook.driver email NOT sent to Towbook (Name only)",
    String(p1.body).includes("Name=QA%20Rename%20Only") && !String(p1.body).includes("towbook.driver"), String(p1.body));
  // Real email → pushed.
  const m2 = makeFetch({ roster: ROSTER_ALL });
  const r2 = await editContractorCore(ACTOR, { contractorId: added[DRIVER_EMAIL], name: "QA Email Push", email: "qa-new-real@lightning.test" }, { fetchImpl: m2.fetchImpl });
  check("edit real email ok + verified", r2.ok === true && r2.data.towbook.status === "verified", JSON.stringify(r2));
  const p2 = posts(m2.calls)[0];
  check("real email sent to Towbook", String(p2.body).includes("Email=qa-new-real%40lightning.test"), String(p2.body));
}

/* ==================== 3) edit unsupported (editor 404) → local stands, notice, no escalation ==================== */
{
  const m = makeFetch({ roster: ROSTER_ALL, failEditor: 404 });
  const r = await editContractorCore(ACTOR, { contractorId: added[DRIVER_UNSUP], name: "QA Unsupported Edit", email: "" }, { fetchImpl: m.fetchImpl });
  check("edit unsupported: local ok, towbook unsupported", r.ok === true && r.data.towbook.status === "unsupported" && r.data.towbook.pushed === false && r.data.towbook.escalated === false, JSON.stringify(r));
  check("unsupported notice names Towbook", String(r.data.towbook.notice).includes("Towbook does not support"), r.data.towbook.notice);
  const dbRow = await q`SELECT name FROM users WHERE id=${added[DRIVER_UNSUP]}`;
  check("local update stands despite unsupported", String(dbRow[0].name) === "QA Unsupported Edit", JSON.stringify(dbRow));
  const escal = await q`SELECT COUNT(*)::int AS n FROM ai_dispatcher_decisions WHERE org_id=${ORG} AND decision='escalated_contractor_push_failed'`;
  check("unsupported → NO escalation row", Number(escal[0].n) === 0, JSON.stringify(escal));
}

/* ============ 4) edit rejected (POST 500) → local stands, escalation with evidence ============ */
{
  const m = makeFetch({ roster: ROSTER_ALL, failDetails: 500 });
  const r = await editContractorCore(ACTOR, { contractorId: added[DRIVER_REJ], name: "QA Rejected Edit", email: "" }, { fetchImpl: m.fetchImpl });
  check("edit rejected: local ok, towbook failed + escalated", r.ok === true && r.data.towbook.status === "failed" && r.data.towbook.escalated === true, JSON.stringify(r));
  const dbRow = await q`SELECT name FROM users WHERE id=${added[DRIVER_REJ]}`;
  check("local update stands despite rejection", String(dbRow[0].name) === "QA Rejected Edit", JSON.stringify(dbRow));
  const retries = posts(m.calls).filter((c) => c.url.endsWith("/ajax/Settings/Drivers/Details"));
  check("one retry on failure (2 POSTs)", retries.length === 2, JSON.stringify(retries.length));
  const escal = await q`SELECT call_request_id, reason, raw_response FROM ai_dispatcher_decisions WHERE org_id=${ORG} AND decision='escalated_contractor_push_failed' AND call_request_id=${`contractor-push-edit-${DRIVER_REJ}`}`;
  check("escalation row with dedupe key + evidence",
    escal.length === 1 && String(escal[0].reason).includes("rejected") && escal[0].raw_response?.attempts?.length >= 2, JSON.stringify(escal));
  // Same failure again → ON CONFLICT DO NOTHING (no spam).
  await editContractorCore(ACTOR, { contractorId: added[DRIVER_REJ], name: "QA Rejected Again", email: "" }, { fetchImpl: m.fetchImpl });
  const dup = await q`SELECT COUNT(*)::int AS n FROM ai_dispatcher_decisions WHERE org_id=${ORG} AND call_request_id=${`contractor-push-edit-${DRIVER_REJ}`}`;
  check("escalation dedupe (same key not duplicated)", Number(dup[0].n) === 1, JSON.stringify(dup));
}

/* ============ 4b) edit with expired session (302 → login) → local stands, escalate ============ */
{
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ method: init.method || "GET", url: String(url) });
    return { status: 302, ok: false, headers: { get: (k) => (String(k).toLowerCase() === "location" ? "/Security/Login.aspx" : null) }, text: async () => "", json: async () => ({}) };
  };
  const r = await editContractorCore(ACTOR, { contractorId: added[DRIVER_EDIT], name: "QA Expired Session", email: "" }, { fetchImpl });
  check("edit expired session: local stands, towbook failed + escalated", r.ok === true && r.data.towbook.status === "failed" && r.data.towbook.escalated === true && String(r.data.towbook.notice).includes("expired"), JSON.stringify(r.data.towbook));
  const dbRow = await q`SELECT name FROM users WHERE id=${added[DRIVER_EDIT]}`;
  check("local update stands with expired session", String(dbRow[0].name) === "QA Expired Session", JSON.stringify(dbRow));
  const escal = await q`SELECT COUNT(*)::int AS n FROM ai_dispatcher_decisions WHERE org_id=${ORG} AND call_request_id=${`contractor-push-edit-${DRIVER_EDIT}`}`;
  check("expired session → escalation row", Number(escal[0].n) === 1, JSON.stringify(escal));
  await q`DELETE FROM ai_dispatcher_decisions WHERE org_id=${ORG} AND call_request_id=${`contractor-push-edit-${DRIVER_EDIT}`}`.catch(() => {});
}

/* ==================== 5) edit guard rails: roles, not found, duplicates, removed ==================== */
{
  const wrong = await editContractorCore(WRONG_ACTOR, { contractorId: added[DRIVER_EDIT], name: "QA Nope" });
  check("edit: contractor actor → unauthorized", wrong.ok === false && wrong.code === "unauthorized", JSON.stringify(wrong));
  const admin = await editContractorCore(ADMIN_ACTOR, { contractorId: added[DRIVER_EMAIL], name: "QA Admin Edit", email: "" }, { fetchImpl: makeFetch({ roster: ROSTER_ALL }).fetchImpl });
  check("edit: admin actor allowed", admin.ok === true, JSON.stringify(admin));
  const missing = await editContractorCore(ACTOR, { contractorId: `qa-nope-${randomUUID()}`, name: "QA Nope" });
  check("edit: unknown contractor → not_found", missing.ok === false && missing.code === "not_found", JSON.stringify(missing));
  const badName = await editContractorCore(ACTOR, { contractorId: added[DRIVER_EDIT], name: "  " });
  check("edit: empty name → invalid_input", badName.ok === false && badName.code === "invalid_input", JSON.stringify(badName));
  const badEmail = await editContractorCore(ACTOR, { contractorId: added[DRIVER_EDIT], name: "QA X", email: "not-an-email" });
  check("edit: invalid email → invalid_input", badEmail.ok === false && badEmail.code === "invalid_input", JSON.stringify(badEmail));
  const otherId = await q`SELECT id FROM users WHERE email LIKE 'qa-edit-other-%' LIMIT 1`;
  const other = String(otherId[0].id);
  await q`UPDATE users SET email='qa-taken@lightning.test' WHERE id=${other}`;
  const dupEmail = await editContractorCore(ACTOR, { contractorId: added[DRIVER_EDIT], name: "QA Dup", email: "qa-taken@lightning.test" });
  check("edit: email in use by another → duplicate", dupEmail.ok === false && dupEmail.code === "duplicate", JSON.stringify(dupEmail));
  // Remove DRIVER_UNSUP first (used by the remove tests below), then try to edit it.
  await removeContractorCore(ACTOR, { contractorId: added[DRIVER_UNSUP], reason: "leave" }, { fetchImpl: makeFetch({ roster: ROSTER_ALL, deleted: new Set([DRIVER_UNSUP]) }).fetchImpl });
  const removedEdit = await editContractorCore(ACTOR, { contractorId: added[DRIVER_UNSUP], name: "QA Nope", email: "" });
  check("edit: removed contractor → invalid_input", removedEdit.ok === false && removedEdit.code === "invalid_input" && String(removedEdit.message).includes("removed"), JSON.stringify(removedEdit));
}

/* ==================== 6) remove happy path: deactivate + invalidate + Towbook verified ==================== */
{
  // Give the driver a live LD session + a stored driver Towbook session first.
  await q`INSERT INTO sessions(id, user_id, expires_at) VALUES(${`sess-${randomUUID()}`}, ${added[DRIVER_REMOVE]}, NOW() + INTERVAL '30 days')`;
  await q`INSERT INTO sessions(id, user_id, expires_at) VALUES(${`sess2-${randomUUID()}`}, ${added[DRIVER_REMOVE]}, NOW() + INTERVAL '30 days')`;
  await q`INSERT INTO towbook_sessions(org_id, encrypted_session, status, session_kind, towbook_driver_id)
    VALUES(${ORG}, ${await encryptSession(JSON.stringify({ cookies: "xtl=d", baseUrl: "https://app.towbook.com" }))}, 'connected', 'driver', ${DRIVER_REMOVE})`;
  const before = await q`SELECT COUNT(*)::int AS n FROM sessions WHERE user_id=${added[DRIVER_REMOVE]}`;
  check("fixture: 2 live LD sessions", Number(before[0].n) === 2, JSON.stringify(before));

  const m = makeFetch({ roster: ROSTER_ALL });
  const r = await removeContractorCore(ACTOR, { contractorId: added[DRIVER_REMOVE], reason: "left company" }, { fetchImpl: m.fetchImpl });
  check("remove ok", r.ok === true, JSON.stringify(r));
  check("remove towbook verified", r.data.towbook.status === "verified" && r.data.towbook.pushed === true, JSON.stringify(r.data.towbook));
  check("remove invalidated both LD sessions", r.data.sessionsInvalidated === 2, JSON.stringify(r.data.sessionsInvalidated));
  const dbRow = await q`SELECT deactivated_at FROM users WHERE id=${added[DRIVER_REMOVE]}`;
  check("row soft-deactivated (not deleted)", dbRow.length === 1 && dbRow[0].deactivated_at != null, JSON.stringify(dbRow));
  const stillThere = await q`SELECT COUNT(*)::int AS n FROM users WHERE id=${added[DRIVER_REMOVE]}`;
  check("users row kept (history intact)", Number(stillThere[0].n) === 1, JSON.stringify(stillThere));
  const ldSess = await q`SELECT COUNT(*)::int AS n FROM sessions WHERE user_id=${added[DRIVER_REMOVE]}`;
  check("LD sessions all deleted", Number(ldSess[0].n) === 0, JSON.stringify(ldSess));
  const tbSess = await q`SELECT COUNT(*)::int AS n FROM towbook_sessions WHERE org_id=${ORG} AND session_kind='driver' AND towbook_driver_id=${DRIVER_REMOVE}`;
  check("stored driver Towbook session deleted", Number(tbSess[0].n) === 0, JSON.stringify(tbSess));
  check("isDriverDeactivated → true (excluded from dispatch/sign-in)", (await isDriverDeactivated(ORG, DRIVER_REMOVE)) === true);
  const disable = posts(m.calls).find((c) => c.url.endsWith(`/api/drivers/${DRIVER_REMOVE}/disable`));
  check("disable POST fired with antiforgery header", Boolean(disable) && String(disable.headers.RequestVerificationToken).startsWith("TOK"), JSON.stringify({ disable }));
  const aud = await q`SELECT detail FROM audit_log WHERE org_id=${ORG} AND action='contractor_removed' ORDER BY occurred_at DESC LIMIT 1`;
  check("audit contractor_removed with reason + sessions + towbook outcome",
    aud.length === 1 && aud[0].detail?.reason === "left company" && aud[0].detail?.sessionsInvalidated === 2 && aud[0].detail?.towbook?.status === "verified",
    JSON.stringify(aud));
  const list = await listContractorsCore(ACTOR);
  const removedRow = list.ok ? list.data.find((c) => c.id === added[DRIVER_REMOVE]) : null;
  check("list excludes the removed contractor entirely (owner-directed 2026-08-11: removed drivers must not display)", removedRow === undefined && Array.isArray(list.data), JSON.stringify(removedRow));
}

/* ============ 7) remove unsupported (disable 404) → local removal stands, notice only ============ */
{
  const m = makeFetch({ roster: ROSTER_ALL, failDisable: 404 });
  const r = await removeContractorCore(ACTOR, { contractorId: added[DRIVER_REMOVE_UNSUP] }, { fetchImpl: m.fetchImpl });
  check("remove unsupported: local ok, towbook unsupported, not escalated", r.ok === true && r.data.towbook.status === "unsupported" && r.data.towbook.escalated === false, JSON.stringify(r));
  check("unsupported notice names Towbook", String(r.data.towbook.notice).includes("Towbook does not support"), r.data.towbook.notice);
  const dbRow = await q`SELECT deactivated_at FROM users WHERE id=${added[DRIVER_REMOVE_UNSUP]}`;
  check("local deactivation stands", dbRow.length === 1 && dbRow[0].deactivated_at != null, JSON.stringify(dbRow));
  check("isDriverDeactivated true (LD side always enforced)", (await isDriverDeactivated(ORG, DRIVER_REMOVE_UNSUP)) === true);
  const escal = await q`SELECT COUNT(*)::int AS n FROM ai_dispatcher_decisions WHERE org_id=${ORG} AND call_request_id=${`contractor-push-remove-${DRIVER_REMOVE_UNSUP}`}`;
  check("unsupported remove → NO escalation", Number(escal[0].n) === 0, JSON.stringify(escal));
}

/* ============ 8) remove rejected (disable 500) → local stands + escalation ============ */
{
  const m = makeFetch({ roster: ROSTER_ALL, failDisable: 500 });
  const r = await removeContractorCore(ACTOR, { contractorId: added[DRIVER_REMOVE_REJ] }, { fetchImpl: m.fetchImpl });
  check("remove rejected: local ok, towbook failed + escalated", r.ok === true && r.data.towbook.status === "failed" && r.data.towbook.escalated === true, JSON.stringify(r.data.towbook));
  const dbRow = await q`SELECT deactivated_at FROM users WHERE id=${added[DRIVER_REMOVE_REJ]}`;
  check("local deactivation stands despite rejection", dbRow[0].deactivated_at != null, JSON.stringify(dbRow));
  const escal = await q`SELECT call_request_id, reason FROM ai_dispatcher_decisions WHERE org_id=${ORG} AND call_request_id=${`contractor-push-remove-${DRIVER_REMOVE_REJ}`}`;
  check("remove escalation row with dedupe key", escal.length === 1 && String(escal[0].reason).includes("rejected"), JSON.stringify(escal));
}

/* ============ 9) remove guard rails: roles, already-removed, no-session skip ============ */
{
  const wrong = await removeContractorCore(WRONG_ACTOR, { contractorId: added[DRIVER_EDIT] });
  check("remove: contractor actor → unauthorized", wrong.ok === false && wrong.code === "unauthorized", JSON.stringify(wrong));
  const missing = await removeContractorCore(ACTOR, { contractorId: `qa-nope-${randomUUID()}` });
  check("remove: unknown contractor → not_found", missing.ok === false && missing.code === "not_found", JSON.stringify(missing));
  const twice = await removeContractorCore(ACTOR, { contractorId: added[DRIVER_REMOVE] }, { fetchImpl: makeFetch({ roster: ROSTER_ALL }).fetchImpl });
  check("remove: already removed → invalid_input (no crash)", twice.ok === false && twice.code === "invalid_input", JSON.stringify(twice));
  // ORG2: no owner session → the removal still happens locally, Towbook skipped.
  const otherOwner = await q`SELECT id FROM users WHERE org_id='' OR id=${`qa-edit2-owner`}`.catch(() => []);
  const org2Owner = (await q`SELECT u.id FROM users u JOIN organization_memberships m ON m.org_id=${ORG2} AND m.user_id=u.id AND m.role='owner' LIMIT 1`)[0]?.id;
  const org2Add = await addContractorCore({ orgId: ORG2, id: String(org2Owner), role: "owner" }, { name: "QA Skip Driver", towbookDriverId: DRIVER_SKIP, email: "" });
  check("ORG2 add ok (no owner session)", org2Add.ok === true, JSON.stringify(org2Add));
  const r = await removeContractorCore({ orgId: ORG2, id: String(org2Owner), role: "owner" }, { contractorId: org2Add.data.id }, { fetchImpl: makeFetch({ roster: ROSTER_ALL }).fetchImpl });
  check("remove without owner session: local stands, towbook skipped", r.ok === true && r.data.towbook.status === "skipped" && String(r.data.towbook.notice).includes("Towbook isn't connected"), JSON.stringify(r.data.towbook));
}

/* ============ 10) re-import after remove keeps the contractor removed ============ */
{
  // Simulate the real post-disable world: DRIVER_REMOVE is gone from the base
  // roster (deleted server-side). Import must NOT re-add it; the deactivated
  // row stays untouched.
  const postRoster = ROSTER_ALL.filter((d) => ![...m_removedIds()].includes(String(d.id)));
  const m = makeFetch({ roster: postRoster, deleted: new Set(m_removedIds()) });
  const r = await importContractorsCore(ACTOR, { fetchImpl: m.fetchImpl });
  check("import after remove ok", r.ok === true, JSON.stringify(r));
  const dbRow = await q`SELECT deactivated_at FROM users WHERE id=${added[DRIVER_REMOVE]}`;
  check("removed contractor still deactivated after re-import (never re-added)", dbRow.length === 1 && dbRow[0].deactivated_at != null, JSON.stringify(dbRow));
  const count = await q`SELECT COUNT(*)::int AS n FROM users WHERE towbook_driver_id=${DRIVER_REMOVE}`;
  check("exactly one row for the removed driver (no duplicate from import)", Number(count[0].n) === 1, JSON.stringify(count));
}
function m_removedIds() {
  return [DRIVER_REMOVE, DRIVER_REMOVE_UNSUP, DRIVER_REMOVE_REJ, DRIVER_UNSUP];
}

/* ================================ summary + cleanup ================================ */
const failed = checks.filter(([, ok]) => !ok);
console.log(`contractor-edit-remove.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }

// Cleanup: delete the QA orgs (cascades) + their member users + fixtures.
const memberIds = await q`SELECT DISTINCT m.user_id FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa edit-remove%'`;
for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa edit-remove%'`) {
  assertQaOrg(org.id, org.name);
  await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
}
for (const m of memberIds) await q`DELETE FROM users WHERE id=${m.user_id}`.catch(() => {});
await q`DELETE FROM users WHERE email LIKE 'qa-edit-%@lightning.test' OR email LIKE 'qa-edited@%' OR email LIKE 'qa-edit2-%@lightning.test' OR email LIKE 'qa-taken@%'`.catch(() => {});
await q`DELETE FROM users WHERE email LIKE '%@towbook.driver' AND name LIKE 'QA %'`.catch(() => {});
await q`DELETE FROM users WHERE email LIKE 'qa-real-%@lightning.test'`.catch(() => {});

const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa edit-remove%') AS orgs,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE 'qa-edit-%@lightning.test') AS fixture_users,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE '%@towbook.driver' AND name LIKE 'QA %') AS api_users,
  (SELECT COUNT(*)::int FROM audit_log a JOIN organizations o ON o.id=a.org_id WHERE o.name LIKE 'qa edit-remove%') AS audit,
  (SELECT COUNT(*)::int FROM towbook_sessions s JOIN organizations o ON o.id=s.org_id WHERE o.name LIKE 'qa edit-remove%') AS sessions,
  (SELECT COUNT(*)::int FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa edit-remove%') AS members,
  (SELECT COUNT(*)::int FROM ai_dispatcher_decisions d JOIN organizations o ON o.id=d.org_id WHERE o.name LIKE 'qa edit-remove%') AS decisions`;
const z = Object.values(leftover[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) { console.error("FAIL: QA cleanup left rows behind"); process.exit(1); }
console.log("contractor-edit-remove.test.mjs: cleanup verified — zero QA rows left");
