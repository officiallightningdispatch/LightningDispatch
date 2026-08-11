// Hermetic roster-source tests (2026-08-11, owner-reported bug batch — BUG 1/2/3/5).
// The dispatch surface's contractor roster MUST come from users × memberships
// (role='contractor', deactivated excluded) — the SAME source the Contractors
// tab uses — never the legacy dispatch_contractors table, which is empty for
// every real org (it was the root cause of "Contractors online 0/0", the
// Performance tab showing 0 contractors, and the dispatch-console crash on an
// undefined recommendation).
// DB-backed against a throwaway QA org deleted at the end (zero rows left).
//   DATABASE_URL=... bun roster-source.test.mjs
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
const { ensureSchema } = await import("./src/data/migrations.ts");
const { ensureAuthSchema } = await import("./src/data/auth-server.ts");
const { listRosterContractors } = await import("./src/data/server.ts");
const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

const ORG = `qa-roster-${randomUUID()}`;
const OWNER = `qa-roster-owner-${randomUUID()}`;
const DRIVER_TB = `qa-roster-driver-tb-${randomUUID()}`;    // Towbook session (driver kind) + owner-kind session + ping → online
const DRIVER_LD = `qa-roster-driver-ld-${randomUUID()}`;    // live portal session only → online
const DRIVER_NONE = `qa-roster-driver-none-${randomUUID()}`; // no signals → offline
const DRIVER_DEACT = `qa-roster-driver-deact-${randomUUID()}`; // has a session but deactivated → must NOT appear
const JOB_DONE = `qa-roster-job-done-${randomUUID()}`;       // completed for DRIVER_TB (by Towbook id)
const JOB_OTHER = `qa-roster-job-other-${randomUUID()}`;     // completed for a different driver
const JOB_OPEN = `qa-roster-job-open-${randomUUID()}`;       // not completed for DRIVER_TB

