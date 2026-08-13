// Job completion-time goals + live counter + metrics + academy (owner-directed
// 2026-08-13, completion-goals-spec.md). QA org pattern; sequential; cleanup
// verifies zero leftovers (assertQaOrg-guarded).
import { randomUUID } from "node:crypto";
const { sql } = await import("./src/db.ts");
const q = sql();
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const core = await import("./src/data/service-time-core.ts");
const {
  serviceTimeGoalsCore, updateServiceTimeGoalsHandler, getServiceTimeGoalsHandler,
  normalizeServiceType, goalSecondsFor, serviceDurationSeconds, formatGoalSeconds,
  attachServiceTimeData, ON_TIME_STANDARDS_LESSON_ID,
} = core;
const { getOrgMetricsHandler } = await import("./src/data/metrics-core.ts");
const { uploadJobPhotoCore, setVehicleMatchCore, completeJobCore } = await import("./src/data/driver-photos-core.ts");
const { captureCompletionCore } = await import("./src/data/completion-core.ts");
const checks = [];
const check = (name, cond, extra = "") => { checks.push([name, Boolean(cond), extra]); if (!cond) throw new Error(`FAIL: ${name} ${extra}`); };
const TAG = randomUUID().slice(0, 8);
const ORG = `qa-cg-${TAG}`;
const OWNER = `qa-cg-owner-${TAG}`;
const DRIVER = `qa-cg-driver-${TAG}`;
const OTHER = `qa-cg-other-${TAG}`;
const email = (u) => `${u}-${randomUUID()}@lightning.test`;
const TB_DRIVER = "55";
const JOB = "cg-job-1";
const NOW = Date.now();
const MIN = 60000;
const iso = (ms) => new Date(ms).toISOString();
await ensureSchema();
for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa-cg-%'`) { assertQaOrg(org.id, org.name); await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {}); }
await q`DELETE FROM users WHERE email LIKE 'qa-cg-%-@lightning.test'`.catch(() => {});
await q`INSERT INTO organizations(id, name) VALUES(${ORG}, ${ORG})`;
await q`INSERT INTO users(id, name, email, password_hash) VALUES(${OWNER}, 'CG Owner', ${email(OWNER)}, 'x'), (${DRIVER}, 'CG Driver', ${email(DRIVER)}, 'x'), (${OTHER}, 'CG Other', ${email(OTHER)}, 'x')`;
await q`UPDATE users SET towbook_driver_id=${TB_DRIVER} WHERE id=${DRIVER}`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${OWNER}, 'owner'), (${ORG}, ${DRIVER}, 'contractor'), (${ORG}, ${OTHER}, 'contractor')`;
const tok = (u) => `sess-${randomUUID()}`;
const S_OWNER = tok(OWNER), S_DRIVER = tok(DRIVER), S_OTHER = tok(OTHER);
for (const [t, u] of [[S_OWNER, OWNER], [S_DRIVER, DRIVER], [S_OTHER, OTHER]]) await q`INSERT INTO sessions(id, user_id, expires_at) VALUES(${t}, ${u}, NOW() + INTERVAL '1 day')`;
await q`INSERT INTO org_settings(org_id, photos_required) VALUES(${ORG}, FALSE) ON CONFLICT(org_id) DO NOTHING`;
// Platform-only arrived job (no Towbook id) assigned to DRIVER.
await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, assigned_driver_towbook_id, assigned_driver_name, arrived_at, assigned_at, pickup, raw_json)
  VALUES(${JOB}, ${ORG}, 'CG Customer', '', 0, 0, 'Bridgeport', 'jump_start', 'arrived', ${iso(NOW - 40 * MIN)}, '', ${TB_DRIVER}, 'CG Driver', ${iso(NOW - 5 * MIN)}, ${iso(NOW - 12 * MIN)}, '70 Pitt Street', ${JSON.stringify({ batterySaleId: null })}::jsonb)`;
