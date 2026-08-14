// Phase B ④ acceptance: org-scoped driver identity, links, and driver-auth session resolution.
// QA-only DB fixtures; no Towbook calls and never touches the production org.
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
if (!process.env.DATABASE_URL) { try { const p=execSync("pgrep -f 'bun run serve.ts'|head -1").toString().trim(); if(p){const e=await readFile(`/proc/${p}/environ`,"utf8"); const x=e.split("\0").find(v=>v.startsWith("DATABASE_URL=")); if(x)process.env.DATABASE_URL=x.slice(15);}} catch{} }
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 9).toString("base64");
await import("@tanstack/start-server-core");
const { H3Event } = await import("h3-v2");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const { currentUser, effectiveDriverIdentity, listLinkableDriversCore, linkDriverAccountCore, unlinkDriverAccountCore } = await import("./src/data/auth-server.ts");
const checks=[]; const check=(n,c,e="")=>{checks.push([n,Boolean(c),e]);};
const suffix=`${Date.now()}-${randomUUID()}`;
const OA=`qa-os-a-${suffix}`, OB=`qa-os-b-${suffix}`;
const uid=(x)=>`qa-os-${x}-${suffix}`, email=(u)=>`${u}@lightning.test`;
const OWNERA=uid("owner-a"), OWNERB=uid("owner-b"), DA=uid("driver-a"), DB=uid("driver-b");
const TBA=`tb-os-shared-a-${suffix}`, TBB=`tb-os-shared-b-${suffix}`; // DB enforces global Towbook-driver uniqueness; same-id isolation is exercised via foreign row/user IDs.
const SA=`sess-os-a-${suffix}`, SB=`sess-os-b-${suffix}`;
const eventStorage=globalThis[Symbol.for("tanstack-start:event-storage")];
const startStorage=globalThis[Symbol.for("tanstack-start:start-storage-context")];
const withSession=(token,fn)=>{const cookie=`ld_session_v2=${token}`, h3Event=new H3Event(new Request("http://localhost/",{headers:{cookie}})), req=new Request("http://localhost/",{headers:{cookie}}); return startStorage.run({startOptions:{},request:req,contextAfterGlobalMiddlewares:null,executedRequestMiddlewares:new Set()},()=>eventStorage.run({h3Event},fn));};
const ins=(id,name)=>q`INSERT INTO users(id,name,email,password_hash) VALUES(${id},${name},${email(id)},'x')`;
try {
  await ensureSchema();
  await q`INSERT INTO organizations(id,name) VALUES(${OA},'QA org-scoping A'),(${OB},'QA org-scoping B')`;
  await ins(OWNERA,"Org A Owner"); await ins(OWNERB,"Org B Owner"); await ins(DA,"Org A Driver"); await ins(DB,"Org B Driver");
  // Separate org-local driver identities (the production schema globally uniques Towbook IDs).
  await q`UPDATE users SET towbook_driver_id=${TBA} WHERE id=${DA}`;
  await q`UPDATE users SET towbook_driver_id=${TBB} WHERE id=${DB}`;
  await q`INSERT INTO organization_memberships(org_id,user_id,role) VALUES(${OA},${OWNERA},'owner'),(${OA},${DA},'contractor'),(${OB},${OWNERB},'owner'),(${OB},${DB},'contractor')`;
  await q`INSERT INTO sessions(id,user_id,active_org_id,expires_at) VALUES(${SA},${OWNERA},${OA},NOW()+INTERVAL '1 day'),(${SB},${OWNERB},${OB},NOW()+INTERVAL '1 day')`;
  // (a) direct effective identity is org-joined; a foreign linked id cannot resolve.
  const ia=await effectiveDriverIdentity({id:OWNERA,name:"Org A Owner",email:email(OWNERA),role:"owner",orgId:OA,linkedDriverUserId:DA,driverIdentity:null});
  check("effectiveDriverIdentity resolves same-org contractor",ia?.userRowId===DA&&ia?.towbookDriverId===TBA,JSON.stringify(ia));
  const foreign=await effectiveDriverIdentity({id:OWNERA,name:"Org A Owner",email:email(OWNERA),role:"owner",orgId:OA,linkedDriverUserId:DB,driverIdentity:null});
  check("effectiveDriverIdentity rejects foreign-org contractor",foreign===null,JSON.stringify(foreign));
  // (a/e) picker is constrained to the actor's active org.
  const pa=await withSession(SA,()=>listLinkableDriversCore());
  const pb=await withSession(SB,()=>listLinkableDriversCore());
  check("listLinkableDriversCore A contains only A driver",pa.ok&&pa.candidates.length===1&&pa.candidates[0].id===DA&&!pa.candidates.some(x=>x.id===DB),JSON.stringify(pa));
  check("listLinkableDriversCore B contains only B driver",pb.ok&&pb.candidates.length===1&&pb.candidates[0].id===DB&&!pb.candidates.some(x=>x.id===DA),JSON.stringify(pb));
  // (b) cross-org link is refused and does not mutate source.
  const badLink=await withSession(SA,()=>linkDriverAccountCore(DB));
  const afterBad=await q`SELECT linked_driver_user_id FROM users WHERE id=${OWNERA}`;
  check("linking foreign-org driver is refused",badLink.ok===false&&String(badLink.error).includes("isn't on this account")&&afterBad[0].linked_driver_user_id===null,JSON.stringify({badLink,afterBad}));
  const goodLink=await withSession(SA,()=>linkDriverAccountCore(DA));
  check("same-org link succeeds",goodLink.ok===true&&goodLink.linked.id===DA,JSON.stringify(goodLink));
  // (c) unlink is org-bound: tampering target to a foreign driver is refused and link remains.
  await q`UPDATE users SET linked_driver_user_id=${DB} WHERE id=${OWNERA}`;
  const badUnlink=await withSession(SA,()=>unlinkDriverAccountCore());
  const retained=await q`SELECT linked_driver_user_id FROM users WHERE id=${OWNERA}`;
  check("unlink refuses foreign-org linked target",badUnlink.ok===false&&String(badUnlink.error).includes("not in this account")&&retained[0].linked_driver_user_id===DB,JSON.stringify({badUnlink,retained}));
  await q`UPDATE users SET linked_driver_user_id=${DA} WHERE id=${OWNERA}`;
  const goodUnlink=await withSession(SA,()=>unlinkDriverAccountCore());
  check("same-org unlink succeeds",goodUnlink.ok===true&&(await q`SELECT linked_driver_user_id FROM users WHERE id=${OWNERA}`)[0].linked_driver_user_id===null,JSON.stringify(goodUnlink));
  // (d/e) real driver-auth session path: currentUser binds active org, then resolver joins identity in that org.
  await q`UPDATE users SET linked_driver_user_id=${DA} WHERE id=${OWNERA}`;
  const ua=await withSession(SA,()=>currentUser());
  const ub=await withSession(SB,()=>currentUser());
  check("driver-auth session status resolves org-A joined identity",ua?.orgId===OA&&ua?.driverIdentity?.userRowId===DA&&ua.driverIdentity.towbookDriverId===TBA,JSON.stringify(ua));
  check("driver-auth session status resolves org-B joined identity",ub?.orgId===OB&&ub.driverIdentity===null,JSON.stringify(ub));
  // Cross-org same Towbook id never permits an org-A session to read org-B row.
  const leak=await effectiveDriverIdentity({...ua,linkedDriverUserId:DB});
  check("cross-org same-driver-id isolation holds",leak===null,JSON.stringify(leak));
} catch (err) { console.error(err?.stack||err); }
finally {
  // Guard every destructive organization operation; all fixture ids are randomized QA ids.
  for (const org of await q`SELECT id,name FROM organizations WHERE id IN (${OA},${OB})`) { assertQaOrg(org.id,org.name); }
  await q`DELETE FROM sessions WHERE id IN (${SA},${SB}) OR user_id IN (${OWNERA},${OWNERB},${DA},${DB})`.catch(()=>{});
  await q`DELETE FROM organization_memberships WHERE org_id IN (${OA},${OB}) OR user_id IN (${OWNERA},${OWNERB},${DA},${DB})`.catch(()=>{});
  await q`DELETE FROM organizations WHERE id IN (${OA},${OB})`.catch(()=>{});
  await q`DELETE FROM users WHERE id IN (${OWNERA},${OWNERB},${DA},${DB})`.catch(()=>{});
}
const left=(await q`SELECT (SELECT COUNT(*)::int FROM organizations WHERE id IN (${OA},${OB})) orgs,(SELECT COUNT(*)::int FROM users WHERE id IN (${OWNERA},${OWNERB},${DA},${DB})) users,(SELECT COUNT(*)::int FROM organization_memberships WHERE org_id IN (${OA},${OB})) memberships,(SELECT COUNT(*)::int FROM sessions WHERE id IN (${SA},${SB})) sessions`)[0];
check("cleanup zero QA org/user/membership/session rows",Object.values(left).every(v=>Number(v)===0),JSON.stringify(left));
const failed=checks.filter(x=>!x[1]); console.log(`org-scoping.test.mjs: ${checks.length-failed.length}/${checks.length} passed`); if(failed.length){console.error(failed.map(x=>`  ${x[0]} ${x[2]}`).join("\n"));process.exit(1);} console.log("cleanup: zero QA rows + zero fixture sessions/memberships/users");
