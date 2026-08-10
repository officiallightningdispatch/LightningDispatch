#!/usr/bin/env bun
// QA seed (FIXED r10): idempotent, tag-parameterized throwaway org for
// verifying the three portals end-to-end on localhost:3000.
//
// Dataset per tag: a QA org, owner + dispatcher + 2 contractor user accounts,
// 2 dispatch_contractors, jobs spanning the full lifecycle
// (new / offered / en_route / completed) WITH a status_events history that
// carries REAL actor user ids (every event references a seeded users row),
// plus a fake towbook_sessions row for last_result persistence checks.
//
// Idempotent: delete-then-insert for the tag's org (FK order: status_events,
// audit_log, dispatch_jobs, dispatch_contractors, organization_memberships,
// towbook_sessions, users, organizations) — safe to re-run.
//
// Usage: DATABASE_URL=... bun scripts/qa-seed-r9.mjs [tag]   (tag default: nav-r10)
import { neon } from "../node_modules/@neondatabase/serverless/index.js";
import { scryptSync } from "node:crypto";
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const q = neon(process.env.DATABASE_URL);

const TAG = String(process.argv[2] || "nav-r10").replace(/[^a-z0-9-]/gi, "");
const A = `qa-${TAG}`;                      // org id
const UO = `qa-user-owner-${TAG}`;          // owner
const UD = `qa-user-ops-${TAG}`;            // dispatcher
const UC1 = `qa-user-contractor1-${TAG}`;   // contractor 1 login
const UC2 = `qa-user-contractor2-${TAG}`;   // contractor 2 login
const C1 = `qa-contractor1-${TAG}`;
const C2 = `qa-contractor2-${TAG}`;
const J1 = `qa-job-new-${TAG}`;
const J2 = `qa-job-offered-${TAG}`;
const J3 = `qa-job-active-${TAG}`;
const J4 = `qa-job-done-${TAG}`;
// >= 10 chars — the login form enforces minLength 10.
const PASSWORD = "QaNavR10Pass!";
const salt = `qa-salt-${TAG}`;
const HASH = `${salt}:${scryptSync(PASSWORD, salt, 64).toString("hex")}`;
const email = (id) => `${id}@lightning.test`;

