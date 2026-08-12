/**
 * Metrics tab + Lightning Dispatch Academy core (owner-directed 2026-08-12,
 * metrics-academy-spec.md). SERVER-ONLY module: imported by the client-safe
 * facade (metrics.ts) via dynamic import inside createServerFn handlers — never
 * statically by a client-reachable module (tanstack-client-graph-leak rule).
 *
 * All metrics are computed from the LOCAL DB mirror of Towbook (the 3s sync in
 * server.ts startBackgroundSync) — "Tracked by Towbook" is honest framing:
 * these are Towbook-derived facts, synced continuously. NO demo data ever: the
 * seeded dispatch_contractors legacy table (and its fake
 * response_time_history_minutes/rating) is NEVER read here.
 *
 * House style (same as the AI dispatcher): deterministic + explainable. Every
 * metric carries a plain-language "why" with real numbers; the Academy coach is
 * pure rule logic over the metric table in §4 — never a black box.
 */
import { sql } from "~/db";
import { deriveDocStatus, type DocStatus } from "./contractor-admin-core";

export type MetricsPeriod = "week" | "month" | "all";
export const METRICS_PERIODS: MetricsPeriod[] = ["week", "month", "all"];
const PERIOD_LABEL: Record<MetricsPeriod, string> = { week: "this week", month: "this month", all: "all time" };
const MINUTES_PER_DAY = 24 * 60;

/* ---------------------------------- types ---------------------------------- */
/** Seroval-safe per-driver metric row (explicit nulls, no undefined props). */
export type DriverMetricsRow = {
  userId: string;
  name: string;
  towbookDriverId: string;
  status: "online" | "offline";
  jobsCompleted: number;
  completionRatePct: number | null;
  avgAcceptMinutes: number | null;
  avgEnRouteMinutes: number | null;
  onTimePct: number | null;
  lateJobsPct: number | null;
  photosPct: number | null;
  avgCustomerRating: number | null;
  ratingCount: number;
  tipsCents: number;
  tipRatePct: number | null;
  acceptRatePct: number | null;
  declines: number;
  avgTimeToCompleteMinutes: number | null;
  onlineMinutes: number;
  onlineCoveragePct: number | null;
  gpsCoveragePct: number | null;
  payrateCents: number | null;
  earningsCents: number | null;
  compliance: { required: number; approved: number; onFile: number; ok: boolean } | null;
  /** Academy coach output for this driver (top recommendations). */
  academy: CoachRecommendation[];
};

export type CoachRecommendation = {
  lessonId: string;
  slug: string;
  title: string;
  summary: string;
  metricKey: string;
  why: string;
  deviation: number;
  status: "not_started" | "in_progress" | "completed";
  refresh: boolean;
};

export type OrgAggregate = {
  jobsCompleted: number; avgAcceptMinutes: number | null; onTimePct: number | null;
  avgCustomerRating: number | null; completionRatePct: number | null;
  tipsCents: number; photoCompliancePct: number | null; avgTimeToCompleteMinutes: number | null;
  drivers: number;
};
export type OrgMetricsResult =
  | { ok: true; period: MetricsPeriod; fleet: DriverMetricsRow[]; aggregate: OrgAggregate }
  | { ok: false; error: string };

export type MetricDetail = { value: number | null; target: number | null; unit: string; weak: boolean; why: string | null; trend: (number | null)[] };
export type SurveyRow = { rating: number; comment: string | null; jobLabel: string };
export type DriverDetailRow = {
  userId: string; name: string; towbookDriverId: string; status: "online" | "offline";
  compliance: { required: number; approved: number; onFile: number; ok: boolean } | null;
  stats: { jobsCompleted: number; earningsCents: number | null; tipsCents: number; avgRating: number | null; ratingCount: number; payrateCents: number | null };
  metrics: {
    acceptTime: MetricDetail; etaAccuracy: MetricDetail; photos: MetricDetail;
    completionRate: MetricDetail; customerRating: MetricDetail; tipRate: MetricDetail;
    acceptRate: MetricDetail; gpsCoverage: MetricDetail; availability: MetricDetail;
    avgTimeToComplete: MetricDetail;
  };
  photosCard: { pct12: number | null; preArrivalAvg: number | null; serviceAvg: number | null; finalAvg: number | null };
  surveys: { distribution: number[]; latest: SurveyRow[] };
  availabilityCard: { currentStatus: "online" | "offline"; lastPingAt: string | null; pings24h: number };
  aiDispatch: { autoAccepted: number; avgQuotedEtaMinutes: number | null; escalations: number };
  academy: CoachRecommendation[];
};
export type DriverMetricsDetailResult =
  | { ok: true; period: MetricsPeriod; driver: DriverDetailRow }
  | { ok: false; error: string };

export type AcademyRecommendationsResult =
  | { ok: true; driverName: string; onTrack: boolean; recommendations: CoachRecommendation[] }
  | { ok: false; error: string };

export type LessonProgressRow = {
  lessonId: string; slug: string; title: string; summary: string; metricKey: string;
  durationMinutes: number; sortOrder: number; status: "not_started" | "in_progress" | "completed";
  completedAt: string | null;
};
export type LessonProgressResult = { ok: true; lessons: LessonProgressRow[] } | { ok: false; error: string };
export type MarkLessonCompleteResult = { ok: true; status: "completed" } | { ok: false; error: string };

/* ------------------------------ period bounds ------------------------------ */
/** Week = Mon 00:00 local → Sun 23:59 (payday period rev 19); month = 1st of
 *  month 00:00 local → now; all = no bound. Local = the server's timezone. */
function periodBounds(period: MetricsPeriod, now: Date = new Date()): { start: number | null; end: number | null } {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (period === "week") {
    const dow = (d.getDay() + 6) % 7; // Monday = 0
    d.setDate(d.getDate() - dow);
    return { start: d.getTime(), end: now.getTime() };
  }
  if (period === "month") {
    d.setDate(1);
    return { start: d.getTime(), end: now.getTime() };
  }
  return { start: null, end: null };
}
function inPeriod(ts: number, bounds: { start: number | null; end: number | null }): boolean {
  if (bounds.start != null && ts < bounds.start) return false;
  if (bounds.end != null && ts >= bounds.end) return false;
  return true;
}
function daysInMonth(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
}
const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 100) : null);

/* ------------------------------ auth/roles ------------------------------ */
async function resolveOwner(): Promise<{ id: string; orgId: string; role: string } | null> {
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u || (u.role !== "owner" && u.role !== "admin")) return null;
  return { id: u.id, orgId: u.orgId, role: u.role };
}
async function resolveEffectiveDriver(): Promise<{ u: { id: string; orgId: string; role: string }; userRowId: string; towbookDriverId: string; name: string } | null> {
  const { currentUser, effectiveDriverIdentity } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return null;
  const identity = await effectiveDriverIdentity(u);
  if (!identity || identity.deactivated) return null;
  return { u: { id: u.id, orgId: u.orgId, role: u.role }, userRowId: identity.userRowId, towbookDriverId: identity.towbookDriverId, name: identity.driverName };
}
const configured = () => Boolean(process.env.DATABASE_URL);

/* ------------------------------ data fetch ------------------------------ */
type RosterRow = { id: string; name: string; towbookDriverId: string; payrateCents: number | null; online: boolean };
type JobRow = {
  id: string; towbookJobId: string | null; customerName: string; status: string;
  createdAt: number; completedAt: number | null; arrivedAt: number | null;
  assignedDriverTowbookId: string | null; assignedContractorId: string | null;
};
type EventRow = { jobId: string; fromStatus: string; toStatus: string; actorRole: string | null; note: string | null; occurredAt: number };
type PhotoAgg = { jobId: string; phase: string; n: number };
type DecisionRow = { callId: string | null; callRequestId: string | null; decision: string; escalated: boolean; driverId: string | null; driverName: string | null; etaMinutes: number | null; createdAt: number };
type CompletionRow = { jobId: string; rating: number | null; comment: string | null };
type TipRow = { jobId: string; driverId: string | null; driverTowbookId: string | null; amountCents: number };
type PingAgg = { jobId: string; driverId: string | null; n: number };
type AvailRow = { userId: string; day: string; onlineMinutes: number; pingCount: number; sessionStartedAt: number | null };
type DeclineRow = { jobId: string };
type ComplianceByDriver = Map<string, { required: number; approved: number; onFile: number }>;