const eventStorage = globalThis[Symbol.for("tanstack-start:event-storage")];
const startStorage = globalThis[Symbol.for("tanstack-start:start-storage-context")];
const withSession = (token, fn) => {
  const cookie = `ld_session_v2=${token}`;
  const { H3Event } = await import("h3");
  const h3Event = new H3Event(new Request("http://localhost/", { headers: { cookie } }));
  const req = new Request("http://localhost/", { headers: { cookie } });
  const store = new Map().set("h3Event", h3Event);
  const res = eventStorage.run(store, () => startStorage.run({ request: req }, fn));
  return res;
};
/* ============ 1) goal defaults + pure helpers ============ */
{
  const goals = await serviceTimeGoalsCore(ORG);
  const by = (t, v = "") => goals.find((g) => g.serviceType === t && g.variant === v)?.goalSeconds;
  check("defaults: jump_start 5 min", by("jump_start") === 300, JSON.stringify(goals));
  check("defaults: tire_change 15 min", by("tire_change") === 900);
  check("defaults: fuel_delivery 5 min", by("fuel_delivery") === 300);
  check("defaults: lockout 5 min", by("lockout") === 300);
  check("defaults: battery standard 1 hr", by("battery_install", "standard") === 3600);
  check("defaults: battery advanced 2 hr", by("battery_install", "advanced") === 7200);
  check("normalize: Jump Start → jump_start", normalizeServiceType("Jump Start") === "jump_start");
  check("normalize: Tire Change → tire_change", normalizeServiceType("Tire Change") === "tire_change");
  check("normalize: battery_install exact", normalizeServiceType("battery_install") === "battery_install");
  check("normalize: unknown → null", normalizeServiceType("Flatbed Tow") === null);
  const g = goalSecondsFor(goals, "jump_start", null);
  check("goalSecondsFor: jump_start → 300", g.goalSeconds === 300 && g.serviceKey === "jump_start");
  const bg = goalSecondsFor(goals, "battery_install", "advanced");
  check("goalSecondsFor: battery advanced → 7200", bg.goalSeconds === 7200);
  check("formatGoalSeconds: 300 → 5:00", formatGoalSeconds(300) === "5:00");
  check("formatGoalSeconds: 3600 → 60:00", formatGoalSeconds(3600) === "60:00");
}
/* ============ 2) duration computed at completion (stored once, fallbacks) ============ */
{
  check("serviceDurationSeconds: stored wins", serviceDurationSeconds({ durationSeconds: 240, completedAtMs: 100000, arrivedAtMs: 90000, assignedAtMs: 80000 }) === 240);
  check("serviceDurationSeconds: completed−arrived", serviceDurationSeconds({ durationSeconds: null, completedAtMs: 100000, arrivedAtMs: 90000, assignedAtMs: 80000 }) === 10);
  check("serviceDurationSeconds: fallback assigned", serviceDurationSeconds({ durationSeconds: null, completedAtMs: 100000, arrivedAtMs: null, assignedAtMs: 96000 }) === 4);
  check("serviceDurationSeconds: none → null", serviceDurationSeconds({ durationSeconds: null, completedAtMs: 100000, arrivedAtMs: null, assignedAtMs: null }) === null);
}
/* ============ 3) counter data source (attachServiceTimeData, pure) ============ */
{
  const goals = await serviceTimeGoalsCore(ORG);
  const arrivals = new Map([["tb-1", { arrivedAtIso: iso(NOW - 120000), serviceType: "jump_start" }]]);
  const variants = new Map([["cg-batt-1", "advanced"]]);
  const calls = [
    { id: "tb-1", statusId: 3, serviceName: "Jump Start" },
    { id: "cg-batt-1", statusId: 3, serviceName: "Battery installation" },
    { id: "tb-2", statusId: 2, serviceName: "Lockout" },
  ];
  const enr = attachServiceTimeData(calls, goals, variants, arrivals);
  check("counter: arrived call gets server arrival ts", enr.get("tb-1")?.arrivedAtIso === iso(NOW - 120000), JSON.stringify(enr.get("tb-1")));
  check("counter: jump_start goal 300", enr.get("tb-1")?.goalSeconds === 300);
  check("counter: battery advanced goal 7200", enr.get("cg-batt-1")?.goalSeconds === 7200);
  check("counter: en-route call stays null (waits for arrival)", enr.get("tb-2")?.arrivedAtIso === null && enr.get("tb-2")?.goalSeconds === null);
  check("counter: raw arrival fallback when LD missing", attachServiceTimeData([{ id: "x", statusId: 3, serviceName: "Lockout", rawArrivalAtIso: iso(NOW - 60000) }], goals, variants, new Map()).get("x")?.arrivedAtIso === iso(NOW - 60000));
}
/* ============ 4) completion writes duration_seconds (platform-only path) ============ */
const resp = (status, { json } = {}) => ({ status, ok: status >= 200 && status < 300, async text() { return json != null ? JSON.stringify(json) : ""; }, async json() { return json != null ? JSON.parse(JSON.stringify(json)) : {}; }, async arrayBuffer() { return new ArrayBuffer(0); } });
const photoDataUrl = (marker) => `data:image/jpeg;base64,${marker.repeat(1500)}`;
const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const sigDataUrl = (marker) => `data:image/png;base64,${Buffer.concat([PNG_1x1, Buffer.from(marker.repeat(100))]).toString("base64")}`;
const SIDES = ["front", "driver_side", "passenger_side", "rear"];
const PHASES = ["pre_arrival", "service", "final"];
const fetchImpl = async (url, init = {}) => {
  const u = String(url); const method = init.method || "GET";
  if (u.startsWith("https://api.backblazeb2.com/")) return resp(200, { json: { apiInfo: { s3ApiUrl: "https://s3.test.backblazeb2.com" }, allowed: { bucketName: "qa-bucket" } } });
  if (u.startsWith("https://s3.test.backblazeb2.com/")) return resp(200, { json: { ok: true } });
  throw new Error(`unexpected call: ${method} ${u}`);
};
process.env.B2_KEY_ID = "004testkeyid"; process.env.B2_APPLICATION_KEY = "testsecret"; process.env.B2_BUCKET_NAME = "qa-bucket";
const user = { orgId: ORG, id: DRIVER, role: "contractor", towbookDriverId: TB_DRIVER };
{
  for (const phase of PHASES) for (const side of SIDES) await uploadJobPhotoCore(user, { jobId: JOB, phase, side, dataUrl: photoDataUrl(phase) }, { fetchImpl, b2StableDir: `/tmp/b2-cg-${TAG}` });
  await setVehicleMatchCore(user, { jobId: JOB, confirmed: true }, { fetchImpl, b2StableDir: `/tmp/b2-cg-${TAG}` });
  await captureCompletionCore(user, { jobId: JOB, signatureDataUrl: sigDataUrl("S"), survey: { rating: 5, comment: "ok" } }, { fetchImpl, b2StableDir: `/tmp/b2-cg-${TAG}` });
  const before = await q`SELECT duration_seconds FROM dispatch_jobs WHERE id=${JOB}`;
  check("duration null before completion", before[0].duration_seconds == null);
  const r = await completeJobCore(user, { jobId: JOB }, { fetchImpl, b2StableDir: `/tmp/b2-cg-${TAG}` });
  check("completion ok (platform-only)", r.ok === true && r.changed === true, JSON.stringify(r));
  const after = await q`SELECT status, duration_seconds, completed_at, arrived_at FROM dispatch_jobs WHERE id=${JOB}`;
  const dur = Number(after[0].duration_seconds);
  const expected = Math.round((new Date(String(after[0].completed_at)).getTime() - new Date(String(after[0].arrived_at)).getTime()) / 1000);
  check("duration_seconds written at completion = completed−arrived", Math.abs(dur - expected) <= 1, `dur=${dur} expected=${expected}`);
  check("job completed", String(after[0].status) === "completed");
}
/* ============ 5) owner goal-edit path (role-gated) ============ */
{
  const upd = await withSession(S_OWNER, () => updateServiceTimeGoalsHandler({ goals: [{ serviceType: "jump_start", variant: "", goalSeconds: 420 }] }));
  check("owner edit ok", upd.ok === true && upd.goals.find((g) => g.serviceType === "jump_start")?.goalSeconds === 420, JSON.stringify(upd));
  const read = await withSession(S_DRIVER, () => getServiceTimeGoalsHandler());
  check("driver reads goals", read.ok === true && read.goals.find((g) => g.serviceType === "jump_start")?.goalSeconds === 420);
  const denied = await withSession(S_OTHER, () => updateServiceTimeGoalsHandler({ goals: [{ serviceType: "jump_start", variant: "", goalSeconds: 60 }] }));
  check("contractor edit refused", denied.ok === false && denied.code === "unauthorized");
  await serviceTimeGoalsCore(ORG); // reseed default for later assertions if needed
}
/* ============ 6) metrics: per-driver over/under + academy on-time auto-flag ============ */
{
  // DRIVER: completed jump_start (5:00 elapsed — arrived 5 min before completion
  // at NOW, so elapsed ≈ 5 min → right at goal → under). Add a second completed
  // jump_start with elapsed 8 min (> 5 min goal) → average over → coach flags.
  await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, assigned_driver_towbook_id, assigned_driver_name, arrived_at, assigned_at, completed_at, duration_seconds, towbook_job_id, raw_json)
    VALUES('cg-j2', ${ORG}, 'CG Two', '', 0, 0, 'Bridgeport', 'jump_start', 'completed', ${iso(NOW - 120 * MIN)}, '', ${TB_DRIVER}, 'CG Driver', ${iso(NOW - 20 * MIN)}, ${iso(NOW - 30 * MIN)}, ${iso(NOW - 12 * MIN)}, 480, 'tb-2', '{}'::jsonb)`;
  const m = await withSession(S_OWNER, () => getOrgMetricsHandler("all"));
  check("org metrics ok", m.ok === true, JSON.stringify(m).slice(0, 200));
  if (m.ok) {
    const row = m.fleet.find((r) => r.userId === DRIVER);
    check("fleet row present", row != null);
    if (row) {
      check("fleet: over-goal services flagged", Array.isArray(row.serviceTime.overGoalServices) && row.serviceTime.overGoalServices.length === 1 && row.serviceTime.overGoalServices[0] === "jump_start", JSON.stringify(row.serviceTime));
      check("fleet: over/under counts", row.serviceTime.overGoal === 1 && row.serviceTime.underGoal >= 1, JSON.stringify(row.serviceTime));
      const rec = row.academy.find((r2) => r2.metricKey === "service_time");
      check("academy: On-Time Service Standards auto-flagged", rec != null && rec.lessonId === ON_TIME_STANDARDS_LESSON_ID && rec.why.includes("jump start"), JSON.stringify(rec));
    }
  }
}
/* ------------------------------- summary + cleanup ------------------------------- */
const failed = checks.filter(([, ok]) => !ok);
console.log(`completion-goals.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }
const memberIds = await q`SELECT DISTINCT m.user_id FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa-cg-%'`;
for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa-cg-%'`) { assertQaOrg(org.id, org.name); await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {}); }
for (const m of memberIds) await q`DELETE FROM users WHERE id=${m.user_id}`.catch(() => {});
await q`DELETE FROM users WHERE email LIKE 'qa-cg-%-@lightning.test'`.catch(() => {});
const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa-cg-%') AS orgs,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE 'qa-cg-%-@lightning.test') AS users,
  (SELECT COUNT(*)::int FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.email LIKE 'qa-cg-%-@lightning.test') AS sessions,
  (SELECT COUNT(*)::int FROM dispatch_jobs j JOIN organizations o ON o.id=j.org_id WHERE o.name LIKE 'qa-cg-%') AS jobs,
  (SELECT COUNT(*)::int FROM status_events e JOIN organizations o ON o.id=e.org_id WHERE o.name LIKE 'qa-cg-%') AS events,
  (SELECT COUNT(*)::int FROM job_photos p JOIN organizations o ON o.id=p.org_id WHERE o.name LIKE 'qa-cg-%') AS photos,
  (SELECT COUNT(*)::int FROM job_completions c JOIN organizations o ON o.id=c.org_id WHERE o.name LIKE 'qa-cg-%') AS completions,
  (SELECT COUNT(*)::int FROM service_time_goals g JOIN organizations o ON o.id=g.org_id WHERE o.name LIKE 'qa-cg-%') AS goals,
  (SELECT COUNT(*)::int FROM org_settings s JOIN organizations o ON o.id=s.org_id WHERE o.name LIKE 'qa-cg-%') AS settings,
  (SELECT COUNT(*)::int FROM audit_log a JOIN organizations o ON o.id=a.org_id WHERE o.name LIKE 'qa-cg-%') AS audit`;
const z = Object.values(leftover[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) { console.error("FAIL: QA cleanup left rows behind"); process.exit(1); }
console.log("completion-goals.test.mjs: cleanup verified — zero QA rows left");
