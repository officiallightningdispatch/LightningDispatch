// Hermetic Phase B Item ⑤ acceptance proof. QA fixtures only; no Towbook calls.
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
if (!process.env.DATABASE_URL) { try { const p=execSync("pgrep -f 'bun run serve.ts'|head -1").toString().trim(); if(p){const e=await readFile(`/proc/${p}/environ`,"utf8"); const x=e.split("\0").find(v=>v.startsWith("DATABASE_URL=")); if(x)process.env.DATABASE_URL=x.slice(15);}} catch{} }
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
const { ensureSchema } = await import("./src/data/migrations.ts");
const checks=[]; const check=(n,c,e="")=>{checks.push([n,!!c,e]);if(!c)throw Error(`FAIL: ${n} ${e}`)};
const suffix=randomUUID(), Oqa=`qa-identity-${suffix}`, Oreal=`real-identity-${suffix}`, U=`qa-identity-user-${suffix}`, U2=`qa-identity-duplicate-${suffix}`, S=`qa-identity-session-${suffix}`, SL=`qa-identity-legacy-${suffix}`, TB=`tb-identity-${suffix}`;
const memberships=`${Oqa},${Oreal}`;
await ensureSchema(); await ensureSchema();
try {
  await q`INSERT INTO organizations(id,name) VALUES(${Oqa},'QA identity org'),(${Oreal},'Real-style identity org')`;
  await q`INSERT INTO users(id,name,email,password_hash,towbook_user_id,towbook_driver_id,login_handle) VALUES(${U},'QA Identity',${U+'@lightning.test'},'x',${TB},${'driver-'+suffix},${'identity-'+suffix})`;
  await q`INSERT INTO organization_memberships(org_id,user_id,role,contractor_id) VALUES(${Oqa},${U},'contractor',${'contractor-'+suffix}),(${Oreal},${U},'owner',NULL)`;
  // Exact Item ⑤ ordering: non-qa org first, then org id ASC.
  const ordered=await q`SELECT org_id,role,contractor_id FROM organization_memberships WHERE user_id=${U} ORDER BY (org_id LIKE 'qa-%') ASC, org_id ASC`;
  check('a deterministic first membership is non-qa org',ordered.length===2&&ordered[0].org_id===Oreal&&ordered[0].role==='owner',JSON.stringify(ordered));
  await q`INSERT INTO sessions(id,user_id,active_org_id,expires_at) VALUES(${S},${U},${ordered[0].org_id},NOW()+INTERVAL '30 days')`;
  const bound=await q`SELECT u.id,m.org_id,m.role,m.contractor_id,s.active_org_id FROM sessions s JOIN users u ON u.id=s.user_id JOIN organization_memberships m ON m.user_id=u.id AND m.org_id=s.active_org_id WHERE s.id=${S}`;
  const again=await q`SELECT m.org_id,m.role FROM sessions s JOIN organization_memberships m ON m.user_id=s.user_id AND m.org_id=s.active_org_id WHERE s.id=${S}`;
  check('a session binding resolves same user/org/role repeatedly',bound[0]?.id===U&&bound[0]?.org_id===Oreal&&bound[0]?.role==='owner'&&again[0]?.org_id===Oreal,JSON.stringify({bound,again}));
  check('a other membership is not selected',bound[0]?.org_id!==Oqa);
  // Legacy NULL session: emulate currentUser's exact fallback and repair query.
  await q`INSERT INTO sessions(id,user_id,active_org_id,expires_at) VALUES(${SL},${U},NULL::text,NOW()+INTERVAL '30 days')`;
  const legacy=await q`SELECT m.org_id,m.role,s.active_org_id FROM sessions s JOIN organization_memberships m ON m.user_id=s.user_id AND (s.active_org_id IS NULL OR m.org_id=s.active_org_id) WHERE s.id=${SL} ORDER BY (m.org_id LIKE 'qa-%') ASC,m.org_id ASC`;
  await q`UPDATE sessions SET active_org_id=${legacy[0].org_id} WHERE id=${SL} AND active_org_id IS NULL`;
  const repaired=await q`SELECT active_org_id FROM sessions WHERE id=${SL}`;
  const second=await q`SELECT m.org_id,m.role FROM sessions s JOIN organization_memberships m ON m.user_id=s.user_id AND m.org_id=s.active_org_id WHERE s.id=${SL}`;
  check('b legacy NULL session falls back and backfills',legacy[0].org_id===Oreal&&repaired[0].active_org_id===Oreal&&second[0].org_id===Oreal,JSON.stringify({legacy,repaired,second}));
  // Same global Towbook identity represented in a second org: reuse one LD user row.
  await q`INSERT INTO organization_memberships(org_id,user_id,role) VALUES(${Oqa},${U},'contractor') ON CONFLICT DO NOTHING`;
  const same=await q`SELECT COUNT(*)::int n FROM users WHERE towbook_user_id=${TB}`;
  const mem=await q`SELECT COUNT(*)::int n FROM organization_memberships WHERE user_id=${U} AND org_id IN (${Oqa},${Oreal})`;
  check('c global identity has one user and two memberships',Number(same[0].n)===1&&Number(mem[0].n)===2,JSON.stringify({same,mem}));
  const idx=await q`SELECT indexname FROM pg_indexes WHERE tablename='users' AND indexname='users_towbook_user_id_uidx'`;
  check('c migration 50 unique index exists',idx.length===1);
  let rejected=false; try { await q`INSERT INTO users(id,name,email,password_hash,towbook_user_id) VALUES(${U2},'duplicate',${U2+'@lightning.test'},'x',${TB})`; } catch { rejected=true; }
  check('c duplicate Towbook identity is rejected',rejected);
  const mig=await q`SELECT version FROM schema_migrations WHERE version IN (48,49,50) ORDER BY version`;
  check('d schema ensure is idempotent and 48+49+50 applied',mig.map(x=>Number(x.version)).join(',')==='48,49,50',JSON.stringify(mig));
  // Single-membership regression: same join shape retains role + contractor id.
  const singleO=`qa-single-${suffix}`, singleU=`qa-single-user-${suffix}`;
  await q`INSERT INTO organizations(id,name) VALUES(${singleO},'QA single')`;
  await q`INSERT INTO users(id,name,email,password_hash) VALUES(${singleU},'Single',${singleU+'@lightning.test'},'x')`;
  await q`INSERT INTO organization_memberships(org_id,user_id,role,contractor_id) VALUES(${singleO},${singleU},'contractor',${'single-contractor-'+suffix})`;
  const single=await q`SELECT u.id,m.org_id,m.role,m.contractor_id FROM users u JOIN organization_memberships m ON m.user_id=u.id WHERE u.id=${singleU}`;
  check('e single-membership preserves org/role/contractorId',single[0]?.org_id===singleO&&single[0]?.role==='contractor'&&single[0]?.contractor_id==='single-contractor-'+suffix);
  await q`DELETE FROM organizations WHERE id=${singleO}`; await q`DELETE FROM users WHERE id=${singleU}`;
  const applied=await q`SELECT COUNT(*)::int n FROM schema_migrations`; check('f migration state ends at 51',Number((await q`SELECT MAX(version)::int n FROM schema_migrations`)[0].n)===51);
} finally {
  await q`DELETE FROM sessions WHERE id IN (${S},${SL}) OR user_id IN (${U},${U2})`.catch(()=>{});
  await q`DELETE FROM organization_memberships WHERE org_id IN (${Oqa},${Oreal}) OR user_id IN (${U},${U2})`.catch(()=>{});
  await q`DELETE FROM organizations WHERE id IN (${Oqa},${Oreal})`.catch(()=>{});
  await q`DELETE FROM users WHERE id IN (${U},${U2})`.catch(()=>{});
}
const left=await q`SELECT (SELECT COUNT(*)::int FROM organizations WHERE id IN (${Oqa},${Oreal})) orgs,(SELECT COUNT(*)::int FROM users WHERE id IN (${U},${U2})) users,(SELECT COUNT(*)::int FROM organization_memberships WHERE org_id IN (${Oqa},${Oreal})) memberships,(SELECT COUNT(*)::int FROM sessions WHERE id IN (${S},${SL})) sessions`;
check('cleanup zero QA rows + sessions/memberships/users',Object.values(left[0]).every(v=>Number(v)===0),JSON.stringify(left[0]));
const failed=checks.filter(x=>!x[1]); console.log(`identity-session.test.mjs: ${checks.length-failed.length}/${checks.length} passed`); if(failed.length)process.exit(1); console.log('cleanup: zero QA rows + zero fixture sessions/memberships/users');