type OrgData = {
  roster: RosterRow[];
  completedJobs: JobRow[];
  createdJobs: JobRow[];
  events: EventRow[];
  photos: PhotoAgg[];
  decisions: DecisionRow[];
  completions: CompletionRow[];
  tips: TipRow[];
  pings: PingAgg[];
  availability: AvailRow[];
  declines: DeclineRow[];
  compliance: ComplianceByDriver;
  lessons: { id: string; slug: string; title: string; summary: string; metricKey: string; sortOrder: number }[];
  progress: Map<string, "in_progress" | "completed">; // lessonId → status (for the org+driver scope)
  maxEtaMinutes: number;
  pings24hByDriver: Map<string, number>;
  lastPingAtByDriver: Map<string, string>;
};

const assignedTo = (j: JobRow, u: RosterRow): boolean =>
  (j.assignedDriverTowbookId != null && j.assignedDriverTowbookId === u.towbookDriverId) ||
  (j.assignedContractorId != null && j.assignedContractorId === u.id);

async function fetchOrgData(orgId: string, period: MetricsPeriod, driverUserId: string | null, now: Date = new Date()): Promise<OrgData> {
  const q = sql();
  const bounds = periodBounds(period, now);
  // Lookback: trend needs the last 4 weeks (Mon-aligned); the period row needs
  // periodStart. Fetch the smaller of the two (all → everything).
  const trendStart = new Date(now);
  trendStart.setHours(0, 0, 0, 0);
  const dow = (trendStart.getDay() + 6) % 7;
  trendStart.setDate(trendStart.getDate() - dow - 21); // 4 weeks ago Monday
  const boundMs = bounds.start == null ? null : Math.min(bounds.start, trendStart.getTime());

  const rosterRows = await q`SELECT u.id, u.name, u.towbook_driver_id,
      cp.payrate_cents,
      (SELECT COUNT(*)::int FROM sessions s WHERE s.user_id=u.id AND s.expires_at > NOW()) AS portal_sessions,
      (SELECT COUNT(*)::int FROM towbook_sessions ts WHERE ts.org_id=${orgId} AND ts.towbook_driver_id=u.towbook_driver_id) AS tb_sessions
    FROM users u
    LEFT JOIN contractor_profiles cp ON cp.org_id=${orgId} AND cp.user_id=u.id
    WHERE u.deactivated_at IS NULL AND u.towbook_driver_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM organization_memberships m WHERE m.user_id=u.id AND m.org_id=${orgId})
    ORDER BY LOWER(u.name), u.created_at`;
  const roster: RosterRow[] = (rosterRows as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    name: String(r.name ?? ""),
    towbookDriverId: String(r.towbook_driver_id),
    payrateCents: r.payrate_cents != null ? Number(r.payrate_cents) : null,
    online: Number(r.portal_sessions ?? 0) > 0 || Number(r.tb_sessions ?? 0) > 0,
  }));

  const completedRows = boundMs == null
    ? await q`SELECT id, towbook_job_id, customer_name, created_at, completed_at, arrived_at, assigned_driver_towbook_id, assigned_contractor_id FROM dispatch_jobs WHERE org_id=${orgId} AND status='completed' AND completed_at IS NOT NULL`
    : await q`SELECT id, towbook_job_id, customer_name, created_at, completed_at, arrived_at, assigned_driver_towbook_id, assigned_contractor_id FROM dispatch_jobs WHERE org_id=${orgId} AND status='completed' AND completed_at IS NOT NULL AND completed_at >= ${new Date(boundMs).toISOString()}`;
  const completedJobs: JobRow[] = (completedRows as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    towbookJobId: r.towbook_job_id != null ? String(r.towbook_job_id) : null,
    customerName: String(r.customer_name ?? ""),
    status: "completed",
    createdAt: new Date(String(r.created_at)).getTime(),
    completedAt: new Date(String(r.completed_at)).getTime(),
    arrivedAt: r.arrived_at != null ? new Date(String(r.arrived_at)).getTime() : null,
    assignedDriverTowbookId: r.assigned_driver_towbook_id != null ? String(r.assigned_driver_towbook_id) : null,
    assignedContractorId: r.assigned_contractor_id != null ? String(r.assigned_contractor_id) : null,
  }));

  const createdRows = boundMs == null
    ? await q`SELECT id, status, created_at, assigned_driver_towbook_id, assigned_contractor_id FROM dispatch_jobs WHERE org_id=${orgId} AND status <> 'cancelled'`
    : await q`SELECT id, status, created_at, assigned_driver_towbook_id, assigned_contractor_id FROM dispatch_jobs WHERE org_id=${orgId} AND status <> 'cancelled' AND created_at >= ${new Date(boundMs).toISOString()}`;
  const createdJobs: JobRow[] = (createdRows as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    towbookJobId: null,
    customerName: "",
    status: String(r.status),
    createdAt: new Date(String(r.created_at)).getTime(),
    completedAt: null,
    arrivedAt: null,
    assignedDriverTowbookId: r.assigned_driver_towbook_id != null ? String(r.assigned_driver_towbook_id) : null,
    assignedContractorId: r.assigned_contractor_id != null ? String(r.assigned_contractor_id) : null,
  }));

  const jobIdSet = new Set<string>([...completedJobs.map((j) => j.id), ...createdJobs.map((j) => j.id)]);
  const jobIds = [...jobIdSet];

  const eventRows = jobIds.length
    ? await q`SELECT job_id, from_status, to_status, actor_role, note, occurred_at FROM status_events WHERE org_id=${orgId} AND job_id = ANY(${jobIds}) ORDER BY job_id, occurred_at`
    : [];
  const events: EventRow[] = (eventRows as Record<string, unknown>[]).map((r) => ({
    jobId: String(r.job_id),
    fromStatus: String(r.from_status),
    toStatus: String(r.to_status),
    actorRole: r.actor_role != null ? String(r.actor_role) : null,
    note: r.note != null ? String(r.note) : null,
    occurredAt: new Date(String(r.occurred_at)).getTime(),
  }));

  const photoRows = jobIds.length
    ? await q`SELECT job_id, phase, COUNT(*)::int AS n FROM job_photos WHERE org_id=${orgId} AND job_id = ANY(${jobIds}) AND phase IN ('pre_arrival','service','final') GROUP BY job_id, phase`
    : [];
  const photos: PhotoAgg[] = (photoRows as Record<string, unknown>[]).map((r) => ({
    jobId: String(r.job_id), phase: String(r.phase), n: Number(r.n),
  }));

  const decisionRows = await q`SELECT call_id, call_request_id, decision, escalated, driver_id, driver_name, eta_minutes, created_at FROM ai_dispatcher_decisions WHERE org_id=${orgId}`;
  const decisions: DecisionRow[] = (decisionRows as Record<string, unknown>[]).map((r) => ({
    callId: r.call_id != null ? String(r.call_id) : null,
    callRequestId: r.call_request_id != null ? String(r.call_request_id) : null,
    decision: String(r.decision),
    escalated: Boolean(r.escalated),
    driverId: r.driver_id != null ? String(r.driver_id) : null,
    driverName: r.driver_name != null ? String(r.driver_name) : null,
    etaMinutes: r.eta_minutes != null ? Number(r.eta_minutes) : null,
    createdAt: new Date(String(r.created_at)).getTime(),
  }));

  const completionRows = jobIds.length
    ? await q`SELECT job_id, survey FROM job_completions WHERE org_id=${orgId} AND job_id = ANY(${jobIds}) AND survey IS NOT NULL`
    : [];
  const completions: CompletionRow[] = [];
  for (const r of completionRows as Record<string, unknown>[]) {
    const s = r.survey as Record<string, unknown> | null;
    if (!s || typeof s !== "object") continue;
    const rating = Number(s.rating);
    completions.push({
      jobId: String(r.job_id),
      rating: Number.isFinite(rating) ? rating : null,
      comment: typeof s.comment === "string" ? s.comment : null,
    });
  }

  const tipRows = jobIds.length
    ? await q`SELECT job_id, driver_id, driver_towbook_id, amount_cents FROM completion_tips WHERE org_id=${orgId} AND status='paid' AND job_id = ANY(${jobIds})`
    : [];
  const tips: TipRow[] = (tipRows as Record<string, unknown>[]).map((r) => ({
    jobId: String(r.job_id),
    driverId: r.driver_id != null ? String(r.driver_id) : null,
    driverTowbookId: r.driver_towbook_id != null ? String(r.driver_towbook_id) : null,
    amountCents: Number(r.amount_cents ?? 0),
  }));

  const pingRows = jobIds.length
    ? await q`SELECT job_id, driver_id, COUNT(*)::int AS n FROM driver_locations WHERE org_id=${orgId} AND job_id IS NOT NULL AND job_id = ANY(${jobIds}) GROUP BY job_id, driver_id`
    : [];
  const pings: PingAgg[] = (pingRows as Record<string, unknown>[]).map((r) => ({
    jobId: String(r.job_id), driverId: r.driver_id != null ? String(r.driver_id) : null, n: Number(r.n),
  }));

  const availRows = await q`SELECT user_id, day, online_minutes, ping_count, session_started_at FROM driver_availability_log WHERE org_id=${orgId}`;
  const availability: AvailRow[] = (availRows as Record<string, unknown>[]).map((r) => ({
    userId: String(r.user_id),
    day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10),
    onlineMinutes: Number(r.online_minutes ?? 0),
    pingCount: Number(r.ping_count ?? 0),
    sessionStartedAt: r.session_started_at != null ? new Date(String(r.session_started_at)).getTime() : null,
  }));

  const declineRows = await q`SELECT job_id FROM driver_issues WHERE org_id=${orgId} AND kind='decline'`;
  const declines: DeclineRow[] = (declineRows as Record<string, unknown>[]).map((r) => ({ jobId: String(r.job_id) }));

  // Compliance — same read-time derivation as getMyComplianceCore (part 3
  // facial-verification pairs count only when the live selfie is on file).
  const compliance = new Map<string, { required: number; approved: number; onFile: number }>();
  const compRows = await q`SELECT t.id AS doc_type_id, t.name AS doc_type_name, t.requires_facial_verification,
      d.contractor_id, d.status AS stored_status, d.expires_on, (s.id IS NOT NULL) AS has_selfie
    FROM contractor_doc_types t
    LEFT JOIN contractor_documents d ON d.org_id=${orgId} AND d.doc_type_id=t.id
    LEFT JOIN contractor_doc_selfies s ON s.org_id=${orgId} AND s.contractor_id=d.contractor_id AND s.doc_type_id=t.id
    WHERE t.org_id=${orgId} AND t.active=TRUE`;
  for (const r of compRows as Record<string, unknown>[]) {
    const cid = r.contractor_id != null ? String(r.contractor_id) : null;
    if (!cid) continue;
    let c = compliance.get(cid);
    if (!c) { c = { required: 0, approved: 0, onFile: 0 }; compliance.set(cid, c); }
    c.required += 1;
    const pairComplete = r.requires_facial_verification !== true || r.has_selfie === true;
    const stored = r.stored_status != null ? String(r.stored_status) : null;
    const expiresOn = r.expires_on instanceof Date ? r.expires_on.toISOString().slice(0, 10) : (r.expires_on != null ? String(r.expires_on).slice(0, 10) : null);
    const status: DocStatus = stored ? deriveDocStatus(stored, expiresOn) : "missing";
    if (status === "verified" && pairComplete) { c.approved += 1; c.onFile += 1; continue; }
    if ((status === "uploaded" || status === "verified") && pairComplete) c.onFile += 1;
  }

  const lessonRows = await q`SELECT id, slug, title, summary, metric_key, sort_order FROM academy_lessons WHERE active=TRUE ORDER BY sort_order`;
  const lessons = (lessonRows as Record<string, unknown>[]).map((r) => ({
    id: String(r.id), slug: String(r.slug), title: String(r.title), summary: String(r.summary),
    metricKey: String(r.metric_key), sortOrder: Number(r.sort_order),
  }));

  const progress = new Map<string, "in_progress" | "completed">();
  if (driverUserId) {
    const progRows = await q`SELECT lesson_id, status FROM academy_progress WHERE org_id=${orgId} AND user_id=${driverUserId}`;
    for (const r of progRows as Record<string, unknown>[]) progress.set(String(r.lesson_id), String(r.status) === "completed" ? "completed" : "in_progress");
  }

  const settingsRows = await q`SELECT max_eta_minutes FROM org_settings WHERE org_id=${orgId}`;
  const maxEtaMinutes = settingsRows.length ? Number(settingsRows[0].max_eta_minutes) || 45 : 45;

  // Availability card extras: pings in the last 24h + last ping per driver.
  const pingRows24 = await q`SELECT driver_id, COUNT(*)::int AS n, MAX(captured_at) AS last_ping FROM driver_locations WHERE org_id=${orgId} AND captured_at >= NOW() - INTERVAL '24 hours' GROUP BY driver_id`;
  const pings24hByDriver = new Map<string, number>();
  const lastPingAtByDriver = new Map<string, string>();
  for (const r of pingRows24 as Record<string, unknown>[]) {
    const did = String(r.driver_id);
    pings24hByDriver.set(did, Number(r.n ?? 0));
    if (r.last_ping != null) lastPingAtByDriver.set(did, new Date(String(r.last_ping)).toISOString());
  }

  return { roster, completedJobs, createdJobs, events, photos, decisions, completions, tips, pings, availability, declines, compliance, lessons, progress, maxEtaMinutes, pings24hByDriver, lastPingAtByDriver };
}

