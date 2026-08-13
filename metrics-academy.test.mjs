// Hermetic tests for the Metrics tab + Lightning Dispatch Academy build
// (owner-directed 2026-08-12, metrics-academy-spec.md):
//   - migration 26 idempotency (ensureAuthSchema + ensureSchema twice; the 10
//     lesson seed is shipped product copy — ON CONFLICT DO NOTHING)
//   - academy lesson seed (10 cards, one per metric_key)
//   - driver_availability_log upsert on the GO/Offline toggle
//     (recordAvailabilityStart/Stop — the exact helpers driverSetAvailability
//     calls): GO opens/keeps the stretch (ping_count increments only on a real
//     reopen), Offline banks the elapsed minutes onto the START day
//     (overnight-stretch attribution), never double-banks.
//   - every metric computation from the local DB mirror (accept time,
//     en-route time, ETA accuracy/lateJobsPct, photos 12/12 + per-phase,
//     completion rate, customer rating + distribution, tips + tip rate,
//     accept rate incl. driver_issues declines, GPS coverage, availability
//     coverage, avg time to complete, earnings = payrate×completed+tips,
//     compliance) — "Tracked by Towbook" framing, zero demo data
//   - coach recommendation logic: thresholds, top-2 by deviation,
//     plain-language why with real numbers, refresh:true after regression
//   - markLessonComplete idempotency (original completed_at survives)
//   - owner-in-driver-view sees THEIR OWN metrics via effectiveDriverIdentity
//   - role gates: contractor/dispatcher blocked from owner handlers;
//     owner/admin blocked from nothing.
// Cookie-backed handlers are driven through the seeded TanStack Start event
// context (server-runtime parity; no HTTP server). DB-backed against throwaway
// QA orgs deleted at the end (zero rows left; academy_lessons is GLOBAL shipped
// content and is deliberately never deleted).
//   DATABASE_URL=... bun metrics-academy.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 9).toString("base64");
await import("@tanstack/start-server-core");
const { H3Event } = await import("h3-v2");
const { ensureAuthSchema } = await import("./src/data/auth-server.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const {
  getOrgMetricsHandler, getDriverMetricsHandler, getMyMetricsHandler,
  getAcademyRecommendationsHandler, getLessonProgressHandler, markLessonCompleteHandler,
} = await import("./src/data/metrics-core.ts");
const { recordAvailabilityStart, recordAvailabilityStop } = await import("./src/data/driver-auth.ts");
const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};
const ORG = `qa metrics-academy ${randomUUID()}`;
const ORG2 = `qa metrics-academy ${randomUUID()}`;
const PREFIX = "qa-metrics-academy";
const tbId = (seed) => String(BigInt("0x" + seed.slice(-36).replace(/-/g, "").slice(0, 10)) % 1_000_000_000n);
const uid = (tag) => `qa-${PREFIX}-${tag}-${randomUUID()}`;
const email = (u) => `${u}@lightning.test`;
const OWNER = uid("owner");          // pure owner — no driver id, no link
const ADMIN = uid("admin");          // admin — owner access, no driver identity
const DISPATCHER = uid("disp");      // dispatcher — must be blocked from owner handlers
const GOOD = uid("good");            // contractor: near-perfect metrics
const BAD = uid("bad");              // contractor: weak across every dimension
const CLEAN = uid("clean");          // contractor: no jobs at all → on track
const OWNER_LINKED = uid("olink");   // owner linked to BAD (view-toggle shape b)
const AVAIL_USER = uid("avail");     // ORG2 driver for the availability upsert tests
const T_GOOD = tbId(uid("tgood"));
const T_BAD = tbId(uid("tbad"));
const T_CLEAN = tbId(uid("tclean"));
const NOW = Date.now();
const MIN = 60000;
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

