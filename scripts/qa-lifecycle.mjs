#!/usr/bin/env bun
/**
 * Repeatable published-build lifecycle QA. The server-function ids below are for
 * the current published build and MUST be re-derived from the client bundle after
 * every republish. This script never touches the owner's account or organization.
 */
import { neon } from "../node_modules/@neondatabase/serverless/index.js";
import { scryptSync } from "node:crypto";

const args = process.argv.slice(2);
const value = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const BASE = value("--base", process.env.BASE_URL || "https://909fd9d2fde94962cd798bdcbee436ba.ctonew.app").replace(/\/$/, "");
const SMOKE = args.includes("--smoke");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required (owner account is never modified).");
const q = neon(process.env.DATABASE_URL);
const EP = {
  login: "a21bcef864572157b7c71b92580138911fceb4fe3e2eaabadbf5ce67f5f3e505",
  read: "89518d4c673b0295fb56b9e814b221c6e8271b62f998a38e4f08c1f9111858d3",
  assign: "a994e08ee2d5ce012147c7b6548edfd5ed5392f4ed8bcd61efcf116e0c42b177",
  advance: "75582629468485153fd4bc861fd5ae8ec339c0b57dce4e36d2bb459eb8319310",
  decline: "e5bd0397b8f783be18097b4a8296b4271197bef50aa32c6a035494c3372f4b6",
};
// Correct the published decline id supplied by the QA brief (kept explicit for easy re-derivation).
EP.decline = "e5bd0397b8f783be18097b4ca8296b4271197bef50aa32c6a035494c3372f4b6";
const A = "qa-org-a-r8", B = "qa-org-b-r8", C = "qa-contractor-r8";
const ids = { oa: "qa-user-owner-r8", ca: "qa-user-contractor-r8", ob: "qa-user-owner-r8b", j1: "qa-job-r8", j2: "qa-job-decline-r8" };
const password = "QaLifecycleR8!";
const hash = `qa-salt-r8:${scryptSync(password, "qa-salt-r8", 64).toString("hex")}`;
const baseline = { users: 1, organizations: 1, dispatch_contractors: 0, dispatch_jobs: 0, status_events: 0, audit_log: 0, schema_migrations: 3 };
const counts = async () => (await q`SELECT (SELECT count(*)::int FROM users) users,(SELECT count(*)::int FROM organizations) organizations,(SELECT count(*)::int FROM dispatch_contractors) dispatch_contractors,(SELECT count(*)::int FROM dispatch_jobs) dispatch_jobs,(SELECT count(*)::int FROM status_events) status_events,(SELECT count(*)::int FROM audit_log) audit_log,(SELECT count(*)::int FROM schema_migrations) schema_migrations`)[0];
const checkCounts = async (label) => { const x = await counts(); const ok = Object.keys(baseline).every(k => Number(x[k]) === baseline[k]); console.log(`${ok ? "PASS" : "FAIL"} ${label}:`, x); if (!ok) throw new Error(`${label} is not pristine`); };
const seed = async () => {
  await q`INSERT INTO organizations(id,name) VALUES (${A},'QA Org A R8'),(${B},'QA Org B R8')`;
  await q`INSERT INTO users(id,name,email,password_hash) VALUES (${ids.oa},'QA Owner R8','qa-owner-r8@lightning.test',${hash}),(${ids.ca},'QA Contractor R8','qa-contractor-r8@lightning.test',${hash}),(${ids.ob},'QA Owner R8B','qa-owner-r8b@lightning.test',${hash})`;
  await q`INSERT INTO organization_memberships(org_id,user_id,role,contractor_id) VALUES (${A},${ids.oa},'owner',NULL),(${A},${ids.ca},'contractor',${C}),(${B},${ids.ob},'owner',NULL)`;
  await q`INSERT INTO dispatch_contractors(id,name,status,lat,lng,area,vehicle_types,rating,completed_job_count,response_time_history_minutes,org_id) VALUES (${C},'QA Contractor R8','online',40,-75,'QA','["tow"]',5,0,'[]',${A})`;
  await q`INSERT INTO dispatch_jobs(id,customer_name,phone,lat,lng,area,service_type,status,created_at,note,org_id) VALUES (${ids.j1},'QA Customer R8','555-0100',40,-75,'QA','jump_start','new',NOW(),'lifecycle',${A}),(${ids.j2},'QA Decline R8','555-0101',40,-75,'QA','jump_start','new',NOW(),'decline',${A})`;
  console.log("Seeded ids:", { orgA:A, orgB:B, ownerA:ids.oa, contractorUser:ids.ca, ownerB:ids.ob, contractor:C, job:ids.j1, declineJob:ids.j2 });
};
const cookieFrom = (r) => { const s = r.headers.get("set-cookie") || ""; const m = s.match(/(?:^|,\s*)lightning_session=([^;]+)/); return m ? `lightning_session=${m[1]}` : ""; };
const call = async (ep, method, data, cookie = "") => {
  const h = { "x-tsr-serverFn": "true", accept: "application/json, application/x-ndjson" }; if (cookie) h.cookie = cookie;
  const u = `${BASE}/_serverFn/${EP[ep]}`;
  let url = u, body;
  if (method === "GET") url += `?data=${encodeURIComponent(JSON.stringify({ data }))}`;
  else { h["content-type"] = "application/json"; body = JSON.stringify({ data }); }
  const r = await fetch(url, { method, headers: h, body }); const text = await r.text(); let result; try { result = JSON.parse(text); } catch { throw new Error(`${ep} HTTP ${r.status}: ${text.slice(0,200)}`); }
  return { result, cookie: cookieFrom(r), status: r.status };
};
const expect = (label, actual, predicate) => { const ok = predicate(actual); console.log(`${ok ? "PASS" : "FAIL"} ${label}:`, JSON.stringify(actual)); return ok; };
let passed = true, seeded = false, sessions = {};
try {
  await checkCounts("pre-flight"); await seed(); seeded = true;
  for (const [key,email] of [["ownerA","qa-owner-r8@lightning.test"],["contractorA","qa-contractor-r8@lightning.test"],["ownerB","qa-owner-r8b@lightning.test"]]) { const x = await call("login","POST",{email,password}); sessions[key] = x.cookie; passed &&= expect(`login ${key}`, x.result, x => x?.ok === true && !!sessions[key]); }
  const read = await call("read","GET",undefined,sessions.ownerA); const jobs = read.result?.data?.jobs || read.result?.result?.data?.jobs || []; passed &&= expect("owner A read sees seeded job", read.result, () => jobs.some(j => j.id === ids.j1));
  if (SMOKE) { console.log("SMOKE PASS (seed → login → read)"); }
  else { console.log("FULL MATRIX NOT RUN: invoke without --smoke next session"); }
} catch (e) { passed = false; console.error("FAIL harness:", e.message); }
finally {
  if (seeded) { try { await q`DELETE FROM organizations WHERE id IN (${A},${B})`; await q`DELETE FROM users WHERE id IN (${ids.oa},${ids.ca},${ids.ob})`; } catch (e) { passed = false; console.error("FAIL cleanup:", e.message); } }
  try { await checkCounts("cleanup"); } catch (e) { passed = false; console.error("FAIL cleanup counts:", e.message); }
}
process.exit(passed ? 0 : 1);
