// Hermetic national ZIP partition invariants. Corridor/coverage zones are radius-only by design.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import fs from "node:fs";
const q = neon(process.env.DATABASE_URL);
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const ORG = `qa-zips-${randomUUID()}`;
const OWNER = `qa-zips-owner-${randomUUID()}`;
const data = JSON.parse(fs.readFileSync(new URL("./src/data/national-zones.json", import.meta.url), "utf8"));
const idFor = (key) => `qa-zips-zone-${key.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}`;
const checks = [];
async function check(name, fn) { try { await fn(); checks.push([name, true]); console.log(`PASS ${name}`); } catch (e) { checks.push([name, false]); console.error(`FAIL ${name}: ${e.message}`); throw e; } }
let created = false;
try {
  await ensureSchema();
  await q`INSERT INTO organizations(id,name) VALUES(${ORG},'QA zones ZIP invariants')`;
  await q`INSERT INTO users(id,name,email,password_hash) VALUES(${OWNER},'QA ZIP owner',${OWNER+'@qa.local'},'x')`;
  await q`INSERT INTO organization_memberships(org_id,user_id,role) VALUES(${ORG},${OWNER},'owner')`;
  for (const z of data) await q`INSERT INTO dispatch_zones(id,org_id,name,state,market,zone_type,zip_codes,lat,lng,radius_miles,tz,active,sort_order) VALUES(${idFor(z.key)},${ORG},${z.name},${z.state},${z.market},${z.zone_type},${z.zip_codes ?? []},${z.lat},${z.lng},${z.radius_miles ?? 10},${z.tz},TRUE,${data.indexOf(z)})`;
  created = true;
  await check("DATASET KEYS UNIQUE", async () => { const keys = data.map(z => z.key); assert.equal(new Set(keys).size, keys.length); });
  await check("NON-COVERAGE PARTITION ZONES HAVE ZIPs", async () => { const rows = await q`SELECT name,zone_type,cardinality(zip_codes)::int n FROM dispatch_zones WHERE org_id=${ORG} AND zone_type NOT IN ('coverage','corridor')`; assert.ok(rows.length > 0); assert.ok(rows.every(r => r.n >= 1), JSON.stringify(rows.filter(r => r.n < 1))); });
  await check("ZIPs ARE UNIQUE", async () => { const rows = await q`SELECT unnest(zip_codes) zip FROM dispatch_zones WHERE org_id=${ORG} GROUP BY zip HAVING count(*) > 1`; assert.equal(rows.length, 0); });
  await check("COVERAGE AND CORRIDOR ARE RADIUS-ONLY", async () => { const rows = await q`SELECT zone_type,cardinality(zip_codes)::int n FROM dispatch_zones WHERE org_id=${ORG} AND zone_type IN ('coverage','corridor')`; assert.ok(rows.length > 0); assert.ok(rows.every(r => r.n === 0)); });
} finally {
  if (created) { assertQaOrg(ORG); await q`DELETE FROM organizations WHERE id=${ORG}`; await q`DELETE FROM users WHERE id=${OWNER}`; }
}
console.log(`zones-zips suite complete: ${checks.filter(x => x[1]).length}/${checks.length}`);
if (checks.some(x => !x[1])) process.exitCode = 1;
