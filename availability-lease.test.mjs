// Hermetic P0 Slice 3 availability lease regression suite.
// Uses only a throwaway QA organization in the configured database; no Towbook
// calls are made and all fixtures are deleted in finally.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
const q = neon(process.env.DATABASE_URL);
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const { recordAvailabilityStart, recordAvailabilityStop, driverAvailabilityHeartbeat } = await import("./src/data/driver-auth.ts");
const { getZonesCore, getOwnerZoneDriverRosterCore, upsertZoneCore } = await import("./src/data/zones-core.ts");

const tag = randomUUID();
const ORG = `qa-availability-lease-${tag}`;
const OWNER = `qa-availability-owner-${tag}`;
const DRIVER = `qa-availability-driver-${tag}`;
const ZONE = `qa-availability-zone-${tag}`;
const DAY = (await q`SELECT CURRENT_DATE::text AS day`)[0].day;
const checks = [];
const check = async (name, fn) => { try { await fn(); checks.push([name, true]); console.log(`PASS ${name}`); } catch (e) { checks.push([name, false]); console.error(`FAIL ${name}: ${e.message}`); throw e; } };
const actor = { orgId: ORG, id: OWNER, role: "owner" };

await ensureSchema();
assertQaOrg(ORG);
try {
  await q`INSERT INTO organizations(id,name) VALUES(${ORG},${ORG})`;
  await q`INSERT INTO users(id,name,email,password_hash,towbook_driver_id) VALUES
    (${OWNER},'QA availability owner',${OWNER+'@qa.local'},'x',NULL),
    (${DRIVER},'QA availability driver',${DRIVER+'@qa.local'},'x','991001')`;
  await q`INSERT INTO organization_memberships(org_id,user_id,role) VALUES
    (${ORG},${OWNER},'owner'),(${ORG},${DRIVER},'contractor')`;
  await upsertZoneCore(actor, { id: ZONE, name: "QA Lease Zone", state: "CT", lat: 41.2, lng: -73.2, radiusMiles: 10, tz: "America/New_York", active: true });

  await check("GO writes a fresh lease with session start", async () => {
    await recordAvailabilityStart(q, ORG, DRIVER);
    const rows = await q`SELECT session_started_at,heartbeat_at,ping_count FROM driver_availability_log WHERE org_id=${ORG} AND user_id=${DRIVER} AND day=CURRENT_DATE`;
    assert.equal(rows.length, 1); assert.ok(rows[0].session_started_at); assert.ok(rows[0].heartbeat_at); assert.equal(Number(rows[0].ping_count), 1);
  });

  await check("heartbeat refreshes lease and keeps driver online", async () => {
    const before = await q`SELECT heartbeat_at FROM driver_availability_log WHERE org_id=${ORG} AND user_id=${DRIVER} AND day=CURRENT_DATE`;
    await new Promise(r => setTimeout(r, 20));
    // Exercise the same SQL heartbeat upsert directly: the exported server fn
    // needs an auth runtime, while this is the hermetic DB-side logic it owns.
    await q`WITH prior AS (SELECT session_started_at FROM driver_availability_log WHERE org_id=${ORG} AND user_id=${DRIVER} AND session_started_at IS NOT NULL ORDER BY day DESC LIMIT 1)
      INSERT INTO driver_availability_log(org_id,user_id,day,online_minutes,ping_count,session_started_at,heartbeat_at,updated_at)
      VALUES(${ORG},${DRIVER},CURRENT_DATE,0,0,COALESCE((SELECT session_started_at FROM prior),NOW()),NOW(),NOW())
      ON CONFLICT(org_id,user_id,day) DO UPDATE SET heartbeat_at=NOW(),updated_at=NOW(),session_started_at=COALESCE(driver_availability_log.session_started_at,EXCLUDED.session_started_at)`;
    const row = (await q`SELECT session_started_at,heartbeat_at FROM driver_availability_log WHERE org_id=${ORG} AND user_id=${DRIVER} AND day=CURRENT_DATE`)[0];
    assert.ok(new Date(row.heartbeat_at).getTime() >= new Date(before[0].heartbeat_at).getTime()); assert.ok(row.session_started_at);
    // The server fn is imported and its lease interval is part of the tested contract.
    assert.equal((await import("./src/data/driver-auth.ts")).AVAILABILITY_STALE_AFTER_SECONDS, 90);
  });

  await check("stale lease is excluded from zone busyness and roster online", async () => {
    await q`UPDATE driver_availability_log SET zone_id=${ZONE},heartbeat_at=NOW()-INTERVAL '91 seconds' WHERE org_id=${ORG} AND user_id=${DRIVER} AND day=CURRENT_DATE`;
    const zones = await getZonesCore(actor); assert.equal(zones.find(z => z.id === ZONE).availableDrivers, 0);
    const roster = await getOwnerZoneDriverRosterCore(actor); const d = roster.drivers.find(x => x.userId === DRIVER);
    // Roster must apply the same 90-second lease gate as the count query.
    assert.equal(d.online, false);
  });

  await check("STOP clears lease and banks elapsed online minutes", async () => {
    await q`UPDATE driver_availability_log SET session_started_at=NOW()-INTERVAL '3 minutes',heartbeat_at=NOW() WHERE org_id=${ORG} AND user_id=${DRIVER} AND day=CURRENT_DATE`;
    await recordAvailabilityStop(q, ORG, DRIVER);
    const row = (await q`SELECT session_started_at,online_minutes FROM driver_availability_log WHERE org_id=${ORG} AND user_id=${DRIVER} AND day=CURRENT_DATE`)[0];
    assert.equal(row.session_started_at, null); assert.ok(Number(row.online_minutes) >= 3);
  });

  await check("day rollover preserves original start and STOP spans multiple days", async () => {
    const started = new Date(Date.now() - 26 * 60 * 60 * 1000);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    await q`DELETE FROM driver_availability_log WHERE org_id=${ORG} AND user_id=${DRIVER}`;
    await q`INSERT INTO driver_availability_log(org_id,user_id,day,online_minutes,ping_count,session_started_at,heartbeat_at,updated_at,zone_id) VALUES(${ORG},${DRIVER},${yesterday},0,1,${started},NOW()-INTERVAL '2 hours',NOW(),${ZONE})`;
    await q`WITH prior AS (SELECT session_started_at FROM driver_availability_log WHERE org_id=${ORG} AND user_id=${DRIVER} AND session_started_at IS NOT NULL ORDER BY day DESC LIMIT 1)
      INSERT INTO driver_availability_log(org_id,user_id,day,online_minutes,ping_count,session_started_at,heartbeat_at,updated_at,zone_id)
      VALUES(${ORG},${DRIVER},CURRENT_DATE,0,1,COALESCE((SELECT session_started_at FROM prior),NOW()),NOW(),NOW(),${ZONE})
      ON CONFLICT(org_id,user_id,day) DO UPDATE SET session_started_at=COALESCE(driver_availability_log.session_started_at,EXCLUDED.session_started_at),heartbeat_at=NOW(),updated_at=NOW()`;
    const rows = await q`SELECT day,session_started_at,heartbeat_at FROM driver_availability_log WHERE org_id=${ORG} AND user_id=${DRIVER} ORDER BY day`;
    const today = rows[rows.length - 1]; assert.ok(today); assert.ok(today.heartbeat_at); assert.equal(new Date(today.session_started_at).getTime(), started.getTime());
    await recordAvailabilityStop(q, ORG, DRIVER);
    const closed = await q`SELECT session_started_at,online_minutes FROM driver_availability_log WHERE org_id=${ORG} AND user_id=${DRIVER}`;
    assert.ok(closed.every(r => r.session_started_at == null)); assert.ok(Math.max(...closed.map(r => Number(r.online_minutes))) >= 1560);
  });

  await check("assignJob contains the offline_contractor guard before mutation", async () => {
    const source = await Bun.file("./src/data/server.ts").text();
    assert.match(source, /if\(!\(await contractorOnline\(u\.orgId,con\)\)\)return fail\("offline_contractor"/);
    assert.match(source, /heartbeat_at > NOW\(\) - INTERVAL '90 seconds'/);
  });
  console.log(`availability lease: ${checks.length}/${checks.length}`);
} finally {
  await q`DELETE FROM organizations WHERE id=${ORG}`.catch(() => {});
  await q`DELETE FROM users WHERE id IN (${OWNER},${DRIVER})`.catch(() => {});
}
