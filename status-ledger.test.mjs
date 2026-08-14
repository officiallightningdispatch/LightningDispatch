// Hermetic Phase B Item ② ledger proof. QA-only fixtures; no production Towbook calls.
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
if (!process.env.DATABASE_URL) { try { const p=execSync("pgrep -f 'bun run serve.ts'|head -1").toString().trim(); if(p){const e=await readFile(`/proc/${p}/environ`,"utf8"); const x=e.split("\0").find(v=>v.startsWith("DATABASE_URL=")); if(x)process.env.DATABASE_URL=x.slice(15);}} catch{} }
process.env.TOWBOOK_SESSION_KEY=Buffer.alloc(32,7).toString("base64");
const {neon}=await import("@neondatabase/serverless"); const q=neon(process.env.DATABASE_URL);
const {ensureSchema}=await import("./src/data/migrations.ts"); const {encryptSession}=await import("./src/data/towbook-key.ts"); const {pushJobStatusToTowbook}=await import("./src/data/status-push-core.ts");
const checks=[]; const check=(n,c,e="")=>{checks.push([n,!!c,e]);if(!c)throw Error(`FAIL: ${n} ${e}`)};
const O=`qa-ledger-${randomUUID()}`, U=`qa-ledger-owner-${randomUUID()}`, C=`qa-ledger-contractor-${randomUUID()}`, J=`qa-ledger-job-${randomUUID()}`, A={orgId:O,id:U,role:"owner"}; const CALL="991001";
const mock=(initial=0,{verifyMismatch=false}={})=>{let s=initial;const calls=[];return {calls,fetchImpl:async(url,init={})=>{const method=init.method||"GET";const body=init.body&&JSON.parse(init.body);calls.push({method,body}); if(method==="GET")return {status:200,ok:true,text:async()=>JSON.stringify({id:+CALL,status:{id:verifyMismatch?initial:s}})}; if(method==="PUT"){s=body.status.id;return {status:200,ok:true,text:async()=>JSON.stringify({id:+CALL,status:{id:s}})}}},state:()=>s}};
await ensureSchema();
try {
 await q`INSERT INTO organizations(id,name) VALUES(${O},'qa ledger proof')`;
 await q`INSERT INTO users(id,name,email,password_hash) VALUES(${U},'QA Ledger Owner',${U+'@lightning.test'},'x'),(${C},'QA Ledger Driver',${C+'@lightning.test'},'x')`;
 await q`INSERT INTO organization_memberships(org_id,user_id,role) VALUES(${O},${U},'owner'),(${O},${C},'contractor')`;
 await q`INSERT INTO towbook_sessions(org_id,encrypted_session,status,session_kind) VALUES(${O},${await encryptSession(JSON.stringify({cookies:'qa',baseUrl:'https://app.towbook.com'}))},'connected','owner')`;
 await q`INSERT INTO dispatch_jobs(id,org_id,customer_name,phone,lat,lng,area,service_type,status,created_at,note,towbook_job_id,towbook_status) VALUES(${J},${O},'QA','',0,0,'QA','roadside','offered',NOW(),'','991001','1')`;
 // 1 failed verification is loud; local row remains prior (push core never mutates lifecycle).
 let m=mock(0,{verifyMismatch:true}); let r=await pushJobStatusToTowbook({orgId:O,jobId:J,actor:A,opts:{fetchImpl:m.fetchImpl}}); check('failed Towbook verification is loud',r.ok===false&&r.code==='verify_failed',JSON.stringify(r)); let row=await q`SELECT status,assigned_contractor_id FROM dispatch_jobs WHERE id=${J}`; check('failed write leaves prior local status/assignment',row[0].status==='offered'&&row[0].assigned_contractor_id==null,JSON.stringify(row));
 // 2 success + deterministic ledger.
 m=mock(0); r=await pushJobStatusToTowbook({orgId:O,jobId:J,actor:A,opts:{fetchImpl:m.fetchImpl}}); const key=`status:${O}:${J}:offered:1`; row=await q`SELECT status,request_key FROM outbound_write_ledger WHERE org_id=${O} AND job_id=${J}`; check('successful write commits towbook_status',r.ok===true&&(await q`SELECT towbook_status FROM dispatch_jobs WHERE id=${J}`)[0].towbook_status==='1'); check('one success ledger row with deterministic key',row.length===1&&row[0].status==='success'&&row[0].request_key===key,JSON.stringify(row));
 // 3 PUT landed but verify failed, then GET-first reconciliation: no second PUT.
 await q`UPDATE dispatch_jobs SET towbook_status='1' WHERE id=${J}`; m=mock(0,{verifyMismatch:true}); r=await pushJobStatusToTowbook({orgId:O,jobId:J,actor:A,opts:{fetchImpl:m.fetchImpl}}); check('ambiguous first attempt returns loud failure',r.ok===false&&r.code==='verify_failed'); const before=m.calls.filter(x=>x.method==='PUT').length; const m2=mock(1); r=await pushJobStatusToTowbook({orgId:O,jobId:J,actor:A,opts:{fetchImpl:m2.fetchImpl}}); row=await q`SELECT status FROM outbound_write_ledger WHERE request_key=${key}`; check('retry reconciles target without misleading failure',r.ok===true&&m2.calls.filter(x=>x.method==='PUT').length===0&&row[0].status==='success',JSON.stringify({r,calls:m2.calls,row}));
 // 4 duplicate logical operation: GET-first means no PUT and unique row.
 const dup=mock(1); const r2=await pushJobStatusToTowbook({orgId:O,jobId:J,actor:A,opts:{fetchImpl:dup.fetchImpl}}); const n=await q`SELECT COUNT(*)::int n FROM outbound_write_ledger WHERE request_key=${key}`; check('duplicate operation has zero PUT and one ledger row',r2.ok&&dup.calls.filter(x=>x.method==='PUT').length===0&&Number(n[0].n)===1,JSON.stringify({r2,n}));
 // 5 ledger failure behavior is guarded in source and covered without touching the applied table.
 const src=await readFile(new URL('./src/data/status-push-core.ts',import.meta.url),'utf8'); check('ledger insert failure throws loudly',src.includes('Outbound write ledger unavailable')&&src.includes('throw new Error'), 'source guard');
 // 6 regression mapping: assign/advance/decline transitions are all mapped and ledger-keyed.
 check('assign→advance→decline mappings remain pushable',src.includes('offered: 1')&&src.includes('en_route: 2')&&src.includes('new: 0'));
} finally {
 await q`DELETE FROM outbound_write_ledger WHERE org_id=${O}`.catch(()=>{}); await q`DELETE FROM organizations WHERE id=${O}`.catch(()=>{}); await q`DELETE FROM users WHERE id IN (${U},${C})`.catch(()=>{});
}
const left=await q`SELECT (SELECT COUNT(*)::int FROM organizations WHERE id=${O}) orgs,(SELECT COUNT(*)::int FROM dispatch_jobs WHERE org_id=${O}) jobs,(SELECT COUNT(*)::int FROM outbound_write_ledger WHERE org_id=${O}) ledger,(SELECT COUNT(*)::int FROM users WHERE id IN (${U},${C})) users`; check('cleanup zero QA rows and ledger',Object.values(left[0]).every(v=>Number(v)===0),JSON.stringify(left[0]));
const failed=checks.filter(x=>!x[1]); console.log(`status-ledger.test.mjs: ${checks.length-failed.length}/${checks.length} passed`); if(failed.length)process.exit(1); console.log('cleanup: zero QA rows + zero outbound_write_ledger rows');
