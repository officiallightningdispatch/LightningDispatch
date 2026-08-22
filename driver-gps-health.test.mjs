// Hermetic tests for latestDriverGpsHealth (2026-08-22, GPS-reliability
// hardening): the roster is LEFT-JOINED to the latest REAL app fix so a driver
// with no fix is visible as `silent` rather than disappearing; status is
// live (≤2 min) / stale (≤15 min) / silent (>15 min or no fix). Status is NEVER
// inferred from Towbook, assignment coordinates, or availability sessions — only
// the freshest driver_locations row for that driver. DB-backed against a
// throwaway QA org deleted at the end (zero rows left).
//   DATABASE_URL=... bun driver-gps-health.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
const {
  latestDriverGpsHealth,
  GPS_LIVE_MAX_AGE_MINUTES,
  GPS_DISPATCH_MAX_AGE_MINUTES,
} = await import("./src/data/driver-gps-core.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");

const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

const ORG = `qa-gpshealth-${randomUUID()}`; // id must start "qa-" for assertQaOrg
const OWNER = `qa-gpshealth-owner-${randomUUID()}`;
const LIVE = `qa-gpshealth-live-${randomUUID()}`;
const LIVE_EDGE = `qa-gpshealth-livedge-${randomUUID()}`;
const STALE = `qa-gpshealth-stale-${randomUUID()}`;
const STALE_EDGE = `qa-gpshealth-staleedge-${randomUUID()}`;
const OLD = `qa-gpshealth-old-${randomUUID()}`;
const NOFIX = `qa-gpshealth-nofix-${randomUUID()}`;
const tb = (seed) => String(BigInt("0x" + seed.slice(-36).replace(/-/g, "").slice(0, 10)) % 900_000_000n);
const email = (u) => `${u}@qa.local`;

const nowMs = Date.now();

async function setup() {
  await ensureSchema();
  // Sweep leftovers from earlier crashed runs (QA-named only).
  for (const org of await q`SELECT id, name FROM organizations WHERE name='qa gps-health'`) {
    assertQaOrg(org.id, org.name);
    await q`DELETE FROM towbook_sessions WHERE org_id=${org.id}`.catch(() => {});
    await q`DELETE FROM organization_memberships WHERE org_id=${org.id}`.catch(() => {});
    await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
  }
  const ids = [OWNER, LIVE, LIVE_EDGE, STALE, STALE_EDGE, OLD, NOFIX];
  await q`DELETE FROM users WHERE id IN (${ids})`.catch(() => {});
  await q`DELETE FROM users WHERE email LIKE 'qa-gpshealth-%@qa.local'`.catch(() => {});

  await q`INSERT INTO organizations(id, name) VALUES(${ORG}, 'qa gps-health')`;
  await q`INSERT INTO users(id, name, email, password_hash) VALUES(${OWNER}, 'QA Health Owner', ${email(OWNER)}, 'x')`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${OWNER}, 'owner')`;
  const drivers = [
    [LIVE, "Live Driver", tb(LIVE)],
    [LIVE_EDGE, "Live Edge Driver", tb(LIVE_EDGE)],
    [STALE, "Stale Driver", tb(STALE)],
    [STALE_EDGE, "Stale Edge Driver", tb(STALE_EDGE)],
    [OLD, "Old Driver", tb(OLD)],
    [NOFIX, "No Fix Driver", tb(NOFIX)],
  ];
  for (const [id, name, tbId] of drivers) {
    await q`INSERT INTO users(id, name, email, password_hash, towbook_driver_id) VALUES(${id}, ${name}, ${email(id)}, 'x', ${tbId})`;
    await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${id}, 'contractor')`;
  }
}

/** One driver_locations row at an exact age (ms ago), with no job link. */
async function insertFix(userId, ageMs) {
  const captured = new Date(nowMs - ageMs).toISOString();
  await q`INSERT INTO driver_locations(id, org_id, driver_id, towbook_driver_id, job_id, latitude, longitude, accuracy, captured_at)
    VALUES(gen_random_uuid()::text, ${ORG}, ${userId}, ${tb(userId)}, NULL, 41.2, -73.2, NULL, ${captured})`;
}

await setup();

