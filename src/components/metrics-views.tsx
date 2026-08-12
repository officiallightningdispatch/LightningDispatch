/**
 * Metrics tab + Lightning Dispatch Academy — shared view components
 * (owner-directed 2026-08-12, metrics-academy-spec.md). Mirrors ops-views.tsx:
 * the owner fleet view + per-driver drill-in, and the driver metrics + Academy
 * screens. Mobile-first, token-true; every number tabular-nums.
 *
 * WHITE-LABEL RULE: the driver portal surfaces (DriverMetricsView,
 * AcademyLessonView) must never render "Towbook" — the backend brand is
 * owner-surface-only. The owner Metrics screens may reference it ("tracked by
 * Towbook, synced live" — the honest framing from the spec).
 */
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft, BarChart3, Bot, Camera, ChevronRight, GraduationCap, MapPin, RefreshCw,
  Star, Trophy, Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import { ComplianceBadge, ComplianceSummary, formatCents } from "./contractor-admin";
import { Avatar, BoardSkeleton, Card, EmptyState, StatCard, StatusBadge } from "./ui";
import { InlineError } from "./mutation-status";
import { timeAgo } from "~/lib/job-ui";
import {
  getAcademyRecommendations,
  getDriverMetrics,
  getLessonProgress,
  getMyMetrics,
  getOrgMetrics,
  markLessonComplete,
} from "~/data/metrics";
import type {
  AcademyRecommendationsResult, DriverMetricsDetailResult,
  DriverMetricsRow, LessonProgressResult, MetricsPeriod, OrgMetricsResult,
} from "~/data/metrics-core";

/* ------------------------------ small shared bits ------------------------------ */
const PERIOD_OPTIONS: { value: MetricsPeriod; label: string }[] = [
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
  { value: "all", label: "All time" },
];