/* ------------------------------ per-job enrichment ------------------------------ */
type JobMetric = {
  jobId: string;
  towbookJobId: string | null;
  customerName: string;
  createdAt: number;
  completedAt: number;
  arrivedAt: number | null;
  acceptMs: number | null;
  acceptAnchorMs: number | null;
  enRouteMs: number | null;
  firstEventAt: number | null;
  completedEventAt: number | null;
  quotedEtaMinutes: number | null;
  decisionCreatedAt: number | null;
  arrivalMinutes: number | null;
  targetMinutes: number | null;
  lateBy: number | null;
  photos: { pre_arrival: number; service: number; final: number };
  photosComplete12: boolean;
  surveyRating: number | null;
  surveyComment: string | null;
  tipCents: number;
};

const JOB_PHASES = ["pre_arrival", "service", "final"] as const;

function enrichJobs(completed: JobRow[], data: OrgData, u: RosterRow): Map<string, JobMetric> {
  const out = new Map<string, JobMetric>();
  const eventsByJob = new Map<string, EventRow[]>();
  for (const e of data.events) {
    const list = eventsByJob.get(e.jobId) ?? [];
    list.push(e);
    eventsByJob.set(e.jobId, list);
  }
  const photosByJob = new Map<string, { pre_arrival: number; service: number; final: number }>();
  for (const p of data.photos) {
    const m = photosByJob.get(p.jobId) ?? { pre_arrival: 0, service: 0, final: 0 };
    if (p.phase === "pre_arrival" || p.phase === "service" || p.phase === "final") m[p.phase] = p.n;
    photosByJob.set(p.jobId, m);
  }
  const decisionsByCall = new Map<string, DecisionRow>();
  for (const d of data.decisions) {
    if (d.callId) decisionsByCall.set(d.callId, d);
    if (d.callRequestId && !decisionsByCall.has(d.callRequestId)) decisionsByCall.set(d.callRequestId, d);
  }
  const tipsByJob = new Map<string, number>();
  for (const t of data.tips) {
    if (t.driverId === u.id || (t.driverTowbookId != null && t.driverTowbookId === u.towbookDriverId)) {
      tipsByJob.set(t.jobId, (tipsByJob.get(t.jobId) ?? 0) + t.amountCents);
    }
  }
  const completionByJob = new Map<string, CompletionRow>();
  for (const c of data.completions) completionByJob.set(c.jobId, c);

  for (const j of completed) {
    if (!assignedTo(j, u)) continue;
    const evs = eventsByJob.get(j.id) ?? [];
    const accept = evs.find((e) => e.toStatus === "accepted" && (e.actorRole === "contractor" || (e.note ?? "").includes("owner in driver view")));
    const offered = accept ? [...evs.filter((e) => e.toStatus === "offered" && e.occurredAt <= accept.occurredAt)].pop() : undefined;
    const decision = j.towbookJobId != null ? decisionsByCall.get(j.towbookJobId) ?? null : null;
    let acceptMs: number | null = null;
    let acceptAnchorMs: number | null = null;
    if (accept) {
      acceptAnchorMs = accept.occurredAt;
      acceptMs = Math.max(0, accept.occurredAt - (offered?.occurredAt ?? j.createdAt));
    } else if (decision) {
      acceptAnchorMs = decision.createdAt;
      acceptMs = Math.max(0, decision.createdAt - j.createdAt);
    }
    const enRoute = evs.find((e) => e.toStatus === "en_route");
    let enRouteMs: number | null = null;
    if (enRoute && acceptAnchorMs != null) enRouteMs = Math.max(0, enRoute.occurredAt - acceptAnchorMs);
    const completedEvt = evs.find((e) => e.toStatus === "completed");
    const firstEvent = evs.length ? evs.reduce((a, b) => (a.occurredAt < b.occurredAt ? a : b)) : null;
    const photosMap = photosByJob.get(j.id) ?? { pre_arrival: 0, service: 0, final: 0 };
    const photosComplete12 = JOB_PHASES.every((p) => photosMap[p] >= 4);
    const arrivalAnchor = decision?.createdAt ?? j.createdAt;
    const arrivalTs = j.arrivedAt ?? j.completedAt;
    const arrivalMinutes = arrivalTs != null ? Math.max(0, (arrivalTs - arrivalAnchor) / 60000) : null;
    const targetMinutes = decision?.etaMinutes != null ? decision.etaMinutes : data.maxEtaMinutes;
    const lateBy = arrivalMinutes != null ? Math.max(0, arrivalMinutes - targetMinutes) : null;
    const comp = completionByJob.get(j.id);
    out.set(j.id, {
      jobId: j.id,
      towbookJobId: j.towbookJobId,
      customerName: j.customerName,
      createdAt: j.createdAt,
      completedAt: j.completedAt ?? j.createdAt,
      arrivedAt: j.arrivedAt,
      acceptMs, acceptAnchorMs, enRouteMs,
      firstEventAt: firstEvent?.occurredAt ?? null,
      completedEventAt: completedEvt?.occurredAt ?? null,
      quotedEtaMinutes: decision?.etaMinutes ?? null,
      decisionCreatedAt: decision?.createdAt ?? null,
      arrivalMinutes, targetMinutes, lateBy,
      photos: photosMap,
      photosComplete12,
      surveyRating: comp?.rating ?? null,
      surveyComment: comp?.comment ?? null,
      tipCents: tipsByJob.get(j.id) ?? 0,
    });
  }
  return out;
}

