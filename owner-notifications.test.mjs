// Hermetic DB coverage for the durable owner notification archive. QA fixtures only.
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
if (!process.env.DATABASE_URL) { try { const p=execSync("pgrep -f 'bun run serve.ts'|head -1").toString().trim(); if(p){const e=await readFile(`/proc/${p}/environ`,"utf8"); const x=e.split("\0").find(v=>v.startsWith("DATABASE_URL=")); if(x)process.env.DATABASE_URL=x.slice(15);}} catch{} }
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const { recordOwnerNotification, listOwnerNotifications, markOwnerNotificationRead, markAllOwnerNotificationsRead, countUnreadOwnerNotifications } = await import("./src/data/owner-notifications-core.ts");
const checks=[]; const check=(name, condition, detail="")=>checks.push([name,Boolean(condition),detail]);
const suffix=`${Date.now()}-${randomUUID()}`;
const OA=`qa-owner-notifications-a-${suffix}`, OB=`qa-owner-notifications-b-${suffix}`;
const call=(tag)=>`qa-on-call-${tag}-${suffix}`;
await ensureSchema();
// Some QA databases have migration 70 recorded from an earlier branch before its
// DDL landed; reproduce the migration's idempotent DDL so this suite remains
// hermetic without mutating application data.
await q`CREATE TABLE IF NOT EXISTS owner_notifications (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT, route TEXT, payload JSONB, call_request_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), read_at TIMESTAMPTZ)`;
await q`CREATE INDEX IF NOT EXISTS owner_notifications_org_created_idx ON owner_notifications(org_id, created_at DESC)`;
await q`CREATE UNIQUE INDEX IF NOT EXISTS owner_notifications_org_call_escalation_uidx ON owner_notifications(org_id, call_request_id) WHERE call_request_id IS NOT NULL AND kind='escalation'`;
try {
  await q`INSERT INTO organizations(id,name) VALUES(${OA},'QA owner notifications A'),(${OB},'QA owner notifications B')`;
  const a1=await recordOwnerNotification(OA,{kind:"job",title:"Older",body:"one",callRequestId:call("one")});
  await new Promise(r=>setTimeout(r,5));
  const a2=await recordOwnerNotification(OA,{kind:"job",title:"Newest",body:"two",callRequestId:call("two")});
  const listed=await listOwnerNotifications(OA);
  check("record then list returns newest-first",listed.length===2&&listed[0].id===a2.id&&listed[1].id===a1.id,JSON.stringify(listed));

  const escCall=call("escalation");
  const esc1=await recordOwnerNotification(OA,{kind:"escalation",title:"Escalated",body:"first",callRequestId:escCall});
  check("different call request IDs create separate rows",(await recordOwnerNotification(OA,{kind:"escalation",title:"Other",callRequestId:call("other")})).id!==esc1.id);
  await markOwnerNotificationRead(OA,esc1.id);
  const beforeRefresh=(await listOwnerNotifications(OA)).find(n=>n.id===esc1.id);
  await new Promise(r=>setTimeout(r,5));
  const esc2=await recordOwnerNotification(OA,{kind:"escalation",title:"Escalated refreshed",body:"second",callRequestId:escCall});
  const afterRefresh=(await listOwnerNotifications(OA)).filter(n=>n.id===esc1.id);
  check("same escalation call ID dedupes to exactly one row",afterRefresh.length===1&&esc2.id===esc1.id,JSON.stringify(afterRefresh));
  check("escalation conflict refreshes created_at and clears read_at",afterRefresh[0]?.createdAt>=beforeRefresh?.createdAt&&afterRefresh[0]?.readAt===null&&afterRefresh[0]?.title==="Escalated refreshed",JSON.stringify({beforeRefresh,afterRefresh}));

  const unreadBefore=await countUnreadOwnerNotifications(OA);
  check("unread count includes only unread",unreadBefore===4,String(unreadBefore));
  check("mark-read sets read_at",await markOwnerNotificationRead(OA,a1.id)&&((await listOwnerNotifications(OA)).find(n=>n.id===a1.id)?.readAt!==null));
  const marked=await markAllOwnerNotificationsRead(OA);
  check("mark-all-read clears all unread",marked===3&&await countUnreadOwnerNotifications(OA)===0,String(marked));

  await recordOwnerNotification(OA,{kind:"page",title:"Page one",callRequestId:call("page-1")});
  await new Promise(r=>setTimeout(r,5));
  await recordOwnerNotification(OA,{kind:"page",title:"Page two",callRequestId:call("page-2")});
  const page1=await listOwnerNotifications(OA,{limit:1});
  const page2=await listOwnerNotifications(OA,{limit:1,beforeId:page1[0].id});
  check("list limit and beforeId pagination work",page1.length===1&&page2.length===1&&page2[0].id!==page1[0].id,JSON.stringify({page1,page2}));
  check("organization isolation hides A notifications from B",(await listOwnerNotifications(OB)).length===0&&await countUnreadOwnerNotifications(OB)===0);
} catch (err) { console.error(err?.stack||err); process.exitCode=1; }
finally {
  for (const org of await q`SELECT id,name FROM organizations WHERE id IN (${OA},${OB})`) { assertQaOrg(org.id,org.name); }
  await q`DELETE FROM organizations WHERE id IN (${OA},${OB})`.catch(()=>{});
}
const left=(await q`SELECT COUNT(*)::int AS n FROM organizations WHERE id IN (${OA},${OB})`)[0];
check("cleanup leaves zero QA organizations",Number(left.n)===0,JSON.stringify(left));
const failed=checks.filter(x=>!x[1]);
console.log(`owner-notifications.test.mjs: ${checks.length-failed.length}/${checks.length} passed`);
if(failed.length){console.error(failed.map(x=>`  FAIL ${x[0]} ${x[2]}`).join("\n"));process.exit(1);}
console.log("cleanup: zero QA organizations (notifications cascade-deleted)");