function PeriodControl({ period, onChange }: { period: MetricsPeriod; onChange: (p: MetricsPeriod) => void }) {
  return (
    <div className="flex rounded-full bg-ink-100 p-1" role="tablist" aria-label="Metrics period">
      {PERIOD_OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={period === o.value}
          onClick={() => onChange(o.value)}
          className={`h-9 flex-1 rounded-full text-xs font-bold capitalize transition-colors ${period === o.value ? "bg-surface text-ink-900 shadow-card" : "text-ink-500"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 4-week mini trend bars (dashboard jobs-by-status bar language). Nulls
 *  render as an empty slot; values scale to the max across the array. */
function TrendBars({ values }: { values: (number | null)[] }) {
  const max = Math.max(1, ...values.filter((v): v is number => v != null));
  return (
    <div className="flex h-1.5 items-end gap-1" aria-hidden="true">
      {values.map((v, i) => (
        <span key={i} className={`h-1.5 flex-1 rounded-full ${v == null ? "bg-ink-100" : v > 0 ? "bg-brand-500" : "bg-ink-200"}`} style={v != null && v > 0 ? { height: `${Math.max(20, (v / max) * 100)}%` } : undefined} />
      ))}
    </div>
  );
}

function WeakBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-danger-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-danger-700">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-danger-500" />
      {children}
    </span>
  );
}

/** Brand-tint Academy chip (fleet rows + metric cards) — the coach link. */
function AcademyChip({ title, to }: { title: string; to?: string }) {
  const inner = (
    <span className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-700">
      <Zap className="size-3" aria-hidden="true" /> Coach: {title}
    </span>
  );
  return to ? <Link to={to as any}>{inner}</Link> : inner;
}

const money = (cents: number | null | undefined): string => (cents == null ? "—" : formatCents(cents));

function metricStatusLine(m: DriverMetricsRow): { badge: string | null; chip: string | null } {
  // Weakest metric (deviation-order from the coach) → danger badge; top
  // recommended lesson → Academy chip. Order matches the coach sort.
  const recs = m.academy;
  const badge = recs.length ? `${recs[0].metricKey.replace(/_/g, " ")}` : null;
  return {
    badge: badge ? (recs[0].metricKey === "documents" ? "docs needed" : badge) : null,
    chip: recs.length ? recs[0].title : null,
  };
}

const driverLink = (id: string) => `/owner/metrics/${id}` as any;

/* ============================== OWNER: FLEET ============================== */
/** /owner/metrics — aggregate stat cards + the per-driver fleet list with
 *  weak-metric badges + Academy chips (owner/admin only; OwnerGate at the
 *  /owner layout). */
export function OwnerMetricsView() {
  const [period, setPeriod] = useState<MetricsPeriod>("week");
  const [state, setState] = useState<OrgMetricsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const load = async (p: MetricsPeriod) => {
    setLoading(true);
    setState(await getOrgMetrics({ data: { period: p } }));
    setLoading(false);
  };
  useEffect(() => { void load(period); }, []);
  const onPeriod = (p: MetricsPeriod) => { setPeriod(p); void load(p); };

  if (loading && state === null) return <BoardSkeleton rows={3} />;
  if (state && !state.ok) return <InlineError message={state.error} />;
  if (state && state.ok) {
    const a = state.aggregate;
    return (
      <div className="space-y-6">
        <PeriodControl period={period} onChange={onPeriod} />
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Fleet stats">
          <StatCard label="Avg accept time" value={a.avgAcceptMinutes != null ? `${a.avgAcceptMinutes} min` : "—"} detail="offer → thumbs-up" topBar />
          <StatCard label="On-time arrival" value={a.onTimePct != null ? `${a.onTimePct}%` : "—"} detail="within quoted ETA / SLA" />
          <StatCard label="Avg customer rating" value={a.avgCustomerRating != null ? `${a.avgCustomerRating} ★` : "—"} detail="from completion surveys" />
          <StatCard label="Completion rate" value={a.completionRatePct != null ? `${a.completionRatePct}%` : "—"} detail="assigned jobs finished" />
        </section>
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Volume stats">
          <StatCard label="Jobs completed" value={a.jobsCompleted} detail={`${a.drivers} drivers on the roster`} />
          <StatCard label="Tips total" value={<span className="text-brand-700">{money(a.tipsCents)}</span>} detail="paid to drivers" />
          <StatCard label="Photo compliance" value={a.photoCompliancePct != null ? `${a.photoCompliancePct}%` : "—"} detail="completed jobs at 12/12" />
          <StatCard label="Avg time to complete" value={a.avgTimeToCompleteMinutes != null ? `${a.avgTimeToCompleteMinutes} min` : "—"} detail="first event → completed" />
        </section>
        <section>
          <h2 className="mb-2 text-sm font-bold text-ink-700">Contractor performance</h2>
          {state.fleet.length === 0 ? (
            <EmptyState icon={BarChart3} title="No drivers on the roster yet" body="Once drivers are linked, their metrics build here from real job data." />
          ) : (
            <Card className="overflow-hidden">
              {state.fleet.map((m, i) => {
                const { badge, chip } = metricStatusLine(m);
                return (
                  <Link
                    key={m.userId}
                    to={driverLink(m.userId)}
                    className={`flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-ink-50 ${i === state.fleet.length - 1 ? "" : "border-b border-ink-100"}`}
                  >
                    <Avatar name={m.name} />
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 truncate text-sm font-semibold text-ink-900">
                        <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${m.status === "online" ? "bg-success-500" : "bg-ink-300"}`} />
                        <span className="truncate">{m.name}</span>
                      </p>
                      <p className="mt-0.5 truncate text-xs text-ink-400">
                        {m.jobsCompleted} jobs{m.avgCustomerRating != null ? ` · ${m.avgCustomerRating} ★` : ""}{m.avgAcceptMinutes != null ? ` · ${m.avgAcceptMinutes} min accept` : ""}
                      </p>
                      {(badge || chip) && (
                        <p className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          {badge && <WeakBadge>{badge}</WeakBadge>}
                          {chip && <AcademyChip title={chip} to={driverLink(m.userId)} />}
                        </p>
                      )}
                    </div>
                    <ChevronRight className="size-4 shrink-0 text-ink-300" aria-hidden="true" />
                  </Link>
                );
              })}
            </Card>
          )}
        </section>
      </div>
    );
  }
  return null;
}

/* ========================== OWNER: DRILL-IN ========================== */
function MetricDetailCard({ label, detail, value, unit, weak, why, trend, target }: {
  label: string; detail: string; value: number | null; unit: string; weak: boolean; why: string | null;
  trend: (number | null)[]; target: number | null;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-ink-400">{label}</p>
          <p className="mt-1 text-xl font-bold tabular-nums text-ink-900">
            {value != null ? `${value}${unit ? ` ${unit}` : ""}` : "—"}
          </p>
        </div>
        {weak && <WeakBadge>needs work</WeakBadge>}
      </div>
      <p className="mt-1 text-[11px] text-ink-400">{detail}</p>
      {trend.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between text-[10px] font-bold uppercase tracking-wide text-ink-300">
            <span>Last 4 weeks</span>
            {target != null && <span>goal {unit ? `${target} ${unit}` : target}</span>}
          </div>
          <TrendBars values={trend} />
        </div>
      )}
      {weak && why && (
        <p className="mt-2.5 rounded-lg bg-brand-50 px-2.5 py-1.5 text-[11px] font-semibold text-brand-800">
          <Zap className="mr-1 inline size-3" aria-hidden="true" />
          Academy — <span className="font-bold">why:</span> {why}
        </p>
      )}
    </Card>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 px-5 py-3">
      <p className="text-xs text-ink-400">{label}</p>
      <p className="text-sm font-semibold tabular-nums text-ink-900">{value}</p>
    </div>
  );
}