function avgMinutes(msList: (number | null)[]): number | null {
  const nums = msList.filter((v): v is number => v != null);
  if (!nums.length) return null;
  return round1(nums.reduce((a, b) => a + b, 0) / nums.length / 60000);
}
function avgOf(nums: (number | null)[]): number | null {
  const vals = nums.filter((v): v is number => v != null && Number.isFinite(v));
  if (!vals.length) return null;
  return round1(vals.reduce((a, b) => a + b, 0) / vals.length);
}

/* ------------------------------ availability ------------------------------ */
/** Effective online minutes for a driver over the period: banked minutes plus
 *  the currently-open stretch (attributed to its start day). */
function effectiveOnlineMinutes(driverUserId: string, rows: AvailRow[], bounds: { start: number | null; end: number | null }, now: number): { minutes: number; minDay: string | null; maxDay: string | null } {
  let minutes = 0;
  let minDay: string | null = null;
  let maxDay: string | null = null;
  for (const r of rows) {
    if (r.userId !== driverUserId) continue;
    const dayMs = new Date(`${r.day}T00:00:00`).getTime();
    if (!inPeriod(dayMs, bounds)) continue;
    if (minDay == null || r.day < minDay) minDay = r.day;
    if (maxDay == null || r.day > maxDay) maxDay = r.day;
    minutes += r.onlineMinutes;
    if (r.sessionStartedAt != null) {
      const started = new Date(r.sessionStartedAt);
      const startedDay = started.toISOString().slice(0, 10);
      if (startedDay === r.day) minutes += Math.max(0, Math.floor((now - r.sessionStartedAt) / 60000));
    }
  }
  return { minutes, minDay, maxDay };
}
function coveragePct(minutes: number, period: MetricsPeriod, minDay: string | null, maxDay: string | null, now: Date): number | null {
  let total: number;
  if (period === "week") total = 7 * MINUTES_PER_DAY;
  else if (period === "month") total = daysInMonth(now) * MINUTES_PER_DAY;
  else {
    if (minDay == null || maxDay == null) return null;
    const d0 = new Date(`${minDay}T00:00:00`).getTime();
    const d1 = new Date(`${maxDay}T00:00:00`).getTime();
    total = (Math.round((d1 - d0) / 86400000) + 1) * MINUTES_PER_DAY;
  }
  return total > 0 ? Math.round((minutes / total) * 100) : null;
}

/* ------------------------------ the coach (deterministic §4) ------------------------------ */
function coachRecommendations(
  m: { avgAcceptMinutes: number | null; avgEnRouteMinutes: number | null; lateJobsPct: number | null; photosPct: number | null; avgCustomerRating: number | null; tipRatePct: number | null; acceptRatePct: number | null; declines: number; gpsCoveragePct: number | null; onlineCoveragePct: number | null; completionRatePct: number | null; complianceOk: boolean; complianceNeeded: number },
  period: MetricsPeriod,
  lessons: OrgData["lessons"],
  progress: Map<string, "in_progress" | "completed">,
): CoachRecommendation[] {
  const weak: { metricKey: string; why: string; deviation: number }[] = [];
  const label = PERIOD_LABEL[period];
  if (m.avgAcceptMinutes != null && m.avgAcceptMinutes > 5) {
    weak.push({ metricKey: "accept_time", why: `your average accept time is ${m.avgAcceptMinutes} min — goal is under 5`, deviation: m.avgAcceptMinutes - 5 });
  } else if (m.avgEnRouteMinutes != null && m.avgEnRouteMinutes > 8) {
    weak.push({ metricKey: "accept_time", why: `you take ${m.avgEnRouteMinutes} min to get rolling after accepting — goal is under 8`, deviation: m.avgEnRouteMinutes - 8 });
  }
  if (m.lateJobsPct != null && m.lateJobsPct > 20) {
    weak.push({ metricKey: "eta_accuracy", why: `${m.lateJobsPct}% of jobs arrived 10+ min past the quoted ETA — goal is under 20%`, deviation: m.lateJobsPct - 20 });
  }
  if (m.photosPct != null && m.photosPct < 100) {
    weak.push({ metricKey: "photos_compliance", why: `${m.photosPct}% of completed jobs had all 12 photos — goal is 100%`, deviation: 100 - m.photosPct });
  }
  if (m.avgCustomerRating != null && m.avgCustomerRating < 4.5) {
    weak.push({ metricKey: "customer_rating", why: `your average rating is ${m.avgCustomerRating} — goal is 4.5+`, deviation: 4.5 - m.avgCustomerRating });
  }
  if (m.tipRatePct != null && m.tipRatePct < 25) {
    weak.push({ metricKey: "tips", why: `${m.tipRatePct}% of jobs earned a tip — goal is 25%+`, deviation: 25 - m.tipRatePct });
  }
  if (m.acceptRatePct != null && m.acceptRatePct < 80) {
    weak.push({ metricKey: "accept_rate", why: `you accepted ${m.acceptRatePct}% of offers — goal is 80%+`, deviation: 80 - m.acceptRatePct });
  } else if (m.declines >= 2) {
    weak.push({ metricKey: "accept_rate", why: `you declined ${m.declines} offers ${label}`, deviation: 10 });
  }
  if (m.gpsCoveragePct != null && m.gpsCoveragePct < 80) {
    weak.push({ metricKey: "gps_coverage", why: `${m.gpsCoveragePct}% of jobs had location updates while working — goal is 80%+`, deviation: 80 - m.gpsCoveragePct });
  }
  if (m.onlineCoveragePct != null && m.onlineCoveragePct < 60) {
    weak.push({ metricKey: "availability", why: `you were online ${m.onlineCoveragePct}% of ${label} — goal is 60%+`, deviation: 60 - m.onlineCoveragePct });
  }
  if (m.completionRatePct != null && m.completionRatePct < 90) {
    weak.push({ metricKey: "completion_rate", why: `you completed ${m.completionRatePct}% of assigned jobs — goal is 90%+`, deviation: 90 - m.completionRatePct });
  }
  if (!m.complianceOk) {
    weak.push({ metricKey: "documents", why: `${m.complianceNeeded} required document${m.complianceNeeded === 1 ? "" : "s"} missing or not approved`, deviation: 100 });
  }
  weak.sort((a, b) => b.deviation - a.deviation);
  const top = weak.slice(0, 2);
  return top.map((w) => {
    const lesson = lessons.find((l) => l.metricKey === w.metricKey);
    const status = progress.get(lesson?.id ?? "") ?? "not_started";
    return {
      lessonId: lesson?.id ?? w.metricKey,
      slug: lesson?.slug ?? w.metricKey,
      title: lesson?.title ?? "Academy lesson",
      summary: lesson?.summary ?? "",
      metricKey: w.metricKey,
      why: w.why,
      deviation: round1(w.deviation),
      status: status as "not_started" | "in_progress" | "completed",
      refresh: status === "completed",
    };
  });
}

