#!/usr/bin/env bun
// QA r9: seed a throwaway org, verify data-backed tabs + last_result persistence
// against the RUNNING server (localhost:3000), then clean up. Run from site dir.
import { neon } from "../node_modules/@neondatabase/serverless/index.js";
import { scryptSync } from "node:crypto";
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const q = neon(process.env.DATABASE_URL);
const A = "qa-nav-r9", C = "qa-contractor-r9", U = "qa-user-owner-r9",
  J1 = "qa-job-new-r9", J2 = "qa-job-active-r9", J3 = "qa-job-done-r9";
const password = "QaNavR9!!", hash = `qa-salt-r9:${scryptSync(password, "qa-salt-r9", 64).toString("hex")}`;
try {
  await q`DELETE FROM status_events WHERE org_id=${A}`;
  await q`DELETE FROM dispatch_jobs WHERE org_id=${A}`;
  await q`DELETE FROM dispatch_contractors WHERE org_id=${A}`;
  await q`DELETE FROM organization_memberships WHERE org_id=${A}`;
  await q`DELETE FROM towbook_sessions WHERE org_id=${A}`;
  await q`DELETE FROM users WHERE id=${U}`;
  await q`DELETE FROM organizations WHERE id=${A}`;
  await q`INSERT INTO organizations(id,name) VALUES (${A},'QA Nav R9')`;
  await q`INSERT INTO users(id,name,email,password_hash) VALUES (${U},'QA Nav Owner','qa-nav-owner-r9@lightning.test',${hash})`;
  await q`INSERT INTO organization_memberships(org_id,user_id,role) VALUES (${A},${U},'owner')`;
  await q`INSERT INTO dispatch_contractors(id,name,status,lat,lng,area,vehicle_types,rating,completed_job_count,response_time_history_minutes,org_id) VALUES (${C},'QA Nav Contractor','online',40.1,-75.1,'QA','["tow","jump_start"]',4.8,1,'[12]',${A})`;
  await q`INSERT INTO dispatch_jobs(id,customer_name,phone,lat,lng,area,service_type,status,created_at,assigned_at,completed_at,assigned_contractor_id,note,org_id) VALUES
    (${J1},'QA New Call','555-0100',40.1,-75.1,'QA','jump_start','new',NOW(),NULL,NULL,NULL,'incoming',${A}),
    (${J2},'QA Active Call','555-0101',40.1,-75.1,'QA','tow','en_route',NOW()-INTERVAL '20 min',NOW()-INTERVAL '15 min',NULL,${C},'in flight',${A}),
    (${J3},'QA Done Call','555-0102',40.1,-75.1,'QA','tow','completed',NOW()-INTERVAL '3 hours',NOW()-INTERVAL '170 min',NOW()-INTERVAL '2 hours',${C},'done',${A})`;
  await q`INSERT INTO status_events(id,org_id,job_id,from_status,to_status,actor_user_id,actor_role,occurred_at) VALUES
    (gen_random_uuid()::text,${A},${J3},'import','new',${U},'system',NOW()-INTERVAL '3 hours'),
    (gen_random_uuid()::text,${A},${J3},'new','offered',${U},'owner',NOW()-INTERVAL '175 min'),
    (gen_random_uuid()::text,${A},${J3},'offered''accepted',,'contractor',NOW()-INTERVAL '170 min'),
    (gen_random_uuid()::text,${A},${J3},'en_route''arrived',,'contractor',NOW()-INTERVAL '130 min'),
    (gen_random_uuid()::text,${A},${J3},'arrived''completed',,'contractor',NOW()-INTERVAL '120 min')`;
  await q`INSERT INTO towbook_sessions(org_id,encrypted_session,status,error,updated_at) VALUES (${A},'broken-qa-session','connected',NULL,NOW())`;
  const m = await q`SELECT max(version)::int v FROM schema_migrations`;
  console.log("SEEDED ok; schema_migrations=", m[0]?.v, "(expect 7)");
} catch (e) { console.error("SEED FAIL", e.message); process.exit(1); }