/** /owner/metrics/:id — the per-driver drill-in (deep-linkable; cross-linked
 *  to /owner/contractors/:id and vice versa). */
export function OwnerDriverMetricsView({ driverId }: { driverId: string }) {
  const [period, setPeriod] = useState<MetricsPeriod>("week");
  const [state, setState] = useState<DriverMetricsDetailResult | null>(null);
  const [loading, setLoading] = useState(true);
  const load = async (p: MetricsPeriod) => {
    setLoading(true);
    setState(await getDriverMetrics({ data: { driverUserId: driverId, period: p } }));
    setLoading(false);
  };
  useEffect(() => { void load(period); }, [driverId]);
  const onPeriod = (p: MetricsPeriod) => { setPeriod(p); void load(p); };

  if (loading && state === null) return <BoardSkeleton rows={4} />;
  if (state && !state.ok) return <InlineError message={state.error} />;
  if (state && state.ok) {
    const d = state.driver;
    const m = d.metrics;
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Link to="/owner/metrics" className="grid size-10 shrink-0 place-items-center rounded-xl border border-ink-200 bg-surface text-ink-600 transition-colors hover:bg-ink-50" aria-label="Back to fleet metrics">
            <ArrowLeft className="size-4" aria-hidden="true" />
          </Link>
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-[.18em] text-brand-600">Driver metrics</p>
            <h2 className="truncate text-xl font-bold tracking-tight">{d.name}</h2>
          </div>
        </div>

        {/* Identity card */}
        <Card className="p-5">
          <div className="flex items-start gap-4">
            <Avatar name={d.name} className="size-14 text-lg" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-base font-bold text-ink-900">{d.name}</p>
                <StatusBadge dot className={d.status === "online" ? "bg-success-50 text-success-700" : "bg-ink-100 text-ink-500"}>{d.status}</StatusBadge>
              </div>
              <p className="mt-0.5 text-xs text-ink-400">Driver #{d.towbookDriverId}</p>
              {d.compliance && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <ComplianceBadge onFile={d.compliance.onFile} required={d.compliance.required} size="lg" />
                  <ComplianceSummary onFile={d.compliance.onFile} required={d.compliance.required} missingNames={[]} />
                </div>
              )}
              <Link to={`/owner/contractors/${d.userId}` as any} className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-lg border border-ink-200 px-3 text-xs font-bold text-ink-600 transition-colors hover:bg-ink-50">
                Manage contractor →
              </Link>
            </div>
          </div>
        </Card>

        <PeriodControl period={period} onChange={onPeriod} />
        <section className="grid grid-cols-2 gap-3" aria-label="Driver stats">
          <StatCard label="Jobs completed" value={d.stats.jobsCompleted} detail={period === "week" ? "this week" : period === "month" ? "this month" : "all time"} />
          <StatCard label="Earnings" value={<span className="text-brand-700">{money(d.stats.earningsCents)}</span>} detail={d.stats.payrateCents != null ? `${money(d.stats.payrateCents)}/job + tips` : "payrate not set"} />
          <StatCard label="Tips total" value={<span className="text-brand-700">{money(d.stats.tipsCents)}</span>} detail="paid tips" />
          <StatCard label="Avg rating" value={d.stats.avgRating != null ? `${d.stats.avgRating} ★` : "—"} detail={`${d.stats.ratingCount} survey${d.stats.ratingCount === 1 ? "" : "s"}`} />
        </section>

        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Metric details">
          <MetricDetailCard label="Accept time" detail="offer → thumbs-up, per completed job" value={m.acceptTime.value} unit={m.acceptTime.unit} weak={m.acceptTime.weak} why={m.acceptTime.why} trend={m.acceptTime.trend} target={m.acceptTime.target} />
          <MetricDetailCard label="On-time arrival" detail="within quoted ETA / 45-min SLA" value={m.etaAccuracy.value} unit={m.etaAccuracy.unit} weak={m.etaAccuracy.weak} why={m.etaAccuracy.why} trend={m.etaAccuracy.trend} target={m.etaAccuracy.target} />
          <MetricDetailCard label="Photos compliance" detail="completed jobs at 12/12" value={m.photos.value} unit={m.photos.unit} weak={m.photos.weak} why={m.photos.why} trend={m.photos.trend} target={m.photos.target} />
          <MetricDetailCard label="Completion rate" detail="assigned jobs finished" value={m.completionRate.value} unit={m.completionRate.unit} weak={m.completionRate.weak} why={m.completionRate.why} trend={m.completionRate.trend} target={m.completionRate.target} />
          <MetricDetailCard label="Customer rating" detail="from completion surveys" value={m.customerRating.value} unit={m.customerRating.unit} weak={m.customerRating.weak} why={m.customerRating.why} trend={m.customerRating.trend} target={m.customerRating.target} />
          <MetricDetailCard label="Tip rate" detail="jobs that earned a tip" value={m.tipRate.value} unit={m.tipRate.unit} weak={m.tipRate.weak} why={m.tipRate.why} trend={m.tipRate.trend} target={m.tipRate.target} />
          <MetricDetailCard label="Accept rate" detail="offers accepted vs declined" value={m.acceptRate.value} unit={m.acceptRate.unit} weak={m.acceptRate.weak} why={m.acceptRate.why} trend={[]} target={m.acceptRate.target} />
          <MetricDetailCard label="GPS coverage" detail="jobs with location updates" value={m.gpsCoverage.value} unit={m.gpsCoverage.unit} weak={m.gpsCoverage.weak} why={m.gpsCoverage.why} trend={[]} target={m.gpsCoverage.target} />
          <MetricDetailCard label="Availability" detail="time online vs the period" value={m.availability.value} unit={m.availability.unit} weak={m.availability.weak} why={m.availability.why} trend={m.availability.trend} target={m.availability.target} />
          <MetricDetailCard label="Avg time to complete" detail="first event → completed" value={m.avgTimeToComplete.value} unit={m.avgTimeToComplete.unit} weak={false} why={null} trend={[]} target={null} />
        </section>

        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {/* Photos card */}
          <Card className="overflow-hidden">
            <div className="flex items-center gap-2 px-5 pt-4">
              <Camera className="size-4 text-ink-400" aria-hidden="true" />
              <h3 className="text-sm font-bold text-ink-800">Photos</h3>
            </div>
            <div className="mt-1 divide-y divide-ink-100">
              <DetailRow label="Jobs at 12/12" value={d.photosCard.pct12 != null ? `${d.photosCard.pct12}%` : "—"} />
              <DetailRow label="Avg arrival photos" value={d.photosCard.preArrivalAvg != null ? `${d.photosCard.preArrivalAvg}/4` : "—"} />
              <DetailRow label="Avg service photos" value={d.photosCard.serviceAvg != null ? `${d.photosCard.serviceAvg}/4` : "—"} />
              <DetailRow label="Avg final photos" value={d.photosCard.finalAvg != null ? `${d.photosCard.finalAvg}/4` : "—"} />
            </div>
          </Card>

          {/* Survey card */}
          <Card className="overflow-hidden">
            <div className="flex items-center gap-2 px-5 pt-4">
              <Star className="size-4 text-ink-400" aria-hidden="true" />
              <h3 className="text-sm font-bold text-ink-800">Customer surveys</h3>
            </div>
            <div className="mt-2 space-y-2 px-5 pb-4">
              {d.surveys.distribution.every((n) => n === 0) ? (
                <p className="text-xs text-ink-400">No surveys yet — completion capture builds these.</p>
              ) : (
                <>
                  <div className="space-y-1">
                    {[5, 4, 3, 2, 1].map((s) => {
                      const n = d.surveys.distribution[s - 1] ?? 0;
                      const total = d.surveys.distribution.reduce((a, b) => a + b, 0);
                      return (
                        <div key={s} className="flex items-center gap-2 text-[11px]">
                          <span className="w-7 shrink-0 font-bold tabular-nums text-ink-500">{s}★</span>
                          <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-100">
                            <div className="h-full rounded-full bg-brand-500" style={{ width: `${total ? (n / total) * 100 : 0}%` }} />
                          </div>
                          <span className="w-5 shrink-0 text-right tabular-nums text-ink-400">{n}</span>
                        </div>
                      );
                    })}
                  </div>
                  {d.surveys.latest.map((s, i) => (
                    <div key={i} className="rounded-lg bg-ink-50 px-3 py-2">
                      <p className="flex items-center gap-1 text-xs font-bold text-ink-700">
                        <span className="text-brand-600">{s.rating}★</span> {s.jobLabel}
                      </p>
                      {s.comment && <p className="mt-0.5 line-clamp-2 text-xs text-ink-500">“{s.comment}”</p>}
                    </div>
                  ))}
                </>
              )}
            </div>
          </Card>

          {/* Availability card */}
          <Card className="overflow-hidden">
            <div className="flex items-center gap-2 px-5 pt-4">
              <MapPin className="size-4 text-ink-400" aria-hidden="true" />
              <h3 className="text-sm font-bold text-ink-800">Availability</h3>
            </div>
            <div className="mt-1 divide-y divide-ink-100">
              <DetailRow label="Current status" value={d.status === "online" ? "Online" : "Offline"} />
              <DetailRow label="Last GPS ping" value={d.availabilityCard.lastPingAt ? timeAgo(d.availabilityCard.lastPingAt) : "—"} />
              <DetailRow label="Pings in the last 24h" value={d.availabilityCard.pings24h} />
            </div>
            <p className="px-5 pb-4 text-[11px] text-ink-400">GPS coverage is based on the last 24 hours of location pings.</p>
          </Card>

          {/* AI dispatch card */}
          <Card className="overflow-hidden">
            <div className="flex items-center gap-2 px-5 pt-4">
              <Bot className="size-4 text-ink-400" aria-hidden="true" />
              <h3 className="text-sm font-bold text-ink-800">AI dispatch</h3>
            </div>
            <div className="mt-1 divide-y divide-ink-100">
              <DetailRow label="Jobs auto-accepted" value={d.aiDispatch.autoAccepted} />
              <DetailRow label="Avg quoted ETA" value={d.aiDispatch.avgQuotedEtaMinutes != null ? `${d.aiDispatch.avgQuotedEtaMinutes} min` : "—"} />
              <DetailRow label="Escalations involving them" value={d.aiDispatch.escalations} />
            </div>
            <div className="px-5 pb-4">
              <Link to="/owner/ai-dispatcher" className="text-xs font-bold text-brand-700 hover:underline">Open AI Dispatcher →</Link>
            </div>
          </Card>
        </section>
      </div>
    );
  }
  return null;
}

