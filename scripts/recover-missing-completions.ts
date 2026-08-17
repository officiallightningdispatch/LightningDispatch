/** Read-only by default recovery for completed jobs missing authoritative timestamps.
 * Usage: bun scripts/recover-missing-completions.ts --org=FULL_32_CHAR_ID [--fetch] [--apply]
 * --apply is intentionally explicit and only updates timestamps returned by Towbook.
 */
import { sql } from '../src/db';
import { decryptSession } from '../src/data/towbook-key';
import { normalizeTowbookCompletionTime } from '../src/data/server';
const ORG = '89e15ce587651cc47c3bc45b1c612a220955';
const args = new Set(process.argv.slice(2));
const orgArg = process.argv.find(a => a.startsWith('--org='))?.slice(6) ?? '';
if (orgArg !== ORG || orgArg.length !== ORG.length) throw new Error('Require --org=89e15ce587651cc47c3bc45b1c612a220955 (full org id; prefixes are rejected)');
const doFetch = args.has('--fetch'), doApply = args.has('--apply');
const q = sql();
const rows = await q`SELECT id, towbook_job_id, assigned_driver_towbook_id, raw_json FROM dispatch_jobs WHERE org_id=${ORG} AND status='completed' AND completed_at IS NULL ORDER BY id`;
const recovered: { id:string; timestamp:string }[] = [], unrecoverable: string[] = [];
let session: { cookies:string; baseUrl:string } | null = null;
if (doFetch) {
  const s = await q`SELECT encrypted_session,status FROM towbook_sessions WHERE org_id=${ORG} AND session_kind='owner' LIMIT 1`;
  if (!s.length || String(s[0].status) !== 'connected') throw new Error('No connected owner Towbook session');
  const plain = JSON.parse(await decryptSession(String(s[0].encrypted_session))) as { cookies?:string; baseUrl?:string };
  session = { cookies: plain.cookies ?? '', baseUrl: plain.baseUrl ?? 'https://app.towbook.com' };
}
for (const row of rows) {
  const raw = row.raw_json && typeof row.raw_json === 'object' ? row.raw_json as Record<string,unknown> : {};
  let timestamp = normalizeTowbookCompletionTime(raw);
  if (!timestamp && doFetch && session && row.towbook_job_id) {
    const r = await fetch(`${session.baseUrl}/api/calls/${encodeURIComponent(String(row.towbook_job_id))}`, { headers: { cookie: session.cookies, accept: 'application/json' } });
    const body = await r.json().catch(() => null) as Record<string,unknown> | null;
    timestamp = normalizeTowbookCompletionTime(body);
  }
  if (timestamp) { recovered.push({ id: String(row.id), timestamp }); if (doApply) await q`UPDATE dispatch_jobs SET completed_at=${timestamp} WHERE id=${row.id} AND org_id=${ORG} AND status='completed' AND completed_at IS NULL`; }
  else unrecoverable.push(String(row.id));
  console.log(JSON.stringify({ id: row.id, towbook_job_id: row.towbook_job_id, driver: row.assigned_driver_towbook_id, timestamp: timestamp ?? null }));
}
console.log(JSON.stringify({ mode: doApply ? 'apply' : doFetch ? 'fetch' : 'dry-run', scanned: rows.length, recovered: recovered.length, unrecoverable }, null, 2));