{
  const liveMs = 30_000;
  const liveEdgeMs = GPS_LIVE_MAX_AGE_MINUTES * 60_000; // exactly 2 min
  const staleMs = 10 * 60_000;
  const staleEdgeMs = GPS_DISPATCH_MAX_AGE_MINUTES * 60_000; // exactly 15 min
  const oldMs = 40 * 60_000;

  await insertFix(LIVE, liveMs);
  await insertFix(LIVE_EDGE, liveEdgeMs);
  await insertFix(STALE, staleMs);
  await insertFix(STALE_EDGE, staleEdgeMs);
  await insertFix(OLD, oldMs);
  // NOFIX intentionally has no driver_locations row.

  const rows = await latestDriverGpsHealth(ORG, nowMs);
  const byId = new Map(rows.map((r) => [r.driverId, r]));

  check("health constants", GPS_LIVE_MAX_AGE_MINUTES === 2 && GPS_DISPATCH_MAX_AGE_MINUTES === 15, `${GPS_LIVE_MAX_AGE_MINUTES}/${GPS_DISPATCH_MAX_AGE_MINUTES}`);
  check("roster-join: every contractor appears (incl. silent/no-fix)", rows.length === 6 && [LIVE, LIVE_EDGE, STALE, STALE_EDGE, OLD, NOFIX].every((id) => byId.has(id)), JSON.stringify(rows.map((r) => r.driverId)));

  const live = byId.get(LIVE);
  check("live: fresh fix ≤2 min → live", live.status === "live" && live.reason === "fresh_fix" && live.lastFixAt != null && live.ageMinutes <= GPS_LIVE_MAX_AGE_MINUTES, JSON.stringify(live));

  const liveEdge = byId.get(LIVE_EDGE);
  check("live boundary: exactly 2 min → live (≤)", liveEdge.status === "live" && liveEdge.ageMinutes === 2, JSON.stringify(liveEdge));

  const stale = byId.get(STALE);
  check("stale: 10 min → stale", stale.status === "stale" && stale.reason === "stale_fix" && stale.ageMinutes > GPS_LIVE_MAX_AGE_MINUTES && stale.ageMinutes <= GPS_DISPATCH_MAX_AGE_MINUTES, JSON.stringify(stale));

  const staleEdge = byId.get(STALE_EDGE);
  check("stale boundary: exactly 15 min → stale (≤)", staleEdge.status === "stale" && staleEdge.ageMinutes === 15, JSON.stringify(staleEdge));

  const old = byId.get(OLD);
  check("silent (old fix): >15 min → silent", old.status === "silent" && old.reason === "stale_fix" && old.lastFixAt != null && old.ageMinutes > GPS_DISPATCH_MAX_AGE_MINUTES, JSON.stringify(old));

  const nofix = byId.get(NOFIX);
  check("silent (no fix): no last_fix → silent + no_fix reason", nofix.status === "silent" && nofix.reason === "no_fix" && nofix.lastFixAt === null && nofix.ageMinutes === null, JSON.stringify(nofix));
}

/* ------------------------------ summary + cleanup ------------------------------ */
const failed = checks.filter(([, ok]) => !ok);
console.log(`driver-gps-health.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }

assertQaOrg(ORG);
await q`DELETE FROM towbook_sessions WHERE org_id=${ORG}`.catch(() => {});
await q`DELETE FROM organization_memberships WHERE org_id=${ORG}`.catch(() => {});
await q`DELETE FROM organizations WHERE id=${ORG}`.catch(() => {}); // cascades driver_locations
for (const id of [OWNER, LIVE, LIVE_EDGE, STALE, STALE_EDGE, OLD, NOFIX]) {
  await q`DELETE FROM users WHERE id=${id}`.catch(() => {});
}
const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM driver_locations dl JOIN organizations o ON o.id=dl.org_id WHERE o.name='qa gps-health') AS locs,
  (SELECT COUNT(*)::int FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name='qa gps-health') AS members,
  (SELECT COUNT(*)::int FROM users u WHERE u.id IN (${[OWNER, LIVE, LIVE_EDGE, STALE, STALE_EDGE, OLD, NOFIX]})) AS users`;
const zero = Object.values(leftover[0]).every((n) => Number(n) === 0);
if (!zero) { console.error(`FAIL: QA cleanup left rows behind: ${JSON.stringify(leftover[0])}`); process.exit(1); }
console.log("driver-gps-health.test.mjs: cleanup verified — zero QA rows left");