/* ============================== DRIVER: METRICS ============================== */
function DriverStatCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "brand" }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium text-ink-400">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${tone === "brand" ? "text-brand-700" : "text-ink-800"}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-ink-400">{sub}</p>}
    </Card>
  );
}

function DriverMetricCard({ label, value, unit, weak, why, trend, target }: {
  label: string; value: number | null; unit: string; weak: boolean; why: string | null;
  trend: (number | null)[]; target: number | null;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-ink-400">{label}</p>
          <p className="mt-1 text-xl font-bold tabular-nums text-ink-900">
            {value != null ? `${value}${unit ? ` ${unit}` : ""}` : "—"}
          </p>
        </div>
        {weak && <WeakBadge>needs work</WeakBadge>}
      </div>
      {target != null && value != null && (
        <p className="mt-0.5 text-[11px] text-ink-400">goal {unit ? `${target} ${unit}` : target}</p>
      )}
      {trend.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-ink-300">Last 4 weeks</div>
          <TrendBars values={trend} />
        </div>
      )}
      {weak && why && (
        <p className="mt-2.5 rounded-lg bg-brand-50 px-2.5 py-1.5 text-[11px] font-semibold text-brand-800">
          <Zap className="mr-1 inline size-3" aria-hidden="true" />
          {why}
        </p>
      )}
    </Card>
  );
}