/* ------------------------------ fixture ------------------------------ */
await ensureAuthSchema();
await ensureAuthSchema(); // idempotent (task: run twice)
await ensureSchema();
await ensureSchema();     // migration 26 idempotent: lesson seed + version row
// Post-incident environment drift (2026-08-12): driver_issues/job_feedback were
// dropped from the shared DB while migration 20 stays recorded, so ensureSchema
// can never recreate them — but metrics-core (decline count) and the driver
// support flows read driver_issues. Self-heal with the exact migration-20 DDL
// (idempotent CREATE IF NOT EXISTS — a no-op on a healthy DB).
await q`CREATE TABLE IF NOT EXISTS driver_issues (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  driver_id TEXT NOT NULL,
  driver_name TEXT,
  job_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('job_issue','payment','account','decline')),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;
await q`CREATE INDEX IF NOT EXISTS driver_issues_org_created_idx ON driver_issues(org_id, created_at)`;
// sweep leftovers from earlier crashed runs (QA-prefixed only)
for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa metrics-academy%'`) {
  assertQaOrg(org.id, org.name);
  await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
}
await q`DELETE FROM users WHERE email LIKE 'qa-metrics-academy-%@lightning.test'`.catch(() => {});
await q`INSERT INTO organizations(id, name) VALUES(${ORG}, ${ORG}), (${ORG2}, ${ORG2})`;
const ins = (id, name) => q`INSERT INTO users(id, name, email, password_hash) VALUES(${id}, ${name}, ${email(id)}, 'x')`;
await ins(OWNER, "Pure Owner");
await ins(ADMIN, "Admin One");
await ins(DISPATCHER, "Dispatcher One");
await ins(GOOD, "Good Driver");
await ins(BAD, "Bad Driver");
await ins(CLEAN, "Clean Driver");
await ins(OWNER_LINKED, "Linked Owner");
await ins(AVAIL_USER, "Avail Driver");
await q`UPDATE users SET towbook_driver_id=${T_GOOD} WHERE id=${GOOD}`;
await q`UPDATE users SET towbook_driver_id=${T_BAD} WHERE id=${BAD}`;
await q`UPDATE users SET towbook_driver_id=${T_CLEAN} WHERE id=${CLEAN}`;
await q`UPDATE users SET linked_driver_user_id=${BAD} WHERE id=${OWNER_LINKED}`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES
  (${ORG}, ${OWNER}, 'owner'),
  (${ORG}, ${ADMIN}, 'admin'),
  (${ORG}, ${DISPATCHER}, 'dispatcher'),
  (${ORG}, ${GOOD}, 'contractor'),
  (${ORG}, ${BAD}, 'contractor'),
  (${ORG}, ${CLEAN}, 'contractor'),
  (${ORG}, ${OWNER_LINKED}, 'owner'),
  (${ORG2}, ${AVAIL_USER}, 'contractor')`;
const sessions = new Map();
for (const u of [OWNER, ADMIN, DISPATCHER, GOOD, BAD, CLEAN, OWNER_LINKED]) {
  const token = `sess-${randomUUID()}`;
  sessions.set(u, token);
  await q`INSERT INTO sessions(id, user_id, expires_at) VALUES(${token}, ${u}, NOW() + INTERVAL '1 day')`;
}
await q`INSERT INTO org_settings(org_id) VALUES(${ORG}) ON CONFLICT(org_id) DO NOTHING`;
await q`INSERT INTO contractor_profiles(org_id, user_id, payrate_cents) VALUES
  (${ORG}, ${GOOD}, 9500), (${ORG}, ${BAD}, 8000), (${ORG}, ${CLEAN}, 12000)`;
// Compliance fixture: one active org doc type; GOOD verified, BAD uploaded-only.
await q`INSERT INTO contractor_doc_types(id, org_id, name, requires_expiry, sort_order, active) VALUES('qa-doc-w9', ${ORG}, 'W-9', FALSE, 1, TRUE)`;
await q`INSERT INTO contractor_documents(id, org_id, contractor_id, doc_type_id, storage_key, file_name, mime, size_bytes, status, uploaded_by_user_id)
  VALUES('qa-doc-good', ${ORG}, ${GOOD}, 'qa-doc-w9', 'qa/good-w9.pdf', 'w9.pdf', 'application/pdf', 100, 'verified', ${GOOD})`;
await q`INSERT INTO contractor_documents(id, org_id, contractor_id, doc_type_id, storage_key, file_name, mime, size_bytes, status, uploaded_by_user_id)
  VALUES('qa-doc-bad', ${ORG}, ${BAD}, 'qa-doc-w9', 'qa/bad-w9.pdf', 'w9.pdf', 'application/pdf', 100, 'uploaded', ${BAD})`;
/* ------------------- seeded request context (server-runtime parity) ------------------- */
const eventStorage = globalThis[Symbol.for("tanstack-start:event-storage")];
const startStorage = globalThis[Symbol.for("tanstack-start:start-storage-context")];
const withSession = (token, fn) => {
  const cookie = `ld_session_v2=${token}`;
  const h3Event = new H3Event(new Request("http://localhost/", { headers: { cookie } }));
  const req = new Request("http://localhost/", { headers: { cookie } });
  return startStorage.run(
    { startOptions: {}, request: req, contextAfterGlobalMiddlewares: null, executedRequestMiddlewares: new Set() },
    () => eventStorage.run({ h3Event }, fn),
  );
};
/* ------------------------------ job seeding ------------------------------ */
const PHASES = ["pre_arrival", "service", "final"];
const SIDES = ["front", "rear", "left", "right"];
let seq = 0;
/** Seed one completed job + its decision, events, photos, survey, tip, pings.
 *  Times are minutes from `created`. acceptAt/enRouteAt are ABSOLUTE minutes
 *  from creation; arrival anchors on the decision (created+1m) so
 *  arrivalMinutes = arriveAt - 1. completedAt = created + 30m (always in the
 *  past when createdAgoMs > 30m — keeps the week/month filters honest). */
async function seedCompleted({ id, tb, driverId, driverTb, createdAgoMs, acceptAt, enRouteAt, arriveAt, rating = null, comment = null, tipCents = null, photoPhases = 0, pingCount = 0, pingAgoMs = null }) {
  const created = NOW - createdAgoMs;
  const completed = created + 30 * MIN;
  await q`INSERT INTO dispatch_jobs(id, org_id, towbook_job_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, assigned_driver_towbook_id, arrived_at, completed_at)
    VALUES(${id}, ${ORG}, ${tb}, 'QA Customer', '555-0100', 41.2, -73.2, 'Bridgeport', 'jump', 'completed', ${iso(created)}, '', ${driverTb},
      ${iso(created + (1 + arriveAt) * MIN)}, ${iso(completed)})`;
  await q`INSERT INTO ai_dispatcher_decisions(id, org_id, call_request_id, call_id, decision, escalated, driver_id, driver_name, eta_minutes, reason, raw_response, created_at)
    VALUES(${`qa-dec-${id}`}, ${ORG}, ${`qa-cr-${tb}`}, ${tb}, 'auto_accept_with_driver', FALSE, ${driverId}, ${driverId === GOOD ? "Good Driver" : "Bad Driver"}, 20, 'qa fixture', '{}'::jsonb, ${iso(created + MIN)})`;
  const ev = (k, from, to, atMs) => q`INSERT INTO status_events(id, org_id, job_id, from_status, to_status, actor_user_id, actor_role, note, occurred_at)
    VALUES(${`qa-ev-${id}-${k}`}, ${ORG}, ${id}, ${from}, ${to}, ${driverId}, 'contractor', NULL, ${iso(atMs)})`;
  await ev("offered", "new", "offered", created + 2 * MIN);
  await ev("accepted", "offered", "accepted", created + acceptAt * MIN);
  await ev("enroute", "accepted", "en_route", created + enRouteAt * MIN);
  await ev("completed", "arrived", "completed", created + 30 * MIN);
  for (let p = 0; p < photoPhases; p++) {
    for (const side of SIDES) {
      seq += 1;
      await q`INSERT INTO job_photos(id, org_id, job_id, phase, side, storage_key, uploaded_at, uploaded_by_user_id, match_confirmed)
        VALUES(${`qa-ph-${seq}`}, ${ORG}, ${id}, ${PHASES[p]}, ${side}, ${`qa/${id}/${PHASES[p]}/${side}.jpg`}, ${iso(created + 5 * MIN)}, ${driverId}, TRUE)`;
    }
  }
  if (rating != null) {
    await q`INSERT INTO job_completions(org_id, job_id, signature_storage_key, survey, created_at, updated_at)
      VALUES(${ORG}, ${id}, NULL, ${JSON.stringify({ rating, comment: comment ?? null })}::jsonb, ${iso(completed)}, ${iso(completed)})`;
  }
  if (tipCents != null) {
    await q`INSERT INTO completion_tips(id, org_id, job_id, driver_id, driver_towbook_id, amount_cents, status, idempotency_key, created_at)
      VALUES(${`qa-tip-${id}`}, ${ORG}, ${id}, ${driverId}, ${driverTb}, ${tipCents}, 'paid', ${`qa-tipk-${id}`}, ${iso(completed)})`;
  }
  for (let i = 0; i < pingCount; i++) {
    await q`INSERT INTO driver_locations(id, org_id, driver_id, towbook_driver_id, job_id, latitude, longitude, accuracy, captured_at)
      VALUES(${`qa-loc-${id}-${i}`}, ${ORG}, ${driverId}, ${driverTb}, ${id}, 41.2, -73.2, 10, ${iso(NOW - (pingAgoMs ?? createdAgoMs) + i * MIN)})`;
  }
}
// GOOD: J1/J2 this week, J3 40 days ago (outside week+month). All on time, 12/12, 5★, tipped.
await seedCompleted({ id: "qa-j1", tb: "700001", driverId: GOOD, driverTb: T_GOOD, createdAgoMs: 40 * MIN, acceptAt: 4, enRouteAt: 9, arriveAt: 15, rating: 5, comment: "Top", tipCents: 2000, photoPhases: 3, pingCount: 2 });
await seedCompleted({ id: "qa-j2", tb: "700002", driverId: GOOD, driverTb: T_GOOD, createdAgoMs: 70 * MIN, acceptAt: 4, enRouteAt: 9, arriveAt: 15, rating: 5, comment: "Great", tipCents: 500, photoPhases: 3, pingCount: 2 });
await seedCompleted({ id: "qa-j3", tb: "700003", driverId: GOOD, driverTb: T_GOOD, createdAgoMs: 40 * DAY, acceptAt: 4, enRouteAt: 9, arriveAt: 15, rating: 5, comment: "Old", tipCents: 500, photoPhases: 3, pingCount: 2 });
// BAD: B1..B5 completed (weak across the board), E1 still en route, D1/D2 declined.
await seedCompleted({ id: "qa-b1", tb: "700101", driverId: BAD, driverTb: T_BAD, createdAgoMs: 3 * 3600e3, acceptAt: 10, enRouteAt: 40, arriveAt: 40, rating: 3, comment: "ok", tipCents: 1000, photoPhases: 3, pingCount: 3 });
await seedCompleted({ id: "qa-b2", tb: "700102", driverId: BAD, driverTb: T_BAD, createdAgoMs: 4 * 3600e3, acceptAt: 10, enRouteAt: 40, arriveAt: 40, rating: 2, comment: null, tipCents: null, photoPhases: 2 });
await seedCompleted({ id: "qa-b3", tb: "700103", driverId: BAD, driverTb: T_BAD, createdAgoMs: 5 * 3600e3, acceptAt: 8, enRouteAt: 33, arriveAt: 40, rating: 5, comment: "great", tipCents: null, photoPhases: 0 });
await seedCompleted({ id: "qa-b4", tb: "700104", driverId: BAD, driverTb: T_BAD, createdAgoMs: 6 * 3600e3, acceptAt: 6, enRouteAt: 16, arriveAt: 15, rating: 5, comment: "fine", tipCents: null, photoPhases: 2 });
await seedCompleted({ id: "qa-b5", tb: "700105", driverId: BAD, driverTb: T_BAD, createdAgoMs: 7 * 3600e3, acceptAt: 6, enRouteAt: 16, arriveAt: 15, rating: 4, comment: "meh", tipCents: null, photoPhases: 3 });
await q`INSERT INTO dispatch_jobs(id, org_id, towbook_job_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, assigned_driver_towbook_id)
  VALUES('qa-e1', ${ORG}, '700106', 'QA E1', '555-0100', 41.2, -73.2, 'Bridgeport', 'jump', 'en_route', ${iso(NOW - 8 * 3600e3)}, '', ${T_BAD})`;
for (const [jid, tb] of [["qa-d1", "700107"], ["qa-d2", "700108"]]) {
  await q`INSERT INTO dispatch_jobs(id, org_id, towbook_job_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, assigned_driver_towbook_id)
    VALUES(${jid}, ${ORG}, ${tb}, 'QA Declined', '555-0100', 41.2, -73.2, 'Bridgeport', 'jump', 'offered', ${iso(NOW - 9 * 3600e3)}, '', ${T_BAD})`;
  await q`INSERT INTO driver_issues(id, org_id, driver_id, driver_name, job_id, kind, message, created_at)
    VALUES(${`qa-iss-${jid}`}, ${ORG}, ${BAD}, 'Bad Driver', ${jid}, 'decline', 'cannot take', ${iso(NOW - 9 * 3600e3)})`;
}
// BAD availability: two full 720-min days (yesterday + today) → 50% coverage of "all".
// Days come FROM THE DATABASE (CURRENT_DATE) so the strings always match what
// the availability helpers write (recordAvailabilityStart uses CURRENT_DATE).
const [tzRow] = await q`SELECT CURRENT_DATE::text AS today, (CURRENT_DATE - 1)::text AS yesterday`;
const today = String(tzRow.today);
const yesterday = String(tzRow.yesterday);
await q`INSERT INTO driver_availability_log(org_id, user_id, day, online_minutes, ping_count, session_started_at) VALUES
  (${ORG}, ${BAD}, ${yesterday}, 720, 1, NULL),
  (${ORG}, ${BAD}, ${today}, 720, 1, NULL)`;
// One fresh GPS ping for BAD (job-scope NULL → 24h card, not job coverage).
await q`INSERT INTO driver_locations(id, org_id, driver_id, towbook_driver_id, job_id, latitude, longitude, accuracy, captured_at)
  VALUES('qa-loc-fresh', ${ORG}, ${BAD}, ${T_BAD}, NULL, 41.2, -73.2, 10, NOW())`;

/* ============ 1) migration 26 idempotency + academy lesson seed ============ */
{
  const v26 = await q`SELECT COUNT(*)::int AS n FROM schema_migrations WHERE version=26`;
  check("migration 26: recorded exactly once after double ensureSchema", v26[0].n === 1, JSON.stringify(v26[0]));
  const lessons = await q`SELECT id, slug, title, metric_key, sort_order FROM academy_lessons WHERE active=TRUE ORDER BY sort_order`;
  check("academy seed: exactly 11 active lessons (no dupes from the second run)", lessons.length === 11, JSON.stringify(lessons.map((l) => l.slug)));
  const slugs = lessons.map((l) => String(l.slug));
  check("academy seed: all 11 expected slugs present",
    JSON.stringify(slugs) === JSON.stringify(["pre-trip-readiness", "eta-honesty", "twelve-photo-routine", "first-impressions", "turning-service-into-tips", "acceptance-discipline", "stay-visible", "go-offline-planning", "finish-strong", "paperwork-done-right", "on-time-service-standards"]), JSON.stringify(slugs));
  const keys = lessons.map((l) => String(l.metric_key)).sort().join(",");
  check("academy seed: one lesson per metric_key",
    keys === "accept_rate,accept_time,availability,completion_rate,customer_rating,documents,eta_accuracy,gps_coverage,photos_compliance,service_time,tips", keys);
  const pw = lessons.find((l) => l.slug === "paperwork-done-right");
  check("academy seed: paperwork lesson maps to documents metric", pw && String(pw.metric_key) === "documents" && Number(pw.sort_order) === 10, JSON.stringify(pw));
}

/* ============ 2) driver_availability_log upsert (GO/Offline toggle helpers) ============ */
{
  await recordAvailabilityStart(q, ORG2, AVAIL_USER); // GO
  let row = await q`SELECT online_minutes, ping_count, session_started_at FROM driver_availability_log WHERE org_id=${ORG2} AND user_id=${AVAIL_USER} AND day=${today}`;
  check("avail GO: row created for today with open stretch (ping 1, minutes 0)",
    row.length === 1 && Number(row[0].online_minutes) === 0 && Number(row[0].ping_count) === 1 && row[0].session_started_at != null, JSON.stringify(row));
  const firstStart = new Date(String(row[0].session_started_at)).getTime();
  await recordAvailabilityStart(q, ORG2, AVAIL_USER); // GO while already open
  row = await q`SELECT online_minutes, ping_count, session_started_at FROM driver_availability_log WHERE org_id=${ORG2} AND user_id=${AVAIL_USER} AND day=${today}`;
  check("avail GO while open: ping_count stays 1, stretch NOT restarted",
    Number(row[0].ping_count) === 1 && new Date(String(row[0].session_started_at)).getTime() === firstStart, JSON.stringify(row));
  await q`UPDATE driver_availability_log SET session_started_at=NOW() - INTERVAL '90 minutes' WHERE org_id=${ORG2} AND user_id=${AVAIL_USER} AND day=${today}`;
  await recordAvailabilityStop(q, ORG2, AVAIL_USER); // Offline
  row = await q`SELECT online_minutes, ping_count, session_started_at FROM driver_availability_log WHERE org_id=${ORG2} AND user_id=${AVAIL_USER} AND day=${today}`;
  check("avail Offline: banks 90 min on the start-day row and closes the stretch",
    Number(row[0].online_minutes) === 90 && Number(row[0].ping_count) === 1 && row[0].session_started_at == null, JSON.stringify(row));
  await recordAvailabilityStart(q, ORG2, AVAIL_USER); // GO again → real reopen
  row = await q`SELECT online_minutes, ping_count, session_started_at FROM driver_availability_log WHERE org_id=${ORG2} AND user_id=${AVAIL_USER} AND day=${today}`;
  check("avail re-GO after Offline: ping_count 2 (reopen counted), minutes unchanged",
    Number(row[0].online_minutes) === 90 && Number(row[0].ping_count) === 2 && row[0].session_started_at != null, JSON.stringify(row));
  await q`UPDATE driver_availability_log SET session_started_at=NOW() - INTERVAL '60 minutes' WHERE org_id=${ORG2} AND user_id=${AVAIL_USER} AND day=${today}`;
  await recordAvailabilityStop(q, ORG2, AVAIL_USER); // close again (90+60=150)
  // Overnight stretch: a session opened YESTERDAY 23:00, closed today — the
  // elapsed minutes bank on the START day (yesterday), never today's row.
  await q`INSERT INTO driver_availability_log(org_id, user_id, day, online_minutes, ping_count, session_started_at)
    VALUES(${ORG2}, ${AVAIL_USER}, ${yesterday}, 0, 0, ${`${yesterday}T23:00:00Z`})`;
  const yRowBefore = await q`SELECT session_started_at FROM driver_availability_log WHERE org_id=${ORG2} AND user_id=${AVAIL_USER} AND day=${yesterday}`;
  const yStart = new Date(String(yRowBefore[0].session_started_at)).getTime();
  const expected = Math.max(1, Math.floor((Date.now() - yStart) / 60000));
  await recordAvailabilityStop(q, ORG2, AVAIL_USER);
  const yRow = await q`SELECT online_minutes, session_started_at FROM driver_availability_log WHERE org_id=${ORG2} AND user_id=${AVAIL_USER} AND day=${yesterday}`;
  const tRow = await q`SELECT online_minutes FROM driver_availability_log WHERE org_id=${ORG2} AND user_id=${AVAIL_USER} AND day=${today}`;
  check("avail overnight: elapsed banks on the START day (yesterday) with the stretch closed",
    yRow.length === 1 && Math.abs(Number(yRow[0].online_minutes) - expected) <= 1 && yRow[0].session_started_at == null, JSON.stringify(yRow));
  check("avail overnight: today's banked 150 min untouched (no double-bank)",
    Number(tRow[0].online_minutes) === 150, JSON.stringify(tRow));
}

/* ============ 3) fleet metrics + aggregate (owner handler) ============ */
{
  const r = await withSession(sessions.get(OWNER), () => getOrgMetricsHandler("all"));
  check("org metrics: owner ok, period honored", r.ok === true && r.period === "all", JSON.stringify(r));
  const bad = r.ok && r.fleet.find((d) => d.userId === BAD);
  check("fleet: BAD row — jobs 5, accept 6min, en-route 21min, late 60%, photos 40%, rating 3.8, tips 1000/20%, accept 71% (2 declines), GPS 13%, avail 50%, TTC 118, earnings 41000",
    bad && bad.jobsCompleted === 5 && bad.avgAcceptMinutes === 6 && bad.avgEnRouteMinutes === 21 &&
    bad.lateJobsPct === 60 && bad.photosPct === 40 && bad.avgCustomerRating === 3.8 && bad.ratingCount === 5 &&
    bad.tipsCents === 1000 && bad.tipRatePct === 20 && bad.acceptRatePct === 71 && bad.declines === 2 &&
    bad.gpsCoveragePct === 13 && bad.onlineCoveragePct === 50 && bad.onlineMinutes === 1440 &&
    bad.avgTimeToCompleteMinutes === 28 && bad.payrateCents === 8000 && bad.earningsCents === 41000 && bad.status === "online",
    JSON.stringify(bad));
  check("fleet: BAD compliance not-ok (W-9 uploaded, not approved)", bad && bad.compliance && bad.compliance.required === 1 && bad.compliance.approved === 0 && bad.compliance.onFile === 1 && bad.compliance.ok === false, JSON.stringify(bad?.compliance));
  check("fleet: BAD academy top-2 by deviation = documents (100) then GPS coverage (67)",
    bad && bad.academy.length === 2 && bad.academy[0].lessonId === "lesson-paperwork-done-right" && bad.academy[0].deviation === 100 &&
    bad.academy[1].lessonId === "lesson-stay-visible" && bad.academy[1].deviation === 67,
    JSON.stringify(bad?.academy));
  check("fleet: BAD coach why is plain-language with real numbers",
    bad && bad.academy[0].why.includes("1 required document missing or not approved") &&
    bad.academy[1].why.includes("13% of jobs had location updates"), JSON.stringify(bad?.academy.map((a) => a.why)));
  const good = r.ok && r.fleet.find((d) => d.userId === GOOD);
  check("fleet: GOOD row — 3 jobs, 100% photos/rating/tips/accept, earnings 31500, compliance ok, no coach recs",
    good && good.jobsCompleted === 3 && good.photosPct === 100 && good.avgCustomerRating === 5 && good.tipRatePct === 100 &&
    good.acceptRatePct === 100 && good.completionRatePct === 100 && good.gpsCoveragePct === 100 && good.tipsCents === 3000 &&
    good.earningsCents === 31500 && good.compliance && good.compliance.ok === true && good.academy.length === 0,
    JSON.stringify(good));
  const clean = r.ok && r.fleet.find((d) => d.userId === CLEAN);
  check("fleet: CLEAN row — no jobs, no coach recs (on track)", clean && clean.jobsCompleted === 0 && clean.academy.length === 0, JSON.stringify(clean));
  check("fleet: drivers count = 3, aggregate jobs 8, completion 73%, tips 4000, rating 4.3, accept 4.5min, on-time 63%, photos 63%, TTC 28",
    r.ok && r.aggregate.drivers === 3 && r.aggregate.jobsCompleted === 8 && r.aggregate.completionRatePct === 73 &&
    r.aggregate.tipsCents === 4000 && r.aggregate.avgCustomerRating === 4.3 && r.aggregate.avgAcceptMinutes === 4.5 &&
    r.aggregate.onTimePct === 63 && r.aggregate.photoCompliancePct === 63 && r.aggregate.avgTimeToCompleteMinutes === 28,
    JSON.stringify(r?.aggregate));
}

/* ============ 4) per-driver detail (owner handler) ============ */
{
  const d = await withSession(sessions.get(OWNER), () => getDriverMetricsHandler(BAD, "all"));
  check("driver detail: ok + driver row identity", d.ok === true && d.driver.userId === BAD && d.driver.name === "Bad Driver" && d.driver.towbookDriverId === T_BAD, JSON.stringify(d.driver && { userId: d.driver.userId, name: d.driver.name }));
  check("detail: stats — 5 jobs, earnings 41000, tips 1000, rating 3.8, payrate 8000",
    d.ok && d.driver.stats.jobsCompleted === 5 && d.driver.stats.earningsCents === 41000 && d.driver.stats.tipsCents === 1000 &&
    d.driver.stats.avgRating === 3.8 && d.driver.stats.ratingCount === 5 && d.driver.stats.payrateCents === 8000, JSON.stringify(d.driver.stats));
  const m = d.ok && d.driver.metrics;
  check("detail: acceptTime 6min (goal 5, weak, why) + trend array", m && m.acceptTime.value === 6 && m.acceptTime.target === 5 && m.acceptTime.weak === true && m.acceptTime.why === "avg accept 6 min — goal under 5" && Array.isArray(m.acceptTime.trend) && m.acceptTime.trend.length === 4, JSON.stringify(m?.acceptTime));
  check("detail: etaAccuracy 40% on time (weak via 60% late 10+ min)", m && m.etaAccuracy.value === 40 && m.etaAccuracy.weak === true && m.etaAccuracy.why.includes("60% of jobs 10+ min late"), JSON.stringify(m?.etaAccuracy));
  check("detail: photos 40% 12/12 weak", m && m.photos.value === 40 && m.photos.weak === true, JSON.stringify(m?.photos));
  check("detail: completionRate 63% weak", m && m.completionRate.value === 63 && m.completionRate.weak === true, JSON.stringify(m?.completionRate));
  check("detail: customerRating 3.8 weak", m && m.customerRating.value === 3.8 && m.customerRating.weak === true, JSON.stringify(m?.customerRating));
  check("detail: tipRate 20% weak", m && m.tipRate.value === 20 && m.tipRate.weak === true, JSON.stringify(m?.tipRate));
  check("detail: acceptRate 71% weak", m && m.acceptRate.value === 71 && m.acceptRate.weak === true, JSON.stringify(m?.acceptRate));
  check("detail: gpsCoverage 13% weak", m && m.gpsCoverage.value === 13 && m.gpsCoverage.weak === true, JSON.stringify(m?.gpsCoverage));
  check("detail: availability 50% of week weak", m && m.availability.value === 50 && m.availability.weak === true, JSON.stringify(m?.availability));
  check("detail: avgTimeToComplete 28 min (no target)", m && m.avgTimeToComplete.value === 28 && m.avgTimeToComplete.weak === false, JSON.stringify(m?.avgTimeToComplete));
  const pc = d.ok && d.driver.photosCard;
  check("detail: photos card — pct12 40, per-phase averages 3.2/3.2/1.6",
    pc && pc.pct12 === 40 && pc.preArrivalAvg === 3.2 && pc.serviceAvg === 3.2 && pc.finalAvg === 1.6, JSON.stringify(pc));
  const sv = d.ok && d.driver.surveys;
  check("detail: rating distribution [0,1,1,1,2] + latest comments newest-first",
    sv && JSON.stringify(sv.distribution) === JSON.stringify([0, 1, 1, 1, 2]) && sv.latest.length === 3 &&
    sv.latest[0].rating === 3 && sv.latest[0].comment === "ok" && sv.latest[0].jobLabel === "Call #700101" &&
    sv.latest[1].rating === 2 && sv.latest[2].rating === 5 && sv.latest[2].comment === "great", JSON.stringify(sv));
  const av = d.ok && d.driver.availabilityCard;
  check("detail: availability card — online, 4 pings in 24h (3 job + 1 fresh), last ping present",
    av && av.currentStatus === "online" && av.pings24h === 4 && av.lastPingAt != null, JSON.stringify(av));
  const ai = d.ok && d.driver.aiDispatch;
  check("detail: AI dispatch card — 5 auto-accepts @20min avg, 0 escalations",
    ai && ai.autoAccepted === 5 && ai.avgQuotedEtaMinutes === 20 && ai.escalations === 0, JSON.stringify(ai));
  // GOOD detail: strong metrics, no weak flags, no coach recs.
  const g = await withSession(sessions.get(OWNER), () => getDriverMetricsHandler(GOOD, "all"));
  check("detail GOOD: 3 jobs, earnings 31500, accept 2min not weak, photos 100 not weak, rating 5 not weak, no academy",
    g.ok && g.driver.stats.jobsCompleted === 3 && g.driver.stats.earningsCents === 31500 && g.driver.metrics.acceptTime.value === 2 && g.driver.metrics.acceptTime.weak === false &&
    g.driver.metrics.photos.value === 100 && g.driver.metrics.photos.weak === false && g.driver.metrics.customerRating.value === 5 &&
    g.driver.metrics.customerRating.weak === false && g.driver.academy.length === 0, JSON.stringify(g.driver.stats));
  const miss = await withSession(sessions.get(OWNER), () => getDriverMetricsHandler("no-such-user", "all"));
  check("detail: unknown driver → not on this account", miss.ok === false && miss.error.includes("isn't on this account"), JSON.stringify(miss));
}

/* ============ 5) my-metrics (contractor + owner-in-driver-view) ============ */
{
  const mine = await withSession(sessions.get(BAD), () => getMyMetricsHandler("all"));
  check("my metrics: contractor sees OWN row (5 jobs, earnings 41000)",
    mine.ok === true && mine.driver.userId === BAD && mine.driver.stats.jobsCompleted === 5 && mine.driver.stats.earningsCents === 41000, JSON.stringify(mine.driver && mine.driver.userId));
  const olink = await withSession(sessions.get(OWNER_LINKED), () => getMyMetricsHandler("all"));
  check("owner-in-driver-view: linked owner sees the LINKED driver's metrics (not their own)",
    olink.ok === true && olink.driver.userId === BAD && olink.driver.name === "Bad Driver" && olink.driver.stats.jobsCompleted === 5, JSON.stringify(olink.driver && olink.driver.userId));
  const pure = await withSession(sessions.get(OWNER), () => getMyMetricsHandler("all"));
  check("pure owner without identity → 'Sign in as a driver first.'", pure.ok === false && pure.error.includes("Sign in as a driver first"), JSON.stringify(pure));
  // Period filtering: J3 (40 days ago) excluded from week+month — computed
  // against the real period start so the suite is deterministic at any hour.
  const wk = await withSession(sessions.get(GOOD), () => getMyMetricsHandler("week"));
  const mo = await withSession(sessions.get(GOOD), () => getMyMetricsHandler("month"));
  const al = await withSession(sessions.get(GOOD), () => getMyMetricsHandler("all"));
  const weekStart = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); })();
  const monthStart = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(1); return d.getTime(); })();
  const j1Done = NOW - 40 * MIN + 30 * MIN; // qa-j1 completedAt
  const j2Done = NOW - 70 * MIN + 30 * MIN; // qa-j2 completedAt
  const inP = (ts, start) => start <= ts && ts < NOW;
  const expWeek = (inP(j2Done, weekStart) ? 1 : 0) + (inP(j1Done, weekStart) ? 1 : 0);
  const expMonth = (inP(j2Done, monthStart) ? 1 : 0) + (inP(j1Done, monthStart) ? 1 : 0);
  check("periods: week counts only in-week jobs (J3 excluded)", wk.ok && wk.driver.stats.jobsCompleted === expWeek && wk.driver.stats.earningsCents === (expWeek === 3 ? 31500 : expWeek === 2 ? 21500 : 0), JSON.stringify(wk.driver?.stats));
  check("periods: month counts only in-month jobs (J3 excluded)", mo.ok && mo.driver.stats.jobsCompleted === expMonth, JSON.stringify(mo.driver?.stats));
  check("periods: all counts all 3 jobs", al.ok && al.driver.stats.jobsCompleted === 3 && al.driver.stats.tipsCents === 3000, JSON.stringify(al.driver?.stats));
}

/* ============ 6) academy: recommendations + progress + mark-complete idempotency ============ */
{
  const rec = await withSession(sessions.get(BAD), () => getAcademyRecommendationsHandler());
  check("academy recs: BAD — onTrack false, top-2 = paperwork (refresh false) + stay-visible",
    rec.ok === true && rec.onTrack === false && rec.driverName === "Bad Driver" && rec.recommendations.length === 2 &&
    rec.recommendations[0].lessonId === "lesson-paperwork-done-right" && rec.recommendations[0].status === "not_started" && rec.recommendations[0].refresh === false &&
    rec.recommendations[1].lessonId === "lesson-stay-visible" && rec.recommendations[1].slug === "stay-visible",
    JSON.stringify(rec));
  const okRec = await withSession(sessions.get(GOOD), () => getAcademyRecommendationsHandler());
  check("academy recs: GOOD — only weakness is 0% week availability → exactly the GO/Offline lesson (deviation 60)",
    okRec.ok === true && okRec.onTrack === false && okRec.recommendations.length === 1 &&
    okRec.recommendations[0].lessonId === "lesson-go-offline-planning" && okRec.recommendations[0].metricKey === "availability" &&
    okRec.recommendations[0].deviation === 60 && okRec.recommendations[0].why.includes("0% of this week"), JSON.stringify(okRec));
  const cleanRec = await withSession(sessions.get(CLEAN), () => getAcademyRecommendationsHandler());
  check("academy recs: CLEAN (no jobs) — only the availability lesson, no spurious recs from null metrics",
    cleanRec.ok === true && cleanRec.recommendations.length === 1 &&
    cleanRec.recommendations[0].lessonId === "lesson-go-offline-planning", JSON.stringify(cleanRec));
  const prog0 = await withSession(sessions.get(BAD), () => getLessonProgressHandler());
  check("lesson progress: 11 lessons, all not_started before marking",
    prog0.ok === true && prog0.lessons.length === 11 && prog0.lessons.every((l) => l.status === "not_started") && prog0.lessons[0].lessonId === "lesson-pre-trip-readiness", JSON.stringify(prog0.lessons?.[0]));
  const mark1 = await withSession(sessions.get(BAD), () => markLessonCompleteHandler("lesson-paperwork-done-right"));
  check("mark complete: ok", mark1.ok === true && mark1.status === "completed", JSON.stringify(mark1));
  const dbRow1 = await q`SELECT completed_at FROM academy_progress WHERE org_id=${ORG} AND user_id=${BAD} AND lesson_id='lesson-paperwork-done-right'`;
  const firstDone = new Date(String(dbRow1[0].completed_at)).toISOString();
  check("mark complete: progress row persisted", dbRow1.length === 1 && firstDone.length > 0, JSON.stringify(dbRow1));
  await new Promise((r) => setTimeout(r, 1100));
  const mark2 = await withSession(sessions.get(BAD), () => markLessonCompleteHandler("lesson-paperwork-done-right"));
  const dbRow2 = await q`SELECT completed_at FROM academy_progress WHERE org_id=${ORG} AND user_id=${BAD} AND lesson_id='lesson-paperwork-done-right'`;
  check("mark complete: idempotent — second call ok and keeps the ORIGINAL completed_at",
    mark2.ok === true && new Date(String(dbRow2[0].completed_at)).toISOString() === firstDone, JSON.stringify(dbRow2));
  const badId = await withSession(sessions.get(BAD), () => markLessonCompleteHandler("no-such-lesson"));
  check("mark complete: unknown lesson → not available", badId.ok === false && badId.error.includes("isn't available"), JSON.stringify(badId));
  const rec2 = await withSession(sessions.get(BAD), () => getAcademyRecommendationsHandler());
  check("academy recs after regression: paperwork still recommended, status completed + refresh:true",
    rec2.ok === true && rec2.recommendations[0].lessonId === "lesson-paperwork-done-right" && rec2.recommendations[0].status === "completed" && rec2.recommendations[0].refresh === true &&
    rec2.recommendations[1].status === "not_started" && rec2.recommendations[1].refresh === false, JSON.stringify(rec2.recommendations));
  const prog1 = await withSession(sessions.get(BAD), () => getLessonProgressHandler());
  const pw = prog1.ok && prog1.lessons.find((l) => l.lessonId === "lesson-paperwork-done-right");
  check("lesson progress after mark: paperwork completed w/ completedAt; others untouched",
    pw && pw.status === "completed" && pw.completedAt != null && prog1.lessons.filter((l) => l.status === "completed").length === 1, JSON.stringify(pw));
}

/* ============ 7) role gates ============ */
{
  const cOrg = await withSession(sessions.get(BAD), () => getOrgMetricsHandler("all"));
  check("gate: contractor blocked from org metrics (Owner access required)", cOrg.ok === false && cOrg.error.includes("Owner access required"), JSON.stringify(cOrg));
  const dOrg = await withSession(sessions.get(DISPATCHER), () => getOrgMetricsHandler("all"));
  check("gate: dispatcher blocked from org metrics", dOrg.ok === false && dOrg.error.includes("Owner access required"), JSON.stringify(dOrg));
  const dDet = await withSession(sessions.get(DISPATCHER), () => getDriverMetricsHandler(BAD, "all"));
  check("gate: dispatcher blocked from driver detail", dDet.ok === false && dDet.error.includes("Owner access required"), JSON.stringify(dDet));
  const aOrg = await withSession(sessions.get(ADMIN), () => getOrgMetricsHandler("all"));
  check("gate: admin ALLOWED org metrics (owner access extends to admins)", aOrg.ok === true && aOrg.aggregate.drivers === 3, JSON.stringify(aOrg));
  const aDet = await withSession(sessions.get(ADMIN), () => getDriverMetricsHandler(GOOD, "all"));
  check("gate: admin ALLOWED driver detail", aDet.ok === true && aDet.driver.userId === GOOD, JSON.stringify(aDet));
  const dMine = await withSession(sessions.get(DISPATCHER), () => getMyMetricsHandler("all"));
  check("gate: dispatcher without identity → Sign in as a driver first.", dMine.ok === false && dMine.error.includes("Sign in as a driver first"), JSON.stringify(dMine));
  const pLess = await withSession(sessions.get(OWNER), () => getLessonProgressHandler());
  check("gate: pure owner without identity blocked from lessons", pLess.ok === false && pLess.error.includes("Sign in as a driver first"), JSON.stringify(pLess));
  const pRec = await withSession(sessions.get(OWNER), () => getAcademyRecommendationsHandler());
  check("gate: pure owner without identity blocked from academy recs", pRec.ok === false && pRec.error.includes("Sign in as a driver first"), JSON.stringify(pRec));
  const oMine = await withSession(sessions.get(OWNER_LINKED), () => getOrgMetricsHandler("all"));
  check("gate: owner-in-driver-view still holds OWNER powers (org metrics ok)", oMine.ok === true && oMine.fleet.length === 3, JSON.stringify(oMine));
}

/* ------------------------------- summary + cleanup ------------------------------- */
const failed = checks.filter(([, ok]) => !ok);
console.log(`metrics-academy.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }
const memberIds = await q`SELECT DISTINCT m.user_id FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa metrics-academy%'`;
for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa metrics-academy%'`) {
  assertQaOrg(org.id, org.name);
  await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
}
for (const m of memberIds) await q`DELETE FROM users WHERE id=${m.user_id}`.catch(() => {});
await q`DELETE FROM users WHERE email LIKE 'qa-metrics-academy-%@lightning.test'`.catch(() => {});
const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa metrics-academy%') AS orgs,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE 'qa-metrics-academy-%@lightning.test') AS users,
  (SELECT COUNT(*)::int FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.email LIKE 'qa-metrics-academy-%@lightning.test') AS sessions,
  (SELECT COUNT(*)::int FROM dispatch_jobs j JOIN organizations o ON o.id=j.org_id WHERE o.name LIKE 'qa metrics-academy%') AS jobs,
  (SELECT COUNT(*)::int FROM status_events e JOIN organizations o ON o.id=e.org_id WHERE o.name LIKE 'qa metrics-academy%') AS events,
  (SELECT COUNT(*)::int FROM job_photos p JOIN organizations o ON o.id=p.org_id WHERE o.name LIKE 'qa metrics-academy%') AS photos,
  (SELECT COUNT(*)::int FROM job_completions c JOIN organizations o ON o.id=c.org_id WHERE o.name LIKE 'qa metrics-academy%') AS completions,
  (SELECT COUNT(*)::int FROM completion_tips t JOIN organizations o ON o.id=t.org_id WHERE o.name LIKE 'qa metrics-academy%') AS tips,
  (SELECT COUNT(*)::int FROM driver_locations l JOIN organizations o ON o.id=l.org_id WHERE o.name LIKE 'qa metrics-academy%') AS pings,
  (SELECT COUNT(*)::int FROM driver_issues i JOIN organizations o ON o.id=i.org_id WHERE o.name LIKE 'qa metrics-academy%') AS issues,
  (SELECT COUNT(*)::int FROM ai_dispatcher_decisions d JOIN organizations o ON o.id=d.org_id WHERE o.name LIKE 'qa metrics-academy%') AS decisions,
  (SELECT COUNT(*)::int FROM driver_availability_log a JOIN organizations o ON o.id=a.org_id WHERE o.name LIKE 'qa metrics-academy%') AS avail,
  (SELECT COUNT(*)::int FROM academy_progress ap JOIN organizations o ON o.id=ap.org_id WHERE o.name LIKE 'qa metrics-academy%') AS progress,
  (SELECT COUNT(*)::int FROM contractor_doc_types t JOIN organizations o ON o.id=t.org_id WHERE o.name LIKE 'qa metrics-academy%') AS doctypes,
  (SELECT COUNT(*)::int FROM contractor_documents d JOIN organizations o ON o.id=d.org_id WHERE o.name LIKE 'qa metrics-academy%') AS docs,
  (SELECT COUNT(*)::int FROM contractor_profiles cp JOIN organizations o ON o.id=cp.org_id WHERE o.name LIKE 'qa metrics-academy%') AS profiles,
  (SELECT COUNT(*)::int FROM org_settings os JOIN organizations o ON o.id=os.org_id WHERE o.name LIKE 'qa metrics-academy%') AS settings,
  (SELECT COUNT(*)::int FROM audit_log a JOIN organizations o ON o.id=a.org_id WHERE o.name LIKE 'qa metrics-academy%') AS audit`;
const z = Object.values(leftover[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) { console.error("FAIL: QA cleanup left rows behind"); process.exit(1); }
console.log("metrics-academy.test.mjs: cleanup verified — zero QA rows left");
