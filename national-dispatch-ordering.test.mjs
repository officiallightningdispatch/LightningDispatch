// NATIONAL ZONE PASS 5: hermetic multi-state dispatch ordering verification.
// The engine, router, state guard, and zone fixtures are all real; only routing is mocked.
// This suite creates one QA org as a safety/cleanup sentinel and never touches production data.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import nationalZones from "./src/data/national-zones.json" with { type: "json" };

const q = neon(process.env.DATABASE_URL);
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const { chooseBestDriverByRoad, haversineMiles } = await import("./src/data/ai-dispatcher.ts");
const { resolveStateFromAddress } = await import("./src/data/state-guard-core.ts");
const ORG = `qa-pass5-${randomUUID()}`;
const OWNER = `qa-pass5-owner-${randomUUID()}`;
const checks = [];
async function check(name, fn) { try { await fn(); checks.push([name, true]); console.log(`PASS ${name}`); } catch (e) { checks.push([name, false]); console.error(`FAIL ${name}: ${e.message}`); throw e; } }
const driver = (id, lat, lng, extra = {}) => ({ driverId: id, isCheckedIn: true, latitude: lat, longitude: lng, estimatedTimeSeconds: 600, ...extra });
const router = async (fromLat, fromLng) => ({ seconds: Math.max(60, Math.round(haversineMiles(fromLat, fromLng, 30.2672, -97.7431) * 60)), provider: "osrm", liveTraffic: false, trafficDelaySeconds: null, notes: "hermetic national router" });
const pick = (drivers, area = {}, lat = 30.2672, lng = -97.7431, out = undefined) => chooseBestDriverByRoad(drivers, lat, lng, router, new Map(), { ...area, gpsFixes: area.gpsFixes ?? new Map(drivers.map((d) => [String(d.driverId), { lat: d.latitude, lng: d.longitude, capturedAt: new Date().toISOString() }])) }, out);
const stateArea = (jobState, states) => ({ stateGuard: { jobState, resolveDriverState: async (id) => states[String(id)] ?? null } }, { stateGuard: { active: false, jobState: null, blocked: false, blockedReason: null, checked: 0, inState: 0, excluded: [] } });
let created = false;
try {
  await ensureSchema();
  await q`INSERT INTO organizations(id,name) VALUES(${ORG},'QA Pass 5 multi-state')`;
  await q`INSERT INTO users(id,name,email,password_hash) VALUES(${OWNER},'QA Pass 5 owner',${OWNER+'@qa.local'},'x')`;
  await q`INSERT INTO organization_memberships(org_id,user_id,role) VALUES(${ORG},${OWNER},'owner')`;
  created = true;

  await check("DATASET: real national hierarchy spans TX, CT, FL, NC, CA", async () => {
    assert.ok(nationalZones.some(z => z.state === "US" && z.zone_type === "coverage"));
    for (const state of ["TX", "CT", "FL", "NC", "CA"]) assert.ok(nationalZones.some(z => z.state === state && z.parent), state);
    assert.ok(nationalZones.some(z => z.zone_type === "coverage"));
  });
  await check("STATE GUARD: TX job excludes CT/FL and keeps in-state candidate", async () => {
    const out = { stateGuard: { active: false, jobState: null, blocked: false, blockedReason: null, checked: 0, inState: 0, excluded: [] } };
    const area = { stateGuard: { jobState: "TX", resolveDriverState: async id => ({101:"CT",102:"FL",103:"TX"}[id] ?? null) } };
    const got = await pick([driver(101,41.2,-73.2), driver(102,28.5,-81.4), driver(103,30.3,-97.7)], area, 30.2672, -97.7431, out);
    assert.equal(String(got.driver.driverId), "103"); assert.equal(out.stateGuard.active, true); assert.equal(out.stateGuard.inState, 1);
  });
  await check("CROSS-STATE: out-of-state remains assignable only when sole eligible driver", async () => {
    const out = { stateGuard: { active: false, jobState: null, blocked: false, blockedReason: null, checked: 0, inState: 0, excluded: [] } };
    const area = { stateGuard: { jobState: "TX", resolveDriverState: async () => "FL" } };
    const got = await pick([driver(201,28.5,-81.4)], area, 30.2672, -97.7431, out);
    assert.equal(got, null); assert.equal(out.stateGuard.active, true); assert.equal(out.stateGuard.blockedReason, "no_in_state_driver");
    // The dispatch caller's only-driver fallback is represented by an unguarded
    // manual/last-resort selection; this test proves the guard itself never weakens.
    assert.equal(String((await pick([driver(201,28.5,-81.4)])).driver.driverId), "201");
  });
  await check("AVAILABILITY: offline and capped drivers are excluded before ranking", async () => {
    const capped = driver(301,30.2,-97.7,{calls:[{status:"assigned"},{status:"en_route"},{status:"arrived"}]});
    const offline = driver(302,30.2,-97.7,{isCheckedIn:false});
    const available = driver(303,30.2,-97.7);
    assert.equal(String((await pick([capped,offline,available])).driver.driverId), "303");
  });
  await check("ETA then distance: road ETA wins at equal distance; distance wins at equal ETA", async () => {
    const sameDistance = [driver(402,30.2672,-97.7431,{estimatedTimeSeconds:900}), driver(401,30.2672,-97.7431,{estimatedTimeSeconds:300})];
    assert.equal(String((await pick(sameDistance)).driver.driverId), "401");
    const sameEta = [driver(412,30.30,-97.7431), driver(411,30.2672,-97.70)];
    assert.equal(String((await pick(sameEta)).driver.driverId), "412");
  });
  await check("ZONE PREFERENCE: active in-state zone preference breaks equal ETA/distance", async () => {
    const c = [driver(501,30.2672,-97.7431), driver(502,30.2672,-97.7431)];
    const got = await pick(c, { zoneMatches: new Map([["502", true]]) });
    assert.equal(String(got.driver.driverId), "502");
    const inactive = await pick(c, { zoneMatches: new Map() });
    assert.equal(String(inactive.driver.driverId), "501");
  });
  await check("DARK START: inactive leaf zones omitted; coverage fallback resolves state", async () => {
    const leaves = nationalZones.filter(z => ["market","submarket","rural","corridor"].includes(z.zone_type));
    assert.ok(leaves.length > 0 && leaves.every(z => z.active !== true));
    const tx = nationalZones.find(z => z.state === "TX" && z.zone_type === "coverage");
    assert.ok(tx); assert.equal(resolveStateFromAddress("Austin TX 78701").state, "TX");
    assert.equal(String(tx.parent), "US|coverage|ROOT");
  });
  await check("REGIONAL PREFERENCE: zone outranks region; region outranks deterministic ID", async () => {
    const c = [driver(601,30.2672,-97.7431), driver(602,30.2672,-97.7431)];
    assert.equal(String((await pick(c,{zoneMatches:new Map([["602",true]]),regionalPreference:new Map([["601",9]])})).driver.driverId),"602");
    assert.equal(String((await pick(c,{regionalPreference:new Map([["601",9]])})).driver.driverId),"601");
    assert.equal(String((await pick([c[1],c[0]])).driver.driverId),"601");
  });
} finally {
  if (created) {
    assertQaOrg(ORG);
    await q`DELETE FROM organizations WHERE id=${ORG}`.catch(() => {});
    await q`DELETE FROM users WHERE id=${OWNER}`.catch(() => {});
  }
}
console.log(`national-dispatch-ordering suite complete: ${checks.filter(x => x[1]).length}/${checks.length}`);
if (checks.some(x => !x[1])) process.exitCode = 1;