/* ------------------------------ driver row ------------------------------ */
type DriverComputed = {
  jobsCompleted: number;
  completionRatePct: number | null;
  avgAcceptMinutes: number | null;
  avgEnRouteMinutes: number | null;
  onTimePct: number | null;
  lateJobsPct: number | null;
  photosPct: number | null;
  avgCustomerRating: number | null;
  ratingCount: number;
  tipsCents: number;
  tipRatePct: number | null;
  acceptRatePct: number | null;
  declines: number;
  avgTimeToCompleteMinutes: number | null;
  onlineMinutes: number;
  onlineCoveragePct: number | null;
  gpsCoveragePct: number | null;
  earningsCents: number | null;
  surveys: { distribution: number[]; latest: SurveyRow[] };
  photosCard: { pct12: number | null; preArrivalAvg: number | null; serviceAvg: number | null; finalAvg: number | null };
  aiDispatch: { autoAccepted: number; avgQuotedEtaMinutes: number | null; escalations: number };
};

function computeDriver(
  u: RosterRow,
  period: MetricsPeriod,
  bounds: { start: number | null; end: number | null },
  data: OrgData,
  now: Date,
): DriverComputed {
  const metrics = enrichJobs(data.completedJobs, data, u);
  const periodJobs = [...metrics.values()].filter((j) => inPeriod(j.completedAt, bounds));
  const jobsCompleted = periodJobs.length;

  // Completion rate: non-cancelled assigned jobs CREATED in the period.
  const createdInPeriod = data.createdJobs.filter((j) => assignedTo(j, u) && inPeriod(j.createdAt, bounds));
  const completedAmongCreated = createdInPeriod.filter((j) => j.status === "completed").length;
  const completionRatePct = pct(completedAmongCreated, createdInPeriod.length);

  // Accept rate: created-in-period jobs that were accepted vs accepted+declined.
  const declines = data.declines.filter((d) => createdInPeriod.some((j) => j.id === d.jobId)).length;
  const acceptedJobs = new Set(data.events.filter((e) => e.toStatus === "accepted" && (e.actorRole === "contractor" || (e.note ?? "").includes("owner in driver view"))).map((e) => e.jobId));
  const acceptedCreated = createdInPeriod.filter((j) => acceptedJobs.has(j.id)).length;
  const totalDecisions = acceptedCreated + declines;
  const acceptRatePct = totalDecisions > 0 ? Math.round((acceptedCreated / totalDecisions) * 100) : null;

  const acceptTimes = periodJobs.map((j) => j.acceptMs);
  const enRouteTimes = periodJobs.map((j) => j.enRouteMs);
  const measured = periodJobs.filter((j) => j.arrivalMinutes != null);
  const onTime = measured.filter((j) => j.arrivalMinutes != null && j.targetMinutes != null && j.arrivalMinutes <= j.targetMinutes).length;
  const late10 = measured.filter((j) => j.lateBy != null && j.lateBy >= 10).length;
  const photos12 = periodJobs.filter((j) => j.photosComplete12).length;
  const ratings = periodJobs.map((j) => j.surveyRating);
  const ratingCount = ratings.filter((v) => v != null).length;
  const tipCount = periodJobs.filter((j) => j.tipCents > 0).length;
  const tipsCents = periodJobs.reduce((s, j) => s + j.tipCents, 0);
  const timeToComplete: number[] = [];
  for (const j of periodJobs) {
    if (j.completedEventAt != null && j.firstEventAt != null) timeToComplete.push(j.completedEventAt - j.firstEventAt);
    else timeToComplete.push(j.completedAt - j.createdAt);
  }

  // GPS coverage: created-in-period assigned jobs with ≥1 ping from this driver.
  const pingsByJob = new Map<string, number>();
  for (const p of data.pings) if (p.driverId === u.id) pingsByJob.set(p.jobId, (pingsByJob.get(p.jobId) ?? 0) + p.n);
  const pingedJobs = createdInPeriod.filter((j) => (pingsByJob.get(j.id) ?? 0) > 0).length;
  const gpsCoveragePct = pct(pingedJobs, createdInPeriod.length);

  const avail = effectiveOnlineMinutes(u.id, data.availability, bounds, now.getTime());
  const onlineCoveragePct = coveragePct(avail.minutes, period, avail.minDay, avail.maxDay, now);

  const photosAgg = { pre_arrival: 0, service: 0, final: 0 };
  for (const j of periodJobs) {
    photosAgg.pre_arrival += j.photos.pre_arrival;
    photosAgg.service += j.photos.service;
    photosAgg.final += j.photos.final;
  }

  // Survey distribution + latest comments.
  const distribution = [0, 0, 0, 0, 0];
  const sorted = [...periodJobs].filter((j) => j.surveyRating != null).sort((a, b) => b.completedAt - a.completedAt);
  for (const j of sorted) {
    const r = Math.min(5, Math.max(1, Math.round(j.surveyRating as number)));
    distribution[r - 1] += 1;
  }
  const latest = sorted.slice(0, 3).map((j) => ({
    rating: j.surveyRating as number,
    comment: j.surveyComment,
    jobLabel: j.towbookJobId != null ? `Call #${j.towbookJobId}` : j.customerName || "Job",
  }));

  // AI dispatch card: decisions tied to this driver (auto-accept row where the
  // chosen driver is u.id) for jobs completed in the period.
  const decisionRows = data.decisions.filter((d) => d.driverId === u.id || (d.driverName != null && d.driverName === u.name));
  const autoAccepted = decisionRows.filter((d) => d.decision.startsWith("auto_accept")).length;
  const escalations = decisionRows.filter((d) => d.escalated).length;
  const quotedEtas = decisionRows.filter((d) => d.etaMinutes != null && d.decision.startsWith("auto_accept"));
  const avgQuotedEtaMinutes = quotedEtas.length ? round1(quotedEtas.reduce((s, d) => s + (d.etaMinutes as number), 0) / quotedEtas.length) : null;

  const payrate = u.payrateCents;
  const earningsCents = payrate != null && payrate > 0 ? payrate * jobsCompleted + tipsCents : (payrate != null ? payrate * jobsCompleted + tipsCents : null);

  return {
    jobsCompleted,
    completionRatePct,
    avgAcceptMinutes: avgMinutes(acceptTimes),
    avgEnRouteMinutes: avgMinutes(enRouteTimes),
    onTimePct: pct(onTime, measured.length),
    lateJobsPct: pct(late10, measured.length),
    photosPct: pct(photos12, periodJobs.length),
    avgCustomerRating: avgOf(ratings),
    ratingCount,
    tipsCents,
    tipRatePct: pct(tipCount, periodJobs.length),
    acceptRatePct,
    declines,
    avgTimeToCompleteMinutes: timeToComplete.length ? round1(timeToComplete.reduce((a, b) => a + b, 0) / timeToComplete.length / 60000) : null,
    onlineMinutes: avail.minutes,
    onlineCoveragePct,
    gpsCoveragePct,
    earningsCents,
    surveys: { distribution, latest },
    photosCard: {
      pct12: pct(photos12, periodJobs.length),
      preArrivalAvg: periodJobs.length ? round1(photosAgg.pre_arrival / periodJobs.length) : null,
      serviceAvg: periodJobs.length ? round1(photosAgg.service / periodJobs.length) : null,
      finalAvg: periodJobs.length ? round1(photosAgg.final / periodJobs.length) : null,
    },
    aiDispatch: { autoAccepted, avgQuotedEtaMinutes, escalations },
  };
}

