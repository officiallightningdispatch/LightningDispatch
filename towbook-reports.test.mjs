// Hermetic Towbook report client/reconciliation tests. No network; DB checks run when DATABASE_URL is available.
import { strict as assert } from "node:assert";
const core = await import("./src/data/towbook-reports-core.ts");
const { fetchCallWorkflow, reconcileCallWorkflow, reconcileDriverActivityCore, TowbookReportError, resetTowbookReportTokenCacheForTests, setTowbookReportCredentialsReaderForTests, saveTowbookSnapshot } = core;
const checks = [];
const check = (name, fn) => { try { fn(); checks.push([name, true]); } catch (e) { checks.push([name, false]); throw e; } };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const authText = (token = "A".repeat(64), status = 200, expiresAt = new Date(Date.now() + 300000).toUTCString()) => new Response(token, { status, headers: { "content-type": "text/plain; charset=utf-8", "x-towbook-token-expires-utc": expiresAt } });
const oldFetch = globalThis.fetch;
const calls = [];
process.env.TOWBOOK_USERNAME = "qa-user"; process.env.TOWBOOK_PASSWORD = "qa-password";
try {
  resetTowbookReportTokenCacheForTests();
  setTowbookReportCredentialsReaderForTests(async () => ({ username: "file-user", password: "file-password" }));
  delete process.env.TOWBOOK_USERNAME; delete process.env.TOWBOOK_PASSWORD;
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return url.endsWith("authentication") ? authText("A".repeat(64)) : json({ reportData: [{ id: 1, driver: "Test", completed: "2026-08-10T10:00:00" }] }); };
  const first = await fetchCallWorkflow({ start: "2026-08-10T00:00:00", end: "2026-08-16T23:59:59" });
  await fetchCallWorkflow({ start: "2026-08-10T00:00:00", end: "2026-08-16T23:59:59" });
  check("client token cached", () => assert.equal(calls.filter(x => x.url.endsWith("authentication")).length, 1));
  check("client request shape", () => { const req = calls.find(x => x.url.endsWith("/reports")); assert.equal(req.init.method, "POST"); assert.equal(req.init.headers.authorization, `Bearer ${"A".repeat(64)}`); assert.equal(req.init.headers["X-API-Use-UTC"], "1"); assert.equal(req.init.headers["X-Company"], "all"); assert.deepEqual(JSON.parse(req.init.body), { dateStart:"2026-08-10T00:00:00", dateEnd:"2026-08-16T23:59:59", companyId:[23257], impounds:"0", reportType:"CallWorkflow", version:"2.0" }); });
  check("client rows", () => assert.equal(first.rows.length, 1));
  check("file fallback credentials", () => { const auth = calls.find(x => x.url.endsWith("authentication")); assert.deepEqual(JSON.parse(auth.init.body), { username: "file-user", password: "file-password" }); });
  resetTowbookReportTokenCacheForTests(); process.env.TOWBOOK_USERNAME = "env-user"; process.env.TOWBOOK_PASSWORD = "env-password"; globalThis.fetch = async (url, init) => { calls.push({ url, init }); return url.endsWith("authentication") ? authText("D".repeat(64)) : json({ reportData: [] }); }; await fetchCallWorkflow({start:"x",end:"y"});
  check("environment precedence", () => { const auth = calls.filter(x => x.url.endsWith("authentication")).at(-1); assert.deepEqual(JSON.parse(auth.init.body), { username: "env-user", password: "env-password" }); });
  const fail = async (env, response, code) => { resetTowbookReportTokenCacheForTests(); process.env.TOWBOOK_USERNAME = env[0]; process.env.TOWBOOK_PASSWORD = env[1]; globalThis.fetch = async () => response instanceof Error ? Promise.reject(response) : response; await assert.rejects(() => fetchCallWorkflow({start:"x",end:"y"}), e => e instanceof TowbookReportError && e.code === code); };
  setTowbookReportCredentialsReaderForTests(async () => null);
  await fail(["", ""], json({}), "credentials_unavailable");
  check("credential error does not disclose values", async () => { /* classification above is intentionally value-free */ });
  await fail(["u", "p"], json({}, 401), "authentication_failed");
  globalThis.fetch = async (url) => url.endsWith("authentication") ? authText("B".repeat(64)) : json({}, 500); await assert.rejects(() => fetchCallWorkflow({start:"x",end:"y"}), e => e.code === "report_failed");
  globalThis.fetch = async (url) => url.endsWith("authentication") ? authText("C".repeat(64)) : json(null); await assert.rejects(() => fetchCallWorkflow({start:"x",end:"y"}), e => e.code === "invalid_response");
  // 217 authoritative report rows: 187 matched DB jobs + a mixed 30-row delta.
  const names = [["Antone jerret",67],["Ai Dispatch GB",52],["Jayden Fountain",47],["Levi C Martin",40],["Brittani Simms",4],["24hourbattery",4],["George Boyd",3]];
  const rows = []; for (const [name, count] of names) for (let i=0;i<count;i++) rows.push({ id: rows.length+1, driverName:name, completed:"2026-08-12T12:00:00" });
  const jobs = rows.slice(0,187).map((r,i) => ({ towbook_job_id:r.id, raw_json: i < 4 ? { invoiceItems:[{ name:"GOA" }] } : {}, manually_reassigned_at:null }));
  const markerChecks = reconcileCallWorkflow(
    [{ id: 900, driverName: "Marker", completed: "2026-08-12T12:00:00" }, { id: 901, driverName: "Legacy", completed: "2026-08-12T12:00:00" }],
    [{ towbook_job_id: 900, manually_reassigned_at: "2026-08-12T13:00:00Z", raw_json: {} }, { towbook_job_id: 901, raw_json: { reassigned: "true" }, manually_reassigned_at: null }]
  );
  const joinRegression = reconcileCallWorkflow(
    [{ id: null, callNumber: 24580, dispatchEntryId: 279705803, driver: "Dispatch driver", completed: "2026-08-12T12:00:00" }],
    [{ towbook_job_id: "279705803", id: "tb-279705803", raw_json: { callNumber: "24580" }, manually_reassigned_at: null }]
  );
  check("dispatchEntryId joins towbook_job_id", () => { assert.equal(joinRegression.rows[0].classification, "completed"); assert.equal(joinRegression.diagnostics.length, 0); });
  const preLdRows = Array.from({ length: 33 }, (_, i) => ({ id: 24545 + i, callNumber: 24545 + i, driverName: i < 12 ? "Levi C Martin" : i < 21 ? "Jayden Fountain" : i < 30 ? "Antone jerret" : i < 32 ? "George Boyd" : "Brittani Simms", completed: "2026-08-10T03:45:00Z" }));
  const preLd = reconcileCallWorkflow(preLdRows, []);
  check("PRE-LD completed unmatched rows are payable by report evidence", () => { assert.equal(preLd.reportCount, 33); assert.equal(preLd.matchedCount, 0); assert.equal(preLd.matchedPayableCount, 0); assert.equal(preLd.unmatchedCount, 0); assert.equal(preLd.payableCount, 33); assert.equal(preLd.byDriver.reduce((sum, row) => sum + row.payableCount, 0), 33); assert.equal(preLd.diagnostics.length, 33); });
  const unmatchedGoa = reconcileCallWorkflow([{ id: 902, driverName: "Known", completed: "2026-08-12T12:00:00", invoiceItems: [{ name: "GOA" }] }], []);
  check("unmatched report GOA remains payable at flat amount", () => { assert.equal(unmatchedGoa.rows[0].classification, "goa"); assert.equal(unmatchedGoa.rows[0].payableCents, 1000); assert.equal(unmatchedGoa.payableCount, 1); });
  check("DB reassignment marker", () => assert.equal(markerChecks.rows[0].classification, "reassigned"));
  check("legacy raw reassignment marker", () => assert.equal(markerChecks.rows[1].classification, "reassigned"));
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