try {
  // ---- idempotent wipe (FK order) ----
  await q`DELETE FROM status_events WHERE org_id=${A}`;
  await q`DELETE FROM audit_log WHERE org_id=${A}`;
  await q`DELETE FROM dispatch_jobs WHERE org_id=${A}`;
  await q`DELETE FROM dispatch_contractors WHERE org_id=${A}`;
  await q`DELETE FROM organization_memberships WHERE org_id=${A}`;
  await q`DELETE FROM towbook_sessions WHERE org_id=${A}`;
  await q`DELETE FROM users WHERE id IN (${UO},${UD},${UC1},${UC2})`;
  await q`DELETE FROM organizations WHERE id=${A}`;

  // ---- org + users ----
  await q`INSERT INTO organizations(id,name) VALUES (${A},${`QA Nav ${TAG}`})`;
  await q`INSERT INTO users(id,name,email,password_hash) VALUES
    (${UO},'QA Nav Owner',${email(UO)},${HASH}),
    (${UD},'QA Nav Dispatcher',${email(UD)},${HASH}),
    (${UC1},'QA Driver One',${email(UC1)},${HASH}),
    (${UC2},'QA Driver Two',${email(UC2)},${HASH})`;
  await q`INSERT INTO organization_memberships(org_id,user_id,role,contractor_id) VALUES
    (${A},${UO},'owner',NULL),
    (${A},${UD},'dispatcher',NULL),
    (${A},${UC1},'contractor',${C1}),
    (${A},${UC2},'contractor',${C2})`;

  // ---- contractors (roster) ----
  await q`INSERT INTO dispatch_contractors(id,name,status,lat,lng,area,vehicle_types,rating,completed_job_count,response_time_history_minutes,org_id) VALUES
    (${C1},'QA Driver One','online',40.1,-75.1,'QA','["flatbed_tow","jump_start"]',4.8,3,'[12,15,10]',${A}),
    (${C2},'QA Driver Two','online',40.2,-75.2,'QA','["tire_change","lockout","fuel_delivery"]',4.9,5,'[8,9,11,7,10]',${A})`;

  // ---- jobs spanning the lifecycle ----
  await q`INSERT INTO dispatch_jobs(id,customer_name,phone,lat,lng,area,service_type,status,created_at,assigned_at,arrived_at,completed_at,assigned_contractor_id,note,org_id) VALUES
    (${J1},'QA New Call','555-0100',40.1,-75.1,'QA','jump_start','new',NOW()-INTERVAL '5 min',NULL,NULL,NULL,NULL,'incoming — awaiting assignment',${A}),
    (${J2},'QA Offered Call','555-0101',40.1,-75.1,'QA','tire_change','offered',NOW()-INTERVAL '30 min',NOW()-INTERVAL '25 min',NULL,NULL,${C1},'awaiting driver acceptance',${A}),
    (${J3},'QA Active Call','555-0102',40.1,-75.1,'QA','flatbed_tow','en_route',NOW()-INTERVAL '50 min',NOW()-INTERVAL '45 min',NULL,NULL,${C1},'driver en route to customer',${A}),
    (${J4},'QA Done Call','555-0103',40.1,-75.1,'QA','lockout','completed',NOW()-INTERVAL '3 hours',NOW()-INTERVAL '170 min',NOW()-INTERVAL '130 min',NOW()-INTERVAL '2 hours',${C2},'completed — lockout resolved',${A})`;

  // ---- status_events history (REAL actor ids; no NULLs) ----
  await q`INSERT INTO status_events(id,org_id,job_id,from_status,to_status,actor_user_id,actor_role,occurred_at) VALUES
    (gen_random_uuid()::text,${A},${J1},'import','new',${UO},'system',NOW()-INTERVAL '5 min'),
    (gen_random_uuid()::text,${A},${J2},'import','new',${UO},'system',NOW()-INTERVAL '30 min'),
    (gen_random_uuid()::text,${A},${J2},'new','offered',${UD},'dispatcher',NOW()-INTERVAL '25 min'),
    (gen_random_uuid()::text,${A},${J3},'import','new',${UO},'system',NOW()-INTERVAL '50 min'),
    (gen_random_uuid()::text,${A},${J3},'new','offered',${UD},'dispatcher',NOW()-INTERVAL '45 min'),
    (gen_random_uuid()::text,${A},${J3},'offered','accepted',${UC1},'contractor',NOW()-INTERVAL '40 min'),
    (gen_random_uuid()::text,${A},${J3},'accepted','en_route',${UC1},'contractor',NOW()-INTERVAL '38 min'),
    (gen_random_uuid()::text,${A},${J4},'import','new',${UO},'system',NOW()-INTERVAL '3 hours'),
    (gen_random_uuid()::text,${A},${J4},'new','offered',${UD},'dispatcher',NOW()-INTERVAL '175 min'),
    (gen_random_uuid()::text,${A},${J4},'offered','accepted',${UC2},'contractor',NOW()-INTERVAL '170 min'),
    (gen_random_uuid()::text,${A},${J4},'accepted','en_route',${UC2},'contractor',NOW()-INTERVAL '160 min'),
    (gen_random_uuid()::text,${A},${J4},'en_route','arrived',${UC2},'contractor',NOW()-INTERVAL '130 min'),
    (gen_random_uuid()::text,${A},${J4},'arrived','completed',${UC2},'contractor',NOW()-INTERVAL '120 min')`;

  // ---- fake connected Towbook session (for last_result persistence checks) ----
  await q`INSERT INTO towbook_sessions(org_id,encrypted_session,status,error,updated_at) VALUES (${A},'broken-qa-session','connected',NULL,NOW())`;

  // ---- verification summary ----
  const v = await q`SELECT
      (SELECT count(*)::int FROM users WHERE id IN (${UO},${UD},${UC1},${UC2})) AS users,
      (SELECT count(*)::int FROM organization_memberships WHERE org_id=${A}) AS memberships,
      (SELECT count(*)::int FROM dispatch_contractors WHERE org_id=${A}) AS contractors,
      (SELECT count(*)::int FROM dispatch_jobs WHERE org_id=${A}) AS jobs,
      (SELECT count(*)::int FROM status_events WHERE org_id=${A}) AS events,
      (SELECT count(*)::int FROM status_events WHERE org_id=${A} AND actor_user_id IS NULL) AS null_actors,
      (SELECT count(*)::int FROM towbook_sessions WHERE org_id=${A}) AS sessions`;
  const m = await q`SELECT max(version)::int v FROM schema_migrations`;
  const jobs = await q`SELECT status, count(*)::int c FROM dispatch_jobs WHERE org_id=${A} GROUP BY status ORDER BY status`;
  console.log("SEEDED ok:", JSON.stringify(v[0]), "| jobs by status:", JSON.stringify(jobs), "| schema_migrations =", m[0]?.v, "(expect 7)");
  console.log("QA accounts (password:", PASSWORD + "):");
  console.log(`  owner      ${email(UO)}  -> /owner`);
  console.log(`  dispatcher ${email(UD)}  -> /ops`);
  console.log(`  driver     ${email(UC1)}  -> /driver (contractor ${C1})`);
  console.log(`  driver2    ${email(UC2)}  -> /driver (contractor ${C2})`);
} catch (e) { console.error("SEED FAIL", e.message); process.exit(1); }
