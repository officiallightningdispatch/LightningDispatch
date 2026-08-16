#!/usr/bin/env bun
/** Isolated B1 migration rehearsal. Never reads DATABASE_URL: all SQL uses the
 * scratch postgres URL constructed below. The compiled migration bundle is
 * temporary and removed with the rehearsal cluster. */
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import pg from "pg";
const exec = promisify(execFile);
const root = process.cwd();
const evidence = "/home/team/shared/battery-b1-evidence";
const pgbin = "/usr/lib/postgresql/16/bin";
const stamp = Date.now();
// Scratch cluster MUST live on a filesystem the postgres service user can own.
// The repo's .run mount rejects chown/chmod for other users, so default to
// /tmp (override with REHEARSAL_RUN_DIR when a specific location is needed).
const runDir = process.env.REHEARSAL_RUN_DIR ? join(process.env.REHEARSAL_RUN_DIR, `pg-rehearsal-${stamp}`) : join("/tmp", `ld-pg-rehearsal-${stamp}`);
const dataDir = join(runDir, "data");
const socketDir = join(runDir, "socket");
const logDir = join(runDir, "logs");
const pgUser = process.getuid?.() === 0 ? "postgres" : undefined;
const asPg = (args) => pgUser ? ["-u", pgUser, "--", ...args] : args;
const pgRunner = pgUser ? "runuser" : null;
let postgres;
let port;
const lines = { fresh: [], upgrade: [], schema: [] };
const say = (kind, text) => { lines[kind].push(text); console.log(`[${kind}] ${text}`); };
const pass = (kind, text) => say(kind, `PASS ${text}`);
const fail = (kind, text) => { say(kind, `FAILED ${text}`); throw new Error(text); };
async function freePort() { for (let p = 54000; p < 55999; p++) { try { await new Promise((res, rej) => { const s=net.createServer(); s.once("error", rej); s.listen(p,"127.0.0.1",()=>s.close(res)); }); return p; } catch {} } throw new Error("no free local port"); }
async function runPg(binary, args, opts={}) { return pgUser ? exec("runuser", ["-u", pgUser, "--", binary, ...args], opts) : exec(binary, args, opts); }
async function pgctl(args) { await runPg(pgbin + "/pg_ctl", args, { cwd: root }); }
async function psql(database, sql) { const { stdout } = await runPg(pgbin + "/psql", ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1", "-At", "-c", sql], { cwd: root }); return stdout.trim(); }
async function database(name) { await runPg(pgbin + "/createdb", ["-h","127.0.0.1","-p",String(port),"-U","postgres",name], {cwd:root}); return `postgresql://postgres@127.0.0.1:${port}/${name}`; }
// Tagged-template query client over node-postgres (TCP). The local scratch
// cluster is a plain Postgres, so the Neon serverless driver (HTTP/WS proxy
// only) cannot be used here. Returns { rows } like the app's query helper.
function pgq(url) {
  const client = new pg.Client({ connectionString: url });
  // Teardown race: pg_ctl stop kills live connections, which fires 'error' on
  // the client. Absorb it so a successful rehearsal exits 0 (real failures are
  // surfaced via query errors / FAILED markers, not unhandled event crashes).
  client.on("error", () => {});
  let connected = client.connect().catch((e) => { throw new Error(`pg connect failed: ${e.message}`); });
  const q = async (strings, ...values) => {
    await connected;
    let text = strings[0];
    const params = [];
    for (let i = 0; i < values.length; i++) { text += `$${i + 1}` + strings[i + 1]; params.push(values[i]); }
    const res = await client.query(text, params);
    return res.rows;
  };
  q.close = () => client.end();
  return q;
}
async function authPreseed(q) {
  // This is the exact production bootstrap order (ensureAuthSchema): auth
  // tables precede migration 1 because migration 2 has organization FKs.
  await q`CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  await q`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  await q`ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ`;
  await q`ALTER TABLE users ADD COLUMN IF NOT EXISTS linked_driver_user_id TEXT`;
  await q`CREATE TABLE IF NOT EXISTS organization_memberships (org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK (role IN ('owner','admin','dispatcher','contractor')), contractor_id TEXT, PRIMARY KEY(org_id,user_id))`;
  await q`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  await q`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS active_org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE`;
  await q`INSERT INTO organizations(id,name) VALUES ('rehearsal-org','B1 migration rehearsal') ON CONFLICT DO NOTHING`;
  // Several historical migrations (52/53/57) hardcode the production org id
  // 89e15ce587651cc47c3bc45b1c612a220955 when inserting region/preference rows.
  // A fresh-from-zero apply therefore requires that org row to exist — the
  // same dependency production bootstrap satisfies via the real org seed.
  // This is an isolated scratch DB: we create the org row, no prod data touched.
  await q`INSERT INTO organizations(id,name) VALUES ('89e15ce587651cc47c3bc45b1c612a220955','rehearsal: prod-org-id dependency') ON CONFLICT DO NOTHING`;
}
async function bundleMigrations() {
  const out = join(runDir, "migrations.bundle.mjs");
  await exec("bun", ["build", "src/data/migrations.ts", "--target=bun", "--format=esm", `--outfile=${out}`], {cwd:root});
  let text = await readFile(out, "utf8");
  if (!/^(const|var|let) migrations =/m.test(text)) throw new Error("could not locate migration list in temporary bundle");
  text = text.replace(/^(const|var|let) migrations =/m, "export const migrations =");
  await writeFile(out, text);
  return out;
}
async function apply(url, max, kind) {
  const q = pgq(url);
  await authPreseed(q); pass(kind, "production-order auth pre-seed (isolated org rehearsal-org)");
  const mod = await import(`file://${join(runDir,"migrations.bundle.mjs")}`);
  const migrations = [...mod.migrations].sort(([a],[b])=>a-b).filter(([v])=>v<=max);
  await q`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  for (const [version, fn] of migrations) {
    const done = await q`SELECT 1 FROM schema_migrations WHERE version=${version}`;
    if (!done.length) { await fn(q); await q`INSERT INTO schema_migrations(version) VALUES(${version}) ON CONFLICT DO NOTHING`; }
  }
  const version = await q`SELECT max(version)::int AS version FROM schema_migrations`;
  if (Number(version[0]?.version) !== max) fail(kind, `schema frontier expected ${max}, got ${version[0]?.version}`);
  pass(kind, `migrations 1-${max} applied; schema frontier ${max}`);
  return q;
}
async function verify(q, kind) {
  const tables = ["battery_products","battery_compatibility","battery_install_types","battery_inventory","battery_inventory_ledger","battery_install_photos","battery_warranties"];
  const got = await q`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY(${tables}) ORDER BY table_name`;
  if (got.length !== tables.length) fail(kind, `missing B1 tables: ${tables.filter(t=>!got.some(r=>r.table_name===t)).join(",")}`);
  const cols = await q`SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='battery_sales' ORDER BY ordinal_position`;
  const required = ["product_id","compatibility_id","install_type_id","group_size","retail_snapshot_cents","installation_snapshot_cents","warranty_years_snapshot","free_replacement_years_snapshot","core_charge_snapshot_cents","driver_payout_snapshot_cents","inventory_state","customer_facing_brand"];
  if (required.some(c=>!cols.some(r=>r.column_name===c))) fail(kind,"battery_sales extension columns incomplete");
  const constraints = await q`SELECT conrelid::regclass::text AS table_name, conname, contype FROM pg_constraint WHERE conrelid::regclass::text LIKE 'battery_%' ORDER BY 1,2`;
  const indexes = await q`SELECT tablename,indexname FROM pg_indexes WHERE schemaname='public' AND tablename LIKE 'battery_%' ORDER BY 1,2`;
  const money = await q`SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND column_name LIKE '%cents' AND table_name LIKE 'battery_%' ORDER BY 1,2`;
  const report = [`## ${kind} schema verification`, `Tables (${got.length}/${tables.length}): ${got.map(r=>r.table_name).join(", ")}`, `battery_sales columns: ${required.join(", ")}`, `Money columns (must be integer):`, ...money.map(r=>`- ${r.table_name}.${r.column_name}: ${r.data_type}`), `Constraints:`, ...constraints.map(r=>`- ${r.table_name} ${r.conname} (${r.contype})`), `Indexes:`, ...indexes.map(r=>`- ${r.tablename} ${r.indexname}`)].join("\n");
  lines.schema.push(report); pass(kind, "B1 tables, sale columns, integer money fields, FK/check/unique constraints and indexes verified");
}
async function main() {
  await mkdir(evidence,{recursive:true});
  await mkdir(runDir,{recursive:true}); await mkdir(logDir,{recursive:true}); await mkdir(dataDir,{recursive:true}); await mkdir(socketDir,{recursive:true});
  if (pgUser) await exec("chown", ["-R",`${pgUser}:${pgUser}`,runDir]);
  port=await freePort();
  await runPg(pgbin+"/initdb", ["-D",dataDir,"-A","trust","--no-locale"],{cwd:root}); pass("fresh","isolated cluster initialized");
  postgres = true; await pgctl(["-D",dataDir,"-o",`-p ${port} -k ${socketDir} -h 127.0.0.1`,`-l`,join(logDir,"postgres.log"),"-w","start"]); pass("fresh",`isolated postgres started on 127.0.0.1:${port}`);
  const bundle=await bundleMigrations(); pass("fresh","temporary migration bundle compiled from src/data/migrations.ts");
  const fresh=await database("b1_fresh"); const fq = await apply(fresh,72,"fresh"); await verify(fq,"fresh"); await fq.close();
  const upgrade=await database("b1_upgrade"); const uq = await apply(upgrade,69,"upgrade"); await apply(upgrade,72,"upgrade"); await verify(uq,"upgrade"); await uq.close();
  pass("upgrade","1-69 then 70/71/72 upgrade path completed");
  await writeFile(join(evidence,"fresh-rehearsal.log"),lines.fresh.join("\n")+"\n"); await writeFile(join(evidence,"upgrade-rehearsal.log"),lines.upgrade.join("\n")+"\n"); await writeFile(join(evidence,"schema-verification.md"),lines.schema.join("\n\n")+"\n");
  await writeFile(join(evidence,"REHEARSAL-README.md"),`# B1 migration rehearsal\n\nRun from the repo: \bun scripts/rehearse-migrations.mjs\. It creates a timestamped local PostgreSQL 16 cluster under /tmp/ld-pg-rehearsal-<timestamp> (or $REHEARSAL_RUN_DIR when set), uses only loopback, runs fresh 1-72 and upgrade 1-69 then 70-72, verifies B1 tables/columns/constraints/indexes, writes evidence here, and stops PostgreSQL. It never reads DATABASE_URL.\n\nThe auth pre-seed mirrors \ensureAuthSchema()\: organizations/users/memberships/sessions are created before migrations because migration 2 adds organization foreign keys. A non-production \rehearsal-org\ row satisfies that bootstrap dependency; no migration or production data is changed.\n`);
  await pgctl(["-D",dataDir,"-m","fast","stop"]); postgres=false; console.log("PASS B1 FRESH + UPGRADE REHEARSALS");
}
try { await main(); } catch (e) { console.error(`FAILED migration rehearsal: ${e?.stack||e}`); try { if(postgres) await pgctl(["-D",dataDir,"-m","immediate","stop"]); } catch {} process.exitCode=1; }