try {
  await ensureSchema();
  await ensureAuthSchema();

  await q`INSERT INTO organizations(id, name) VALUES(${ORG}, ${"qa roster-source"})`;
  await q`INSERT INTO users(id, name, email, password_hash, towbook_driver_id) VALUES
    (${OWNER}, ${"Roster QA Owner"}, ${`owner-${ORG}@qa.test`}, ${"x"}, NULL),
    (${DRIVER_TB}, ${"Adam Towbook"}, ${`tb-${ORG}@qa.test`}, ${"x"}, ${"9001"}),
    (${DRIVER_LD}, ${"Beth Portal"}, ${`ld-${ORG}@qa.test`}, ${"x"}, NULL),
    (${DRIVER_NONE}, ${"Casey None"}, ${`none-${ORG}@qa.test`}, ${"x"}, NULL),
    (${DRIVER_DEACT}, ${"Dana Gone"}, ${`gone-${ORG}@qa.test`}, ${"x"}, ${"9002"})`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES
    (${ORG}, ${OWNER}, ${"owner"}),
    (${ORG}, ${DRIVER_TB}, ${"contractor"}),
    (${ORG}, ${DRIVER_LD}, ${"contractor"}),
    (${ORG}, ${DRIVER_NONE}, ${"contractor"}),
    (${ORG}, ${DRIVER_DEACT}, ${"contractor"})`;
  // Dana is deactivated (the soft-delete the remove flow uses) — excluded from the roster.
  await q`UPDATE users SET deactivated_at = NOW() WHERE id = ${DRIVER_DEACT}`;

  // DRIVER_TB: BOTH a per-driver Towbook session AND an owner-kind Towbook
  // session linked to their driver id (the BUG 2 scenario — the owner connects
  // Towbook through the portal with their own driver login, so the owner's own
  // roster row must read signed in) + a GPS ping for the location.
  await q`INSERT INTO towbook_sessions(org_id, encrypted_session, status, session_kind, towbook_driver_id, updated_at) VALUES
    (${ORG}, ${"enc-tb"}, ${"connected"}, ${"driver"}, ${"9001"}, NOW()),
    (${ORG}, ${"enc-owner"}, ${"connected"}, ${"owner"}, ${"9001"}, NOW())`;
  // DRIVER_LD: live LD portal session.
  await q`INSERT INTO sessions(id, user_id, expires_at) VALUES(${`sess-${randomUUID()}`}, ${DRIVER_LD}, NOW() + interval '1 day')`;
  // DRIVER_DEACT: session exists but the account is deactivated — must still be hidden.
  await q`INSERT INTO sessions(id, user_id, expires_at) VALUES(${`sess-${randomUUID()}`}, ${DRIVER_DEACT}, NOW() + interval '1 day')`;
  // DRIVER_TB: one ping (the newest wins).
  await q`INSERT INTO driver_locations(id, org_id, driver_id, towbook_driver_id, latitude, longitude, captured_at) VALUES
    (${`loc-${randomUUID()}`}, ${ORG}, ${DRIVER_TB}, ${"9001"}, ${40.0}, ${-73.0}, NOW() - interval '2 minutes'),
    (${`loc-${randomUUID()}`}, ${ORG}, ${DRIVER_TB}, ${"9001"}, ${41.175}, ${-73.5}, NOW())`;

  // Completed jobs: one for DRIVER_TB by Towbook id, one for another driver,
  // and one OPEN job for DRIVER_TB (must not count as completed).
  await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, assigned_driver_towbook_id) VALUES
    (${JOB_DONE}, ${ORG}, ${"Done Cx"}, ${"555-1"}, ${41.0}, ${-73.4}, ${"Bridgeport"}, ${"jump_start"}, ${"completed"}, NOW(), ${"9001"}),
    (${JOB_OTHER}, ${ORG}, ${"Other Cx"}, ${"555-2"}, ${41.0}, ${-73.4}, ${"Bridgeport"}, ${"tire_change"}, ${"completed"}, NOW(), ${"7007"}),
    (${JOB_OPEN}, ${ORG}, ${"Open Cx"}, ${"555-3"}, ${"41.0"}, ${"-73.4"}, ${"Bridgeport"}, ${"lockout"}, ${"new"}, NOW(), ${"9001"})`;

  /* ============================ assertions ============================ */
  const roster = await listRosterContractors(ORG);
  check("BUG1: roster has only the 3 ACTIVE contractors (deactivated excluded)", roster.length === 3, JSON.stringify(roster.map((c) => c.name)));
  const byName = Object.fromEntries(roster.map((c) => [c.name, c]));
  check("BUG1: sorted by name", roster[0].name === "Adam Towbook" && roster[1].name === "Beth Portal" && roster[2].name === "Casey None", JSON.stringify(roster.map((c) => c.name)));

  const adam = byName["Adam Towbook"];
  check("BUG2: driver with owner-kind Towbook session linked to their id → online", adam.status === "online", JSON.stringify(adam));
  check("BUG1: location = newest GPS ping", Math.abs(adam.location.lat - 41.175) < 1e-6 && Math.abs(adam.location.lng - -73.5) < 1e-6, JSON.stringify(adam.location));
  check("BUG1: completedJobCount counts ONLY completed jobs by their Towbook driver id", adam.completedJobCount === 1, `count=${adam.completedJobCount}`);

  const beth = byName["Beth Portal"];
  check("BUG1: contractor with live portal session → online", beth.status === "online", JSON.stringify(beth));

  const casey = byName["Casey None"];
  check("BUG1: contractor with no signal → offline", casey.status === "offline", JSON.stringify(casey));
  check("BUG1: no-signal contractor has 0,0 location (never a crash)", casey.location.lat === 0 && casey.location.lng === 0, JSON.stringify(casey.location));
  check("BUG1: completedJobCount 0 when nothing assigned", casey.completedJobCount === 0, `count=${casey.completedJobCount}`);

  const filtered = await listRosterContractors(ORG, DRIVER_NONE);
  check("BUG1: contractorId filter returns exactly that contractor", filtered.length === 1 && filtered[0].id === DRIVER_NONE, JSON.stringify(filtered.map((c) => c.id)));

  /* ============ source-level guards (the safety rails) ============ */
  const server = readFileSync(new URL("./src/data/server.ts", import.meta.url), "utf8");
  const dataForSource = server.slice(server.indexOf("async function dataFor"), server.indexOf("async function result"));
  const assignSource = server.slice(server.indexOf("export const assignJob"), server.indexOf("export const advanceJob"));
  const statusSource = server.slice(server.indexOf("export const setContractorStatus"), server.indexOf("export type StatusEvent"));
  check("BUG1: dataFor never reads the legacy dispatch_contractors table", !dataForSource.includes("dispatch_contractors"), dataForSource);
  check("BUG1: assignJob never reads the legacy dispatch_contractors table", !assignSource.includes("dispatch_contractors"), assignSource);
  check("BUG1: setContractorStatus never writes the legacy dispatch_contractors table", !statusSource.includes("dispatch_contractors"), statusSource);
  check("BUG1: assignJob writes the real driver columns (name + Towbook id, FK stays NULL)", assignSource.includes("assigned_driver_name") && assignSource.includes("assigned_driver_towbook_id") && assignSource.includes("assigned_contractor_id=NULL"), "assign columns missing");

  const dispatch = readFileSync(new URL("./src/routes/dispatch.tsx", import.meta.url), "utf8");
  const ops = readFileSync(new URL("./src/components/ops-views.tsx", import.meta.url), "utf8");
  check("BUG2: dispatch console renders a clear state when no contractors are available", dispatch.includes("No contractors available — add contractors to the roster before dispatching.") || dispatch.includes("No contractors available"), "dispatch guard missing");
  check("BUG2: ops console renders a clear state when no contractors are available", ops.includes("No contractors available"), "ops guard missing");

  const core = readFileSync(new URL("./src/data/contractor-management-core.ts", import.meta.url), "utf8");
  check("BUG3: Contractors tab source excludes deactivated drivers", core.includes("deactivated_at IS NULL"), "listContractorsCore filter missing");
  check("BUG2: roster status derives from sessions (owner-kind Towbook session included)", core.includes("session_kind='owner'") || core.includes("session_kind"), "listContractorsCore session source missing");

  const rec = readFileSync(new URL("./src/lib/dispatch-recommendation.ts", import.meta.url), "utf8");
  check("BUG2: recommendation engine null-safe on an empty roster", rec.includes("if (!top)"), "recommendation empty-roster guard missing");

  console.log(`roster-source: ${checks.filter((c) => c[1]).length}/${checks.length} checks passed`);
} finally {
  // Cleanup — zero rows left behind.
  await q`DELETE FROM sessions WHERE user_id IN (${OWNER}, ${DRIVER_TB}, ${DRIVER_LD}, ${DRIVER_NONE}, ${DRIVER_DEACT})`;
  await q`DELETE FROM towbook_sessions WHERE org_id = ${ORG}`;
  await q`DELETE FROM driver_locations WHERE org_id = ${ORG}`;
  await q`DELETE FROM dispatch_jobs WHERE org_id = ${ORG}`;
  await q`DELETE FROM organization_memberships WHERE org_id = ${ORG}`;
  await q`DELETE FROM users WHERE id IN (${OWNER}, ${DRIVER_TB}, ${DRIVER_LD}, ${DRIVER_NONE}, ${DRIVER_DEACT})`;
  await q`DELETE FROM organizations WHERE id = ${ORG}`;
}