/** /driver/metrics — the driver's own performance + Lightning Dispatch
 *  Academy. White-label: no backend brand ever. Owner-in-driver-view resolves
 *  to their effective driver identity server-side (their own metrics). */
export function DriverMetricsView() {
  const [period, setPeriod] = useState<MetricsPeriod>("week");
  const [state, setState] = useState<DriverMetricsDetailResult | null>(null);
  const [academy, setAcademy] = useState<AcademyRecommendationsResult | null>(null);
  const [lessons, setLessons] = useState<LessonProgressResult | null>(null);
  const [loading, setLoading] = useState(true);
  const load = async (p: MetricsPeriod) => {
    setLoading(true);
    const [m, rec, prog] = await Promise.all([
      getMyMetrics({ data: { period: p } }),
      getAcademyRecommendations(),
      getLessonProgress(),
    ]);
    setState(m);
    setAcademy(rec);
    setLessons(prog);
    setLoading(false);
  };
  useEffect(() => { void load(period); }, []);

  if (loading && state === null) return <BoardSkeleton rows={3} />;
  if (state && !state.ok) return <InlineError message={state.error} />;
  if (state && state.ok) {
    const d = state.driver;
    const m = d.metrics;
    const recs = academy?.ok ? academy.recommendations : [];
    const allLessons = lessons?.ok ? lessons.lessons : [];
    const recLessonIds = new Set(recs.map((r) => r.lessonId));
    // Browse list = every active lesson except the recommended ones (which are
    // already shown as coach cards above them).
    const browse = allLessons.filter((l) => !recLessonIds.has(l.lessonId));
    const statusBadge = (status: string) =>
      status === "completed" ? <span className="rounded-full bg-success-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-success-700">Done ✓</span>
        : status === "in_progress" ? <span className="rounded-full bg-info-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-info-700">In progress</span>
          : <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ink-500">Not started</span>;

    return (
      <div className="space-y-5">
        <PeriodControl period={period} onChange={(p) => { setPeriod(p); void load(p); }} />
        <section className="grid grid-cols-2 gap-3" aria-label="Your stats">
          <DriverStatCard label="Jobs completed" value={String(d.stats.jobsCompleted)} />
          <DriverStatCard label="Tips received" value={money(d.stats.tipsCents)} tone="brand" />
          <DriverStatCard label="Avg rating" value={d.stats.avgRating != null ? `${d.stats.avgRating} ★` : "—"} sub={`${d.stats.ratingCount} survey${d.stats.ratingCount === 1 ? "" : "s"}`} />
          <DriverStatCard label="Earnings" value={money(d.stats.earningsCents)} tone="brand" sub={d.stats.payrateCents != null ? `${money(d.stats.payrateCents)}/job + tips` : undefined} />
        </section>

        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-label="Your metrics">
          <DriverMetricCard label="Accept time" value={m.acceptTime.value} unit={m.acceptTime.unit} weak={m.acceptTime.weak} why={m.acceptTime.why} trend={m.acceptTime.trend} target={m.acceptTime.target} />
          <DriverMetricCard label="On-time arrival" value={m.etaAccuracy.value} unit={m.etaAccuracy.unit} weak={m.etaAccuracy.weak} why={m.etaAccuracy.why} trend={m.etaAccuracy.trend} target={m.etaAccuracy.target} />
          <DriverMetricCard label="Photos compliance" value={m.photos.value} unit={m.photos.unit} weak={m.photos.weak} why={m.photos.why} trend={m.photos.trend} target={m.photos.target} />
          <DriverMetricCard label="Completion rate" value={m.completionRate.value} unit={m.completionRate.unit} weak={m.completionRate.weak} why={m.completionRate.why} trend={m.completionRate.trend} target={m.completionRate.target} />
          <DriverMetricCard label="Customer rating" value={m.customerRating.value} unit={m.customerRating.unit} weak={m.customerRating.weak} why={m.customerRating.why} trend={m.customerRating.trend} target={m.customerRating.target} />
          <DriverMetricCard label="Tip rate" value={m.tipRate.value} unit={m.tipRate.unit} weak={m.tipRate.weak} why={m.tipRate.why} trend={m.tipRate.trend} target={m.tipRate.target} />
        </section>

        {/* Lightning Dispatch Academy */}
        <section aria-label="Lightning Dispatch Academy">
          <div className="flex items-center gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
              <Zap className="size-5" aria-hidden="true" />
            </span>
            <div>
              <h2 className="text-base font-bold text-ink-900">Lightning Dispatch Academy</h2>
              <p className="text-xs text-ink-400">Personal coaching from your performance</p>
            </div>
          </div>

          {recs.length > 0 ? (
            <>
              {/* AI coach banner — brand-tinted attention (NOT yellow — reserved). */}
              <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-brand-200 bg-brand-50 p-3.5">
                <GraduationCap className="mt-0.5 size-4 shrink-0 text-brand-600" aria-hidden="true" />
                <p className="text-sm leading-relaxed text-brand-900">
                  <span className="font-bold">Coach:</span> {recs[0].why}.{" "}
                  Try: <span className="font-bold">{recs[0].title}</span>.
                </p>
              </div>
              <div className="mt-3 space-y-3">
                {recs.map((r) => {
                  const lesson = allLessons.find((l) => l.lessonId === r.lessonId);
                  return (
                    <Link key={r.lessonId} to={`/driver/academy/${r.lessonId}` as any} className="block">
                      <Card interactive className="p-4">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-ink-900">{r.title}</p>
                            <p className="mt-0.5 line-clamp-2 text-xs text-ink-400">{lesson?.summary ?? r.summary}</p>
                          </div>
                          {statusBadge(r.status)}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-bold text-ink-500">
                            {lesson?.durationMinutes ?? 4} min read
                          </span>
                          <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-bold text-brand-700">
                            {r.refresh ? "Refresh — " : ""}why: {r.why}
                          </span>
                        </div>
                      </Card>
                    </Link>
                  );
                })}
              </div>
            </>
          ) : (
            <Card className="mt-3 border-success-100 bg-success-50/60 p-4">
              <div className="flex items-center gap-2">
                <Trophy className="size-4 text-success-600" aria-hidden="true" />
                <p className="text-sm font-bold text-success-800">You&apos;re on track — nothing needs coaching right now.</p>
              </div>
              {browse.length > 0 && (
                <p className="mt-1 text-xs text-success-700">Want to level up anyway? Browse the full library below.</p>
              )}
            </Card>
          )}

          {browse.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-400">All lessons</h3>
              <Card className="divide-y divide-ink-100">
                {browse.map((l) => (
                  <Link key={l.lessonId} to={`/driver/academy/${l.lessonId}` as any} className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-ink-50">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-ink-800">{l.title}</p>
                      <p className="truncate text-xs text-ink-400">{l.summary}</p>
                    </div>
                    <span className="shrink-0 rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-bold text-ink-500">{l.durationMinutes} min</span>
                    {statusBadge(l.status)}
                    <ChevronRight className="size-4 shrink-0 text-ink-300" aria-hidden="true" />
                  </Link>
                ))}
              </Card>
            </div>
          )}
        </section>
      </div>
    );
  }
  return null;
}

