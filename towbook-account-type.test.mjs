// Hermetic Towbook account-type role mapping tests (owner-directed 2026-08-12):
// the Towbook account TYPE is authoritative for the portal role — type 1
// (driver) → contractor portal, type 2 (manager/dispatcher) → owner portal,
// type 3 (disabled) → refused, unknown → refused. Also covers the /api/users
// fallback when /api/user lacks `type`, and the type-1 no-roster-match
// resolution (never the old "not linked to a driver record" dead-end).
// Pure function tests — no DB, no network, no fixture rows (nothing to clean up).
//   bun towbook-account-type.test.mjs
import { readFileSync } from "node:fs";
import { identifyDriver } from "./src/data/driver-auth.ts";
const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};
const SESSION = { cookies: "c=1", baseUrl: "https://app.towbook.com" };
/** Minimal fetch stub returning canned JSON; UNROUTED calls throw — so a route
 *  that must NOT be hit (e.g. a checkin POST for owner sign-ins) fails loudly. */
const jsonFetch = (routes) => async (url, init) => {
  const key = `${init?.method ?? "GET"} ${url}`;
  const hit = routes[key] ?? routes[url];
  if (!hit) throw new Error(`no route for ${key} (this path must not be reached)`);
  const { status = 200, body, raw } = hit;
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (raw != null ? raw : JSON.stringify(body)),
    json: async () => JSON.parse(JSON.stringify(body)),
  };
};
const API_USER = "GET https://app.towbook.com/api/user";
/* ==================== type 1 (driver) → contractor flow preserved ==================== */
{
  // Roster linkedUserId match — the plain pre-mapping flow still resolves.
  const r = await identifyDriver(SESSION, { fetchImpl: jsonFetch({
    [API_USER]: { body: { id: 42, name: "Jane Cooper", type: 1 } },
    "GET https://app.towbook.com/api/drivers": { body: [{ id: 7, name: "Jane Cooper", linkedUserId: 42 }, { id: 8, name: "Bob", linkedUserId: 43 }] },
  }) });
  check("type 1 + roster linkedUserId match → kind driver, rosterFallback false",
    r.ok && r.kind === "driver" && r.rosterFallback === false && r.identity.userId === "42" && r.identity.driverId === "7" && r.identity.driverName === "Jane Cooper", JSON.stringify(r));
}
{
  // Type-1 account with NO roster match — the dead-end is GONE (owner mandate):
  // signs in as a contractor with the Towbook USER id as the driver id, flagged.
  const r = await identifyDriver(SESSION, { fetchImpl: jsonFetch({
    [API_USER]: { body: { id: 42, name: "Jane Cooper", type: 1 } },
    "GET https://app.towbook.com/api/drivers": { body: [{ id: 8, name: "Bob", linkedUserId: 43 }] },
  }) });
  check("type 1 + no roster match → STILL signs in (driverId=userId, rosterFallback)",
    r.ok && r.kind === "driver" && r.rosterFallback === true && r.identity.driverId === "42" && r.identity.userId === "42", JSON.stringify(r));
  check("type 1 + no roster match → never the 'driver record' dead-end message", !("message" in r && r.ok === false && String(r.message).includes("driver record")));
}
/* ==================== type 2 (manager/dispatcher) → owner ==================== */
{
  // Real shape (recon evidence api-user.json): id 822856, "Lightning Dispatch".
  // Routes contain NO /api/drivers and NO POST — if the owner path tried to
  // resolve a roster or check in, jsonFetch would throw "no route".
  const r = await identifyDriver(SESSION, { fetchImpl: jsonFetch({
    [API_USER]: { body: { id: 822856, name: "Lightning Dispatch", username: "lightengineer", type: 2 } },
  }) });
  check("type 2 → kind owner with user id + name",
    r.ok && r.kind === "owner" && r.user.userId === "822856" && r.user.name === "Lightning Dispatch", JSON.stringify(r));
  check("type 2 → no driver identity resolved (no roster call, no checkin POST)", r.ok && r.kind === "owner" && !("identity" in r));
}
/* ==================== type 3 (disabled) → refused ==================== */
{
  const r = await identifyDriver(SESSION, { fetchImpl: jsonFetch({
    [API_USER]: { body: { id: 349846, name: "Antoine Jarrett CT", type: 3, disabled: true } },
  }) });
  check("type 3 → refused with calm 'disabled' message",
    !r.ok && String(r.message).includes("disabled") && String(r.message).includes("owner"), JSON.stringify(r));
  // Owner-clarified 2026-08-12: type 3 = disabled, NO access, exact copy.
  check("type 3 → exact white-label refusal copy (no brand leakage)",
    !r.ok && r.message === "This account is disabled — contact the owner." && !String(r.message).includes("Towbook"), JSON.stringify(r));
  check("type 3 → refusal is NOT an expired-session signal (no silent retry)",
    !r.ok && r.expired !== true, JSON.stringify(r));
}
/* ==================== unknown type → refused ==================== */
{
  const r = await identifyDriver(SESSION, { fetchImpl: jsonFetch({
    [API_USER]: { body: { id: 42, name: "Mystery", type: 0 } },
  }) });
  check("type 0 → refused 'Account type not recognized'", !r.ok && String(r.message).includes("not recognized"), JSON.stringify(r));
}
{
  const r = await identifyDriver(SESSION, { fetchImpl: jsonFetch({
    [API_USER]: { body: { id: 42, name: "Mystery", type: 9 } },
  }) });
  check("type 9 → refused 'Account type not recognized'", !r.ok && String(r.message).includes("not recognized"), JSON.stringify(r));
}
/* ============ missing type on /api/user → /api/users fallback ============ */
{
  // /api/user has NO `type` → the /api/users list supplies it (type 2) → owner.
  const r = await identifyDriver(SESSION, { fetchImpl: jsonFetch({
    [API_USER]: { body: { id: 822856, name: "Lightning Dispatch" } },
    "GET https://app.towbook.com/api/users": { body: [{ id: 116012, name: "Brittani Simms", type: 1 }, { id: 822856, name: "Lightning Dispatch", type: 2 }] },
  }) });
  check("missing type → /api/users fallback finds type 2 → kind owner",
    r.ok && r.kind === "owner" && r.user.userId === "822856", JSON.stringify(r));
}
{
  // /api/user lacks `type`; /api/users has the user but without a type → legacy
  // default driver flow (roster resolution) — never a new dead-end.
  const r = await identifyDriver(SESSION, { fetchImpl: jsonFetch({
    [API_USER]: { body: { id: 42, name: "Jane Cooper" } },
    "GET https://app.towbook.com/api/users": { body: [{ id: 42, name: "Jane Cooper" }] },
    "GET https://app.towbook.com/api/drivers": { body: [{ id: 7, name: "Jane Cooper", linkedUserId: 42 }] },
  }) });
  check("missing type everywhere → legacy default driver flow preserved",
    r.ok && r.kind === "driver" && r.identity.driverId === "7" && r.rosterFallback === false, JSON.stringify(r));
}
/* ==================== expired session still signals ==================== */
{
  const r = await identifyDriver(SESSION, { fetchImpl: jsonFetch({
    [API_USER]: { status: 401, body: {} },
  }) });
  check("401 on /api/user → expired signal", !r.ok && r.expired === true, JSON.stringify(r));
}
/* ============ login route wiring: role routes via the portal helper ============ */
{
  const src = readFileSync(new URL("./src/routes/login.tsx", import.meta.url), "utf8");
  check("login.tsx routes the driver-login role through portal() (contractor→/driver, owner→/owner)",
    src.includes("portal(d.role)") && src.includes('role==="contractor"?"/driver"'), "driverLogin route not wired to portal(d.role)");
}
/* --------------------------------- summary --------------------------------- */
const failed = checks.filter(([, ok]) => !ok);
console.log(`towbook-account-type.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }
console.log("towbook-account-type.test.mjs: pure suite — no QA rows created");
