// Hermetic Towbook report client/reconciliation tests. No network; DB checks run when DATABASE_URL is available.
import { strict as assert } from "node:assert";
const core = await import("./src/data/towbook-reports-core.ts");
const { fetchCallWorkflow, reconcileCallWorkflow, reconcileDriverActivityCore, TowbookReportError, resetTowbookReportTokenCacheForTests, saveTowbookSnapshot } = core;
const checks = [];
const check = (name, fn) => { try { fn(); checks.push([name, true]); } catch (e) { checks.push([name, false]); throw e; } };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const oldFetch = globalThis.fetch;
const calls = [];
process.env.TOWBOOK_USERNAME = "qa-user"; process.env.TOWBOOK_PASSWORD = "qa-password";
try {
  resetTowbookReportTokenCacheForTests();
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return url.endsWith("authentication") ? json({ token: "A".repeat(64), expiresAt: new Date(Date.now() + 300000).toISOString() }) : json({ reportData: [{ id: 1, driver: "Test", completed: "2026-08-10T10:00:00" }] }); };
  const first = await fetchCallWorkflow({ start: "2026-08-10T00:00:00", end: "2026-08-16T23:59:59" });
  await fetchCallWorkflow({ start: "2026-08-10T00:00:00", end: "2026-08-16T23:59:59" });
  check("client token cached", () => assert.equal(calls.filter(x => x.url.endsWith("authentication")).length, 1));
  check("client request shape", () => { const req = calls.find(x => x.url.endsWith("/reports")); assert.equal(req.init.method, "POST"); assert.equal(req.init.headers.authorization, `Bearer ${"A".repeat(64)}`); assert.equal(req.init.headers["X-API-Use-UTC"], "1"); assert.equal(req.init.headers["X-Company"], "all"); assert.deepEqual(JSON.parse(req.init.body), { dateStart:"2026-08-10T00:00:00", dateEnd:"2026-08-16T23:59:59", companyId:[23257], impounds:"0", reportType:"CallWorkflow", version:"2.0" }); });
  check("client rows", () => assert.equal(first.rows.length, 1));
  const fail = async (env, response, code) => { resetTowbookReportTokenCacheForTests(); process.env.TOWBOOK_USERNAME = env[0]; process.env.TOWBOOK_PASSWORD = env[1]; globalThis.fetch = async () => response instanceof Error ? Promise.reject(response) : response; await assert.rejects(() => fetchCallWorkflow({start:"x",end:"y"}), e => e instanceof TowbookReportError && e.code === code); };
  await fail(["", ""], json({}), "credentials_unavailable");
  await fail(["u", "p"], json({}, 401), "authentication_failed");
  globalThis.fetch = async (url) => url.endsWith("authentication") ? json({token:"B".repeat(64)}) : json({}, 500); await assert.rejects(() => fetchCallWorkflow({start:"x",end:"y"}), e => e.code === "report_failed");
  globalThis.fetch = async (url) => url.endsWith("authentication") ? json({token:"C".repeat(64)}) : json(null); await assert.rejects(() => fetchCallWorkflow({start:"x",end:"y"}), e => e.code === "invalid_response");
  // 217 authoritative report rows: 187 matched DB jobs + a mixed 30-row delta.
  const names = [["Antone jerret",67],["Ai Dispatch GB",52],["Jayden Fountain",47],["Levi C Martin",40],["Brittani Simms",4],["24hourbattery",4],["George Boyd",3]];
  const rows = []; for (const [name, count] of names) for (let i=0;i<count;i++) rows.push({ id: rows.length+1, driverName:name, completed:"2026-08-12T12:00:00" });
  const jobs = rows.slice(0,187).map((r,i) => ({ towbook_job_id:r.id, raw_json: i < 4 ? { invoiceItems:[{ name:"GOA" }] } : {}, reassigned:false }));
  for (let i=187;i<217;i++) { rows[i].completed = null; rows[i].completionTime = null; if (i === 187) rows[i].status = "cancelled"; else if (i === 188 || i === 189) rows[i].status = "reassigned"; }
  const result = reconcileCallWorkflow(rows, jobs);
  check("fixture report total", () => assert.equal(result.reportCount, 217));
  check("fixture mixed delta", () => { assert.equal(result.payableCount, 187); assert.equal(result.excludedCount, 3); assert.equal(result.unclassifiableCount, 27); assert.equal(result.payableCount + result.excludedCount + result.unclassifiableCount, 217); assert.equal(result.rows.filter(x=>x.classification === "goa").length, 4); });
  check("fixture per-driver report counts", () => assert.deepEqual(result.byDriver.map(x=>x.reportCount), [67,52,47,40,4,4,3]));
  const manual = reconcileDriverActivityCore(names.map(([name,callCount]) => ({name,callCount})));
  check("manual paste explicit delta", () => { assert.equal(manual.reportCount,217); assert.equal(manual.unclassifiableCount,217); assert.equal(manual.byDriver[0].unclassifiableCount,67); });
  if (process.env.RUN_TOWBOOK_DB_TESTS === "1") {
    const { ensureSchema } = await import("./src/data/migrations.ts"); const { sql } = await import("./src/db.ts"); await ensureSchema(); const q=sql(); const org=`qa-towbook-${Date.now()}`; await q`INSERT INTO organizations(id,name) VALUES(${org},'qa towbook')`;
    const a=await saveTowbookSnapshot(org,{start:"2026-08-10T00:00:00",end:"2026-08-16T23:59:59"},{rows:[1]},"server"); const b=await saveTowbookSnapshot(org,{start:"2026-08-10T00:00:00",end:"2026-08-16T23:59:59"},{rows:[2]},"manual-paste"); const ss=await q`SELECT source,data FROM towbook_report_snapshots WHERE org_id=${org} ORDER BY created_at ASC`; check("snapshot append-only/indexed",()=>{assert.equal(ss.length,2);assert.equal(ss[0].source,"server");assert.equal(ss[1].source,"manual-paste");assert.notEqual(a,b)}); await q`DELETE FROM towbook_report_snapshots WHERE org_id=${org}`; await q`DELETE FROM organizations WHERE id=${org}`;
  }
} finally { globalThis.fetch = oldFetch; process.env.TOWBOOK_USERNAME=""; process.env.TOWBOOK_PASSWORD=""; }
console.log(`Towbook reports: ${checks.filter(x=>x[1]).length} PASS`);