/* ============================== DRIVER: LESSON ============================== */
/** /driver/academy/:id — lesson detail (in-app text + checklists for v1, no
 *  video) with the manual "Mark complete" button (owner decision Q3). */
export function AcademyLessonView({ lessonId }: { lessonId: string }) {
  const [progress, setProgress] = useState<LessonProgressResult | null>(null);
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState("");
  const load = async () => {
    setProgress(await getLessonProgress());
  };
  useEffect(() => { void load(); }, [lessonId]);
  const lesson = progress?.ok ? progress.lessons.find((l) => l.lessonId === lessonId) : undefined;
  const completed = lesson?.status === "completed";

  if (!progress) return <BoardSkeleton rows={3} />;
  if (!progress.ok) return <InlineError message={progress.error} />;
  if (!lesson) {
    return <EmptyState icon={GraduationCap} title="Lesson not found" body="That lesson isn't in the Academy right now." />;
  }

  const mark = async () => {
    setMarking(true);
    setMarkError("");
    const r = await markLessonComplete({ data: { lessonId } });
    setMarking(false);
    if (r.ok) { await load(); return; }
    setMarkError(r.error);
  };

  // The lesson body text is stored in academy_lessons.content (shipped with the
  // migration). Render it as short paragraphs / checklist lines.
  const lines = lessonDetailLines(lessonId);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link to="/driver/metrics" className="grid size-10 shrink-0 place-items-center rounded-xl border border-ink-200 bg-surface text-ink-600 transition-colors hover:bg-ink-50" aria-label="Back to Metrics">
          <ArrowLeft className="size-4" aria-hidden="true" />
        </Link>
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-[.18em] text-brand-600">Lightning Dispatch Academy</p>
          <h2 className="truncate text-xl font-bold tracking-tight">{lesson.title}</h2>
        </div>
      </div>

      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-bold text-ink-500">{lesson.durationMinutes} min read</span>
          {completed ? (
            <span className="rounded-full bg-success-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-success-700">Done ✓</span>
          ) : (
            <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ink-500">Not started</span>
          )}
        </div>
        <p className="mt-3 text-sm leading-relaxed text-ink-600">{lesson.summary}</p>
        <div className="mt-4 space-y-2">
          {lines.map((line, i) => (
            <label key={i} className="flex items-start gap-2.5 rounded-lg bg-ink-50 px-3 py-2.5 text-sm text-ink-700">
              <span aria-hidden="true" className={`mt-1 grid size-4 shrink-0 place-items-center rounded-md border ${completed ? "border-success-500 bg-success-500 text-white" : "border-ink-300 bg-surface"}`}>
                {completed && <RefreshCw className="size-2.5" aria-hidden="true" />}
              </span>
              <span className="min-w-0 leading-relaxed">{line}</span>
            </label>
          ))}
        </div>
      </Card>

      {markError && <InlineError message={markError} />}
      {completed ? (
        <Card className="border-success-100 bg-success-50/60 p-4 text-center">
          <p className="text-sm font-bold text-success-800">Lesson complete — well done. 🎉</p>
          <p className="mt-0.5 text-xs text-success-700">Your metrics were re-checked; this lesson won&apos;t re-surface unless the metric slips again.</p>
          <Link to="/driver/metrics" className="mt-3 inline-flex h-11 items-center justify-center rounded-xl bg-brand-500 px-5 text-sm font-bold text-white transition-colors hover:bg-brand-600">
            Back to Metrics
          </Link>
        </Card>
      ) : (
        <button
          type="button"
          onClick={() => void mark()}
          disabled={marking}
          className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-brand-500 px-4 text-sm font-bold text-white transition-colors hover:bg-brand-600 active:scale-[0.98] disabled:opacity-50"
        >
          {marking ? "Saving…" : "Mark lesson complete"}
        </button>
      )}
    </div>
  );
}

/** The shipped lesson bodies (academy_lessons.content) as renderable lines.
 *  Kept in sync with the migration seed; the client never fetches raw content
 *  in v1 (the API is lesson cards + progress only). */
function lessonDetailLines(lessonId: string): string[] {
  const CHECKLISTS: Record<string, string[]> = {
    "lesson-pre-trip-readiness": [
      "Why it matters: offers are time-sensitive — the member is waiting before you even tap. A quick accept sets the whole job up to run on time.",
      "Keep your phone unlocked and ringer on while you are on duty.",
      "When an offer lands, read the pickup + service in one glance and accept.",
      "If you cannot take it, decline immediately so dispatch can re-route.",
      "Before your shift, confirm your vehicle is fueled and stocked.",
      "Park where you can move out fast — no deep parking lots for the first offer.",
    ],
    "lesson-eta-honesty": [
      "Why it matters: an ETA you beat is great; an ETA you blow costs the member time and the company its reputation.",
      "Add traffic time, not just distance.",
      "Account for the extra minutes of prep at the vehicle — hookup, safety.",
      "If the route changes, update the ETA instead of hoping.",
      "Arrive early when you can — early beats late every time.",
      "Quote inside the club SLA, then beat it.",
    ],
    "lesson-twelve-photo-routine": [
      "Why it matters: photos are the proof trail for the job. 12/12 means the member, the club, and the owner can see exactly what happened.",
      "On arrival: one photo of each vehicle side (4) and confirm the vehicle matches.",
      "During service: capture the work as it happens (4).",
      "At the finish: final vehicle condition, all four sides (4).",
      "If a photo fails, retake it before moving on.",
      "Review the counts on screen before tapping complete.",
    ],
    "lesson-first-impressions": [
      "Why it matters: the member rates the whole job in the first minute — small courtesies move it more than the service itself.",
      "Call or text before you arrive if the member is waiting.",
      "Step out with a greeting and your name.",
      "Walk the vehicle once and explain what you will do.",
      "Keep the scene tidy — cones, gloves, and a clean truck.",
      "Ask if they need anything else before you finish.",
    ],
    "lesson-turning-service-into-tips": [
      "Why it matters: tips are part of your pay. Members tip when the experience felt personal and complete.",
      "Introduce yourself by name at the scene.",
      "Point out what you did while the work is fresh.",
      "Mention the tip link naturally — “a tip is optional but appreciated.”",
      "Leave the vehicle and the area better than you found it.",
      "Finish with a clean handoff and a genuine goodbye.",
    ],
    "lesson-acceptance-discipline": [
      "Why it matters: every declined offer costs the company re-dispatch time. A high accept rate keeps you first in line for the good jobs.",
      "Accept when the pickup fits your area and your day.",
      "Decline only for a real reason — range, hours, equipment.",
      "If you decline, note the reason so dispatch can adjust.",
      "Check your availability before a big offer wave.",
      "Tell dispatch when your day ends — do not just stop answering.",
    ],
    "lesson-stay-visible": [
      "Why it matters: the dispatcher routes offers by where you are. A driver with no ping reads as a driver that does not exist.",
      "Keep location on for the app while on duty.",
      "Let the app ping while en route — that is how the ETA stays real.",
      "If the app asks for location permission, allow it.",
      "At a long scene, nudge your position so the map stays live.",
      "Check in when you go online and check out when you are done.",
    ],
    "lesson-go-offline-planning": [
      "Why it matters: coverage is a real metric now. Members, clubs, and the owner all rely on drivers being online when they say they are.",
      "Set a start time and go online at that time.",
      "Keep the app open and online through your planned window.",
      "Use Offline for lunch and breaks, then GO again after.",
      "Log off when you are truly done — a silent online driver is worse than an offline one.",
      "Watch your weekly coverage in Metrics and aim for 60%+ of the week.",
    ],
    "lesson-finish-strong": [
      "Why it matters: a job you accept is a job you finish. Completion rate is the backbone trust metric between you, the owner, and the club.",
      "Confirm the member is safe and the vehicle is drivable before you leave.",
      "Complete the signature, survey, and tip steps on site.",
      "If anything is off, call dispatch before you drive away.",
      "Never leave a job uncompleted to chase the next offer.",
      "Review the finished job on your screen before moving on.",
    ],
    "lesson-paperwork-done-right": [
      "Why it matters: required documents gate your GO button. Missing or expired paperwork means you cannot take jobs at all.",
      "Open Profile → Documents and check what is required.",
      "Upload each document as a clear, readable photo or PDF.",
      "For the driver’s license, add the live selfie too.",
      "Watch expiry dates — renew before they lapse.",
      "Re-upload promptly if the owner asks for a correction.",
    ],
  };
  return CHECKLISTS[lessonId] ?? [];
}