function complianceFor(u: RosterRow, data: OrgData): { required: number; approved: number; onFile: number; ok: boolean } | null {
  const c = data.compliance.get(u.id);
  if (!c) return null;
  return { ...c, ok: c.required > 0 ? c.approved >= c.required : true };
}

function toRow(u: RosterRow, c: DriverComputed, period: MetricsPeriod, data: OrgData): DriverMetricsRow {
  const compliance = complianceFor(u, data);
  return {
    userId: u.id,
    name: u.name,
    towbookDriverId: u.towbookDriverId,
    status: u.online ? "online" : "offline",
    jobsCompleted: c.jobsCompleted,
    completionRatePct: c.completionRatePct,
    avgAcceptMinutes: c.avgAcceptMinutes,
    avgEnRouteMinutes: c.avgEnRouteMinutes,
    onTimePct: c.onTimePct,
    lateJobsPct: c.lateJobsPct,
    photosPct: c.photosPct,
    avgCustomerRating: c.avgCustomerRating,
    ratingCount: c.ratingCount,
    tipsCents: c.tipsCents,
    tipRatePct: c.tipRatePct,
    acceptRatePct: c.acceptRatePct,
    declines: c.declines,
    avgTimeToCompleteMinutes: c.avgTimeToCompleteMinutes,
    onlineMinutes: c.onlineMinutes,
    onlineCoveragePct: c.onlineCoveragePct,
    gpsCoveragePct: c.gpsCoveragePct,
    payrateCents: u.payrateCents,
    earningsCents: c.earningsCents,
    compliance,
    academy: coachRecommendations(
      {
        avgAcceptMinutes: c.avgAcceptMinutes, avgEnRouteMinutes: c.avgEnRouteMinutes, lateJobsPct: c.lateJobsPct,
        photosPct: c.photosPct, avgCustomerRating: c.avgCustomerRating, tipRatePct: c.tipRatePct,
        acceptRatePct: c.acceptRatePct, declines: c.declines, gpsCoveragePct: c.gpsCoveragePct,
        onlineCoveragePct: c.onlineCoveragePct, completionRatePct: c.completionRatePct,
        complianceOk: compliance ? compliance.ok : true, complianceNeeded: compliance ? compliance.required - compliance.approved : 0,
      },
      period, data.lessons, data.progress,
    ),
  };
}

/* ------------------------------ aggregate (owner) ------------------------------ */
function computeOrgAggregate(bounds: { start: number | null; end: number | null }, data: OrgData): OrgAggregate {
  // Org-level completion rate needs a roster-wide denominator: every eligible
  // created job in the period (any driver), completed subset counted by status.
  const createdInPeriod = data.createdJobs.filter((j) => inPeriod(j.createdAt, bounds));
  const completedCreated = createdInPeriod.filter((j) => j.status === "completed").length;
  const completionRatePct = pct(completedCreated, createdInPeriod.length);

  const periodCompleted = data.completedJobs.filter((j) => inPeriod(j.completedAt, bounds));
  const acceptTimes: number[] = [];
  const measured: { arrivalMinutes: number; targetMinutes: number }[] = [];
  let ratingSum = 0, ratingN = 0;
  let tips = 0;
  let photos12 = 0;
  const timeToComplete: number[] = [];
  const eventsByJob = new Map<string, EventRow[]>();
  for (const e of data.events) {
    const list = eventsByJob.get(e.jobId) ?? [];
    list.push(e);
    eventsByJob.set(e.jobId, list);
  }
  const photosByJob = new Map<string, { pre_arrival: number; service: number; final: number }>();
  for (const p of data.photos) {
    const m = photosByJob.get(p.jobId) ?? { pre_arrival: 0, service: 0, final: 0 };
    if (p.phase === "pre_arrival" || p.phase === "service" || p.phase === "final") m[p.phase] = p.n;
    photosByJob.set(p.jobId, m);
  }
  const tipsByJob = new Map<string, number>();
  for (const t of data.tips) tipsByJob.set(t.jobId, (tipsByJob.get(t.jobId) ?? 0) + t.amountCents);
  const completionByJob = new Map<string, CompletionRow>();
  for (const c of data.completions) completionByJob.set(c.jobId, c);
  const decisionsByCall = new Map<string, DecisionRow>();
  for (const d of data.decisions) {
    if (d.callId) decisionsByCall.set(d.callId, d);
    if (d.callRequestId && !decisionsByCall.has(d.callRequestId)) decisionsByCall.set(d.callRequestId, d);
  }

  for (const j of periodCompleted) {
    const evs = eventsByJob.get(j.id) ?? [];
    const accept = evs.find((e) => e.toStatus === "accepted");
    const offered = accept ? [...evs.filter((e) => e.toStatus === "offered" && e.occurredAt <= accept.occurredAt)].pop() : undefined;
    const decision = j.towbookJobId != null ? decisionsByCall.get(j.towbookJobId) ?? null : null;
    if (accept) acceptTimes.push(accept.occurredAt - (offered?.occurredAt ?? j.createdAt));
    else if (decision) acceptTimes.push(decision.createdAt - j.createdAt);
    const arrivalAnchor = decision?.createdAt ?? j.createdAt;
    const arrivalTs = j.arrivedAt ?? j.completedAt;
    const arrivalMinutes = arrivalTs != null ? Math.max(0, (arrivalTs - arrivalAnchor) / 60000) : null;
    const targetMinutes = decision?.etaMinutes != null ? decision.etaMinutes : data.maxEtaMinutes;
    if (arrivalMinutes != null) measured.push({ arrivalMinutes, targetMinutes });
    const comp = completionByJob.get(j.id);
    if (comp?.rating != null) { ratingSum += comp.rating; ratingN += 1; }
    tips += tipsByJob.get(j.id) ?? 0;
    const pm = photosByJob.get(j.id) ?? { pre_arrival: 0, service: 0, final: 0 };
    if (JOB_PHASES.every((p) => pm[p] >= 4)) photos12 += 1;
    const done = evs.find((e) => e.toStatus === "completed");
    const first = evs.length ? evs.reduce((a, b) => (a.occurredAt < b.occurredAt ? a : b)) : null;
    if (done && first) timeToComplete.push(done.occurredAt - first.occurredAt);
    else timeToComplete.push(j.completedAt - j.createdAt);
  }

  const onTime = measured.filter((m) => m.arrivalMinutes <= m.targetMinutes).length;
  return {
    jobsCompleted: periodCompleted.length,
    avgAcceptMinutes: acceptTimes.length ? round1(acceptTimes.reduce((a, b) => a + b, 0) / acceptTimes.length / 60000) : null,
    onTimePct: pct(onTime, measured.length),
    avgCustomerRating: ratingN ? round1(ratingSum / ratingN) : null,
    completionRatePct,
    tipsCents: tips,
    photoCompliancePct: pct(photos12, periodCompleted.length),
    avgTimeToCompleteMinutes: timeToComplete.length ? round1(timeToComplete.reduce((a, b) => a + b, 0) / timeToComplete.length / 60000) : null,
    drivers: data.roster.length,
  };
}

/* ------------------------------ 4-week trend ------------------------------ */
function weeklyWindows(now: Date): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const anchor = new Date(now);
  anchor.setHours(0, 0, 0, 0);
  const dow = (anchor.getDay() + 6) % 7;
  anchor.setDate(anchor.getDate() - dow); // this Monday 00:00
  for (let i = 3; i >= 0; i--) {
    const start = new Date(anchor);
    start.setDate(start.getDate() - i * 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    out.push({ start: start.getTime(), end: end.getTime() });
  }
  return out;
}

function computeTrend(u: RosterRow, data: OrgData, now: Date): {
  jobsCompleted: (number | null)[]; acceptTime: (number | null)[]; onTime: (number | null)[];
  photos: (number | null)[]; rating: (number | null)[]; tipRate: (number | null)[];
  completionRate: (number | null)[]; coverage: (number | null)[];
} {
  const windows = weeklyWindows(now);
  const jobs = [...enrichJobs(data.completedJobs, data, u).values()];
  const out = { jobsCompleted: [], acceptTime: [], onTime: [], photos: [], rating: [], tipRate: [], completionRate: [], coverage: [] } as unknown as {
    jobsCompleted: (number | null)[]; acceptTime: (number | null)[]; onTime: (number | null)[]; photos: (number | null)[]; rating: (number | null)[]; tipRate: (number | null)[]; completionRate: (number | null)[]; coverage: (number | null)[];
  };
  for (const w of windows) {
    const wkJobs = jobs.filter((j) => j.completedAt >= w.start && j.completedAt < w.end);
    const measured = wkJobs.filter((j) => j.arrivalMinutes != null);
    const onTimeN = measured.filter((j) => j.arrivalMinutes != null && j.targetMinutes != null && j.arrivalMinutes <= j.targetMinutes).length;
    const ratings = wkJobs.map((j) => j.surveyRating).filter((v): v is number => v != null);
    const tipN = wkJobs.filter((j) => j.tipCents > 0).length;
    const created = data.createdJobs.filter((j) => assignedTo(j, u) && j.createdAt >= w.start && j.createdAt < w.end);
    const createdCompleted = created.filter((j) => j.status === "completed").length;
    const avail = effectiveOnlineMinutes(u.id, data.availability, { start: w.start, end: w.end }, now.getTime());
    out.jobsCompleted.push(wkJobs.length);
    out.acceptTime.push(avgMinutes(wkJobs.map((j) => j.acceptMs)));
    out.onTime.push(pct(onTimeN, measured.length));
    out.photos.push(pct(wkJobs.filter((j) => j.photosComplete12).length, wkJobs.length));
    out.rating.push(avgOf(ratings));
    out.tipRate.push(pct(tipN, wkJobs.length));
    out.completionRate.push(pct(createdCompleted, created.length));
    out.coverage.push(coveragePct(avail.minutes, "week", avail.minDay, avail.maxDay, now));
  }
  return out;
}

/* ------------------------------ handlers ------------------------------ */
export async function getOrgMetricsHandler(period: unknown): Promise<OrgMetricsResult> {
  if (!configured()) return { ok: false, error: "Metrics require database mode." };
  const owner = await resolveOwner();
  if (!owner) return { ok: false, error: "Owner access required." };
  const p = METRICS_PERIODS.includes(period as MetricsPeriod) ? (period as MetricsPeriod) : "week";
  try {
    const now = new Date();
    const data = await fetchOrgData(owner.orgId, p, null, now);
    const bounds = periodBounds(p, now);
    const fleet = data.roster.map((u) => toRow(u, computeDriver(u, p, bounds, data, now), p, data));
    const aggregate = computeOrgAggregate(bounds, data);
    return { ok: true, period: p, fleet, aggregate };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unable to load metrics." };
  }
}

function metricDetail(value: number | null, target: number | null, unit: string, weak: boolean, why: string | null, trend: (number | null)[]): MetricDetail {
  return { value, target, unit, weak, why, trend };
}

export async function getDriverMetricsHandler(driverUserId: unknown, period: unknown): Promise<DriverMetricsDetailResult> {
  if (!configured()) return { ok: false, error: "Metrics require database mode." };
  const owner = await resolveOwner();
  if (!owner) return { ok: false, error: "Owner access required." };
  if (typeof driverUserId !== "string" || !driverUserId.trim()) return { ok: false, error: "Choose a driver." };
  const p = METRICS_PERIODS.includes(period as MetricsPeriod) ? (period as MetricsPeriod) : "week";
  try {
    const now = new Date();
    const data = await fetchOrgData(owner.orgId, p, driverUserId, now);
    const u = data.roster.find((r) => r.id === driverUserId);
    if (!u) return { ok: false, error: "That driver isn't on this account." };
    const bounds = periodBounds(p, now);
    const c = computeDriver(u, p, bounds, data, now);
    const trend = computeTrend(u, data, now);
    const compliance = complianceFor(u, data);
    const row: DriverDetailRow = {
      userId: u.id,
      name: u.name,
      towbookDriverId: u.towbookDriverId,
      status: u.online ? "online" : "offline",
      compliance,
      stats: {
        jobsCompleted: c.jobsCompleted,
        earningsCents: c.earningsCents,
        tipsCents: c.tipsCents,
        avgRating: c.avgCustomerRating,
        ratingCount: c.ratingCount,
        payrateCents: u.payrateCents,
      },
      metrics: {
        acceptTime: metricDetail(c.avgAcceptMinutes, 5, "min", c.avgAcceptMinutes != null && c.avgAcceptMinutes > 5, c.avgAcceptMinutes != null && c.avgAcceptMinutes > 5 ? `avg accept ${c.avgAcceptMinutes} min — goal under 5` : null, trend.acceptTime),
        etaAccuracy: metricDetail(c.onTimePct, 80, "% on time", c.lateJobsPct != null && c.lateJobsPct > 20, c.lateJobsPct != null && c.lateJobsPct > 20 ? `${c.lateJobsPct}% of jobs 10+ min late — goal under 20%` : null, trend.onTime),
        photos: metricDetail(c.photosPct, 100, "% at 12/12", c.photosPct != null && c.photosPct < 100, c.photosPct != null && c.photosPct < 100 ? `${c.photosPct}% of jobs complete — goal 100%` : null, trend.photos),
        completionRate: metricDetail(c.completionRatePct, 90, "%", c.completionRatePct != null && c.completionRatePct < 90, c.completionRatePct != null && c.completionRatePct < 90 ? `completed ${c.completionRatePct}% of assigned — goal 90%+` : null, trend.completionRate),
        customerRating: metricDetail(c.avgCustomerRating, 4.5, "★", c.avgCustomerRating != null && c.avgCustomerRating < 4.5, c.avgCustomerRating != null && c.avgCustomerRating < 4.5 ? `avg rating ${c.avgCustomerRating} — goal 4.5+` : null, trend.rating),
        tipRate: metricDetail(c.tipRatePct, 25, "% of jobs", c.tipRatePct != null && c.tipRatePct < 25, c.tipRatePct != null && c.tipRatePct < 25 ? `${c.tipRatePct}% of jobs tipped — goal 25%+` : null, trend.tipRate),
        acceptRate: metricDetail(c.acceptRatePct, 80, "%", c.acceptRatePct != null && c.acceptRatePct < 80, c.acceptRatePct != null && c.acceptRatePct < 80 ? `accepted ${c.acceptRatePct}% of offers — goal 80%+` : null, []),
        gpsCoverage: metricDetail(c.gpsCoveragePct, 80, "%", c.gpsCoveragePct != null && c.gpsCoveragePct < 80, c.gpsCoveragePct != null && c.gpsCoveragePct < 80 ? `${c.gpsCoveragePct}% of jobs had updates — goal 80%+` : null, []),
        availability: metricDetail(c.onlineCoveragePct, 60, "% of week", c.onlineCoveragePct != null && c.onlineCoveragePct < 60, c.onlineCoveragePct != null && c.onlineCoveragePct < 60 ? `online ${c.onlineCoveragePct}% of ${PERIOD_LABEL[p]} — goal 60%+` : null, trend.coverage),
        avgTimeToComplete: metricDetail(c.avgTimeToCompleteMinutes, null, "min", false, null, []),
      },
      photosCard: c.photosCard,
      surveys: c.surveys,
      availabilityCard: {
        currentStatus: u.online ? "online" : "offline",
        lastPingAt: data.lastPingAtByDriver.get(u.id) ?? null,
        pings24h: data.pings24hByDriver.get(u.id) ?? 0,
      },
      aiDispatch: c.aiDispatch,
      academy: toRow(u, c, p, data).academy,
    };
    return { ok: true, period: p, driver: row };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unable to load driver metrics." };
  }
}

export async function getMyMetricsHandler(period: unknown): Promise<DriverMetricsDetailResult> {
  if (!configured()) return { ok: false, error: "Metrics require database mode." };
  const eff = await resolveEffectiveDriver();
  if (!eff) return { ok: false, error: "Sign in as a driver first." };
  const p = METRICS_PERIODS.includes(period as MetricsPeriod) ? (period as MetricsPeriod) : "week";
  try {
    const now = new Date();
    const data = await fetchOrgData(eff.u.orgId, p, eff.userRowId, now);
    const u = data.roster.find((r) => r.id === eff.userRowId);
    if (!u) return { ok: false, error: "Your account isn't linked to a driver yet." };
    const bounds = periodBounds(p, now);
    const c = computeDriver(u, p, bounds, data, now);
    const trend = computeTrend(u, data, now);
    const compliance = complianceFor(u, data);
    const row: DriverDetailRow = {
      userId: u.id,
      name: u.name,
      towbookDriverId: u.towbookDriverId,
      status: u.online ? "online" : "offline",
      compliance,
      stats: {
        jobsCompleted: c.jobsCompleted,
        earningsCents: c.earningsCents,
        tipsCents: c.tipsCents,
        avgRating: c.avgCustomerRating,
        ratingCount: c.ratingCount,
        payrateCents: u.payrateCents,
      },
      metrics: {
        acceptTime: metricDetail(c.avgAcceptMinutes, 5, "min", c.avgAcceptMinutes != null && c.avgAcceptMinutes > 5, c.avgAcceptMinutes != null && c.avgAcceptMinutes > 5 ? `avg accept ${c.avgAcceptMinutes} min — goal under 5` : null, trend.acceptTime),
        etaAccuracy: metricDetail(c.onTimePct, 80, "% on time", c.lateJobsPct != null && c.lateJobsPct > 20, c.lateJobsPct != null && c.lateJobsPct > 20 ? `${c.lateJobsPct}% of jobs 10+ min late — goal under 20%` : null, trend.onTime),
        photos: metricDetail(c.photosPct, 100, "% at 12/12", c.photosPct != null && c.photosPct < 100, c.photosPct != null && c.photosPct < 100 ? `${c.photosPct}% of jobs complete — goal 100%` : null, trend.photos),
        completionRate: metricDetail(c.completionRatePct, 90, "%", c.completionRatePct != null && c.completionRatePct < 90, c.completionRatePct != null && c.completionRatePct < 90 ? `completed ${c.completionRatePct}% of assigned — goal 90%+` : null, trend.completionRate),
        customerRating: metricDetail(c.avgCustomerRating, 4.5, "★", c.avgCustomerRating != null && c.avgCustomerRating < 4.5, c.avgCustomerRating != null && c.avgCustomerRating < 4.5 ? `avg rating ${c.avgCustomerRating} — goal 4.5+` : null, trend.rating),
        tipRate: metricDetail(c.tipRatePct, 25, "% of jobs", c.tipRatePct != null && c.tipRatePct < 25, c.tipRatePct != null && c.tipRatePct < 25 ? `${c.tipRatePct}% of jobs tipped — goal 25%+` : null, trend.tipRate),
        acceptRate: metricDetail(c.acceptRatePct, 80, "%", c.acceptRatePct != null && c.acceptRatePct < 80, c.acceptRatePct != null && c.acceptRatePct < 80 ? `accepted ${c.acceptRatePct}% of offers — goal 80%+` : null, []),
        gpsCoverage: metricDetail(c.gpsCoveragePct, 80, "%", c.gpsCoveragePct != null && c.gpsCoveragePct < 80, c.gpsCoveragePct != null && c.gpsCoveragePct < 80 ? `${c.gpsCoveragePct}% of jobs had updates — goal 80%+` : null, []),
        availability: metricDetail(c.onlineCoveragePct, 60, "% of week", c.onlineCoveragePct != null && c.onlineCoveragePct < 60, c.onlineCoveragePct != null && c.onlineCoveragePct < 60 ? `online ${c.onlineCoveragePct}% of ${PERIOD_LABEL[p]} — goal 60%+` : null, trend.coverage),
        avgTimeToComplete: metricDetail(c.avgTimeToCompleteMinutes, null, "min", false, null, []),
      },
      photosCard: c.photosCard,
      surveys: c.surveys,
      availabilityCard: {
        currentStatus: u.online ? "online" : "offline",
        lastPingAt: data.lastPingAtByDriver.get(u.id) ?? null,
        pings24h: data.pings24hByDriver.get(u.id) ?? 0,
      },
      aiDispatch: c.aiDispatch,
      academy: toRow(u, c, p, data).academy,
    };
    return { ok: true, period: p, driver: row };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unable to load your metrics." };
  }
}

export async function getAcademyRecommendationsHandler(): Promise<AcademyRecommendationsResult> {
  if (!configured()) return { ok: false, error: "Academy requires database mode." };
  const eff = await resolveEffectiveDriver();
  if (!eff) return { ok: false, error: "Sign in as a driver first." };
  try {
    const now = new Date();
    const data = await fetchOrgData(eff.u.orgId, "week", eff.userRowId, now);
    const u = data.roster.find((r) => r.id === eff.userRowId);
    if (!u) return { ok: false, error: "Your account isn't linked to a driver yet." };
    const c = computeDriver(u, "week", periodBounds("week", now), data, now);
    const row = toRow(u, c, "week", data);
    return { ok: true, driverName: u.name, onTrack: row.academy.length === 0, recommendations: row.academy };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unable to load recommendations." };
  }
}

export async function getLessonProgressHandler(): Promise<LessonProgressResult> {
  if (!configured()) return { ok: false, error: "Academy requires database mode." };
  const eff = await resolveEffectiveDriver();
  if (!eff) return { ok: false, error: "Sign in as a driver first." };
  try {
    const q = sql();
    const rows = await q`SELECT l.id, l.slug, l.title, l.summary, l.metric_key, l.duration_minutes, l.sort_order,
        ap.status, ap.completed_at
      FROM academy_lessons l
      LEFT JOIN academy_progress ap ON ap.org_id=${eff.u.orgId} AND ap.user_id=${eff.userRowId} AND ap.lesson_id=l.id
      WHERE l.active=TRUE ORDER BY l.sort_order`;
    const lessons: LessonProgressRow[] = (rows as Record<string, unknown>[]).map((r) => ({
      lessonId: String(r.id),
      slug: String(r.slug),
      title: String(r.title),
      summary: String(r.summary),
      metricKey: String(r.metric_key),
      durationMinutes: Number(r.duration_minutes ?? 4),
      sortOrder: Number(r.sort_order ?? 0),
      status: r.status == null ? "not_started" : (String(r.status) === "completed" ? "completed" : "in_progress"),
      completedAt: r.completed_at != null ? new Date(String(r.completed_at)).toISOString() : null,
    }));
    return { ok: true, lessons };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unable to load lessons." };
  }
}

export async function markLessonCompleteHandler(lessonId: unknown): Promise<MarkLessonCompleteResult> {
  if (!configured()) return { ok: false, error: "Academy requires database mode." };
  const eff = await resolveEffectiveDriver();
  if (!eff) return { ok: false, error: "Sign in as a driver first." };
  if (typeof lessonId !== "string" || !lessonId.trim()) return { ok: false, error: "Choose a lesson." };
  try {
    const q = sql();
    const lesson = await q`SELECT id FROM academy_lessons WHERE id=${lessonId} AND active=TRUE LIMIT 1`;
    if (!lesson.length) return { ok: false, error: "That lesson isn't available." };
    // Idempotent upsert: a second "Mark complete" keeps the original completion.
    await q`INSERT INTO academy_progress(org_id, user_id, lesson_id, status, completed_at)
      VALUES(${eff.u.orgId}, ${eff.userRowId}, ${lessonId}, 'completed', NOW())
      ON CONFLICT (org_id, user_id, lesson_id) DO UPDATE SET
        status='completed',
        completed_at=COALESCE(academy_progress.completed_at, EXCLUDED.completed_at)`;
    return { ok: true, status: "completed" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unable to mark the lesson complete." };
  }
}
