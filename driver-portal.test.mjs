// Hermetic driver-portal tests (2026-08-11). Real Towbook calls never happen:
// every Towbook-facing function takes an injected fetchImpl. DB-backed paths
// (upsert/persist/session load) are covered by the shared sandbox-DB fixture
// test; these tests cover the pure logic of the driver portal:
//   bun driver-portal.test.mjs
import { identifyDriver, driverCheckin, driverCheckout, normalizeDriverCall } from "./src/data/driver-auth.ts";
const checks = [];
const check = (name, cond, extra = "") => { checks.push([name, Boolean(cond), extra]); if (!cond) throw new Error(`FAIL: ${name} ${extra}`); };
const SESSION = { cookies: "c=1", baseUrl: "https://app.towbook.com" };

/** Minimal fetch stub returning canned JSON (with .json() like the real thing). */
const jsonFetch = (routes) => async (url, init) => {
  const key = `${init?.method ?? "GET"} ${url}`;
  const hit = routes[key] ?? routes[url];
  if (!hit) throw new Error(`no route for ${key}`);
  const { status = 200, body, raw } = hit;
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (raw != null ? raw : JSON.stringify(body)),
    json: async () => JSON.parse(JSON.stringify(body)),
  };
};

/* ------------------------------ identifyDriver ------------------------------ */
{
  const me = { id: 42, name: "Jane Cooper" };
  const roster = [{ id: 7, name: "Jane Cooper", linkedUserId: 42 }, { id: 8, name: "Bob", linkedUserId: 43 }];
  const r = await identifyDriver(SESSION, { fetchImpl: jsonFetch({
    "GET https://app.towbook.com/api/user": { body: me },
    "GET https://app.towbook.com/api/drivers": { body: roster },
  }) });
  check("linkedUserId match", r.ok && r.identity.userId === "42" && r.identity.driverId === "7" && r.identity.driverName === "Jane Cooper", JSON.stringify(r));
}
{
  // linkedUserId absent → name fallback (the "match by name if needed" path).
  const r = await identifyDriver(SESSION, { fetchImpl: jsonFetch({
    "GET https://app.towbook.com/api/user": { body: { id: 42, name: "Jane Cooper" } },
    "GET https://app.towbook.com/api/drivers": { body: [{ id: 7, name: "Jane Cooper" }, { id: 8, name: "Bob" }] },
  }) });
  check("name-match fallback", r.ok && r.identity.driverId === "7", JSON.stringify(r));
}
{
  // Type-1 account NOT on the roster → NO dead-end (owner mandate 2026-08-12):
  // "Your login isn't linked to a driver record" must never appear again. The
  // driver id resolves pragmatically to the Towbook USER id (rosterFallback).
  const r = await identifyDriver(SESSION, { fetchImpl: jsonFetch({
    "GET https://app.towbook.com/api/user": { body: { id: 42, name: "Jane Cooper", type: 1 } },
    "GET https://app.towbook.com/api/drivers": { body: [{ id: 8, name: "Bob" }] },
  }) });
  check("type-1 not-in-roster → signs in, driverId=userId, rosterFallback flagged", r.ok && r.kind === "driver" && r.identity.userId === "42" && r.identity.driverId === "42" && r.identity.driverName === "Jane Cooper" && r.rosterFallback === true, JSON.stringify(r));
}
{
  // 401 on /api/user → expired session signal.
  const r = await identifyDriver(SESSION, { fetchImpl: jsonFetch({
    "GET https://app.towbook.com/api/user": { status: 401, body: {} },
  }) });
  check("401 → expired", !r.ok && r.expired === true, JSON.stringify(r));
}

/* ------------------------------ driverCheckin ------------------------------ */
{
  const r = await driverCheckin(SESSION, "42", 41.14, -73.2, { fetchImpl: jsonFetch({ "POST https://app.towbook.com/api/user/checkin": { status: 200, body: {} } }) });
  check("checkin ok no warning", r.ok && r.warning === null, JSON.stringify(r));
}
{
  const r = await driverCheckin(SESSION, "42", 0, 0, { fetchImpl: jsonFetch({ "POST https://app.towbook.com/api/user/checkin": { status: 200, body: {} } }), locationDenied: true });
  check("location denied → visible warning", r.ok && r.warning !== null && r.warning.includes("Location is off"), JSON.stringify(r));
}
{
  const r = await driverCheckin(SESSION, "42", 41.14, -73.2, { fetchImpl: jsonFetch({ "POST https://app.towbook.com/api/user/checkin": { status: 500, body: {} } }) });
  check("checkin POST failure → warning, not crash", !r.ok && r.warning !== null, JSON.stringify(r));
}
{
  // Checkout is best-effort and resolves even when Towbook errors.
  let called = false;
  const r = await driverCheckout(SESSION, "42", { fetchImpl: async (url, init) => { called = true; return { status: 500, ok: false, text: async () => "", json: async () => ({}) }; } });
  check("checkout best-effort", called && r === undefined);
}

/* ------------------------------ normalizeDriverCall ------------------------------ */
{
  const card = normalizeDriverCall({
    id: 321001, callNumber: 321001, type: 1, reason: { id: 365, name: "Jump Start" },
    status: { id: 1 },
    waypoints: [{ address: "70 Pitt Street", zip: "06606" }],
    assets: [{ year: 2015, make: "Toyota", model: "Camry", color: { name: "Silver" }, vin: "4T1BF1FK1FU123456" }],
    arrivalETA: "2026-08-11T21:07:00", purchaseOrderNumber: "PO-88412",
  });
  check("card mapping", card !== null
    && card.id === "321001" && card.callNumber === "321001"
    && card.serviceName === "Jump Start" && card.statusId === 1
    && card.pickupAddress === "70 Pitt Street" && card.zip === "06606"
    && card.vehicle.includes("Toyota") && card.vehicle.includes("Silver") && card.vehicle.includes("4T1BF1FK1FU123456")
    && card.arrivalETA === "2026-08-11T21:07:00" && card.purchaseOrderNumber === "PO-88412", JSON.stringify(card));
}
{
  check("no-status call rejected", normalizeDriverCall({ id: 5, status: {} }) === null);
}

/* ------------------------------ summary ------------------------------ */
const failed = checks.filter(([, ok]) => !ok);
console.log(`driver-portal.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }
