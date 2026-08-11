import { BarChart3, Briefcase, History, Inbox, Plug, Star, Users, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { authStatus, type Role } from "~/data/auth";
import { JobStatusStepper } from "~/components/job-status-stepper";
import { InlineError } from "~/components/mutation-status";
import {
  Avatar,
  BoardSkeleton,
  Button,
  Card,
  EmptyState,
  StatCard,
  StatusBadge,
  useToast,
} from "~/components/ui";
import type { Contractor, Job } from "~/data/seed";
import {
  avgResponseMinutes,
  haversineMiles,
  recommendForJob,
  type DispatchRecommendation,
} from "~/lib/dispatch-recommendation";
import {
  ACTIVE_STATUSES,
  CONFIDENCE_META,
  fmtDuration,
  HISTORY_STATUSES,
  jobDriverName,
  JOB_LIFECYCLE,
  JOB_STATUS_META,
  nextStatus,
  SERVICE_ICONS,
  SERVICE_LABELS,
  timeAgo,
} from "~/lib/job-ui";
import { mutationKey, useDispatchStore } from "~/lib/store";
import { listContractors, type ContractorRow } from "~/data/contractor-management";
import { getStatusEvents, type StatusEvent } from "~/data/server";
import { getAllJobPhotoStatuses, type JobPhotoStatus } from "~/data/driver-photos";
import { getAllCompletionCaptures, type CompletionCaptureStatus } from "~/data/completion";
import { JobDetailDisclosure } from "~/components/job-detail";

/* ============================================================================
 * Shared dispatch views — rendered inside BOTH the ops shell (/ops/*) and the
 * owner shell (/owner/queue, /owner/active, /owner/history). All data comes
 * from the org-scoped dispatch store + getStatusEvents; no demo data ever.
 * ========================================================================== */

/* ------------------------------ photo status (light) ------------------------------ */

/** One shared fetch for every card on the page: all jobs' photo status, keyed
 *  by LD job id. The promise is cached module-wide so N cards never trigger N
 *  requests; a failure degrades to an empty map (cards simply show nothing). */
let photoStatusesPromise: Promise<Record<string, JobPhotoStatus>> | null = null;
function loadAllPhotoStatuses(): Promise<Record<string, JobPhotoStatus>> {
  photoStatusesPromise ??= getAllJobPhotoStatuses()
    .then((rows) => {
      const map: Record<string, JobPhotoStatus> = {};
      for (const r of rows) map[r.jobId] = r;
      return map;
    })
    .catch(() => ({}));
  return photoStatusesPromise;
}
function usePhotoStatuses(): Record<string, JobPhotoStatus> {
  const [map, setMap] = useState<Record<string, JobPhotoStatus>>({});
  useEffect(() => {
    let live = true;
    void loadAllPhotoStatuses().then((m) => { if (live) setMap(m); });
    return () => { live = false; };
  }, []);
  return map;
}

/** Compact per-job photo line for the owner/ops cards: per-phase counts and the
 *  vehicle-match confirmation — e.g. "Photos · 4/4 arrival ✓ · 4/4 service · 0/4
 *  final". Hidden for jobs with no photo activity. */
function PhotoStatusLine({ jobId }: { jobId: string }) {
  const map = usePhotoStatuses();
  const st = map[jobId];
  if (!st || st.phase === "idle" || st.phase === "completed") return null;
  return (
    <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-ink-500">
      <span className="uppercase tracking-wide text-ink-400">Photos</span>
      {(["pre_arrival", "service", "final"] as const).map((phase) => (
        <span
          key={phase}
          className={`rounded-full px-2 py-0.5 font-bold ${st.complete[phase] ? "bg-success-100 text-success-700" : "bg-ink-100 text-ink-500"}`}
        >
          {phase === "pre_arrival" ? "arrival" : phase} {st.counts[phase]}/4{st.complete[phase] ? " ✓" : ""}
        </span>
      ))}
      {st.phase === "finalizing" && (
        <span className="rounded-full bg-brand-100 px-2 py-0.5 font-bold text-brand-700">ready to complete</span>
      )}
      {st.matchConfirmed && (
        <span className="rounded-full bg-brand-100 px-2 py-0.5 font-bold text-brand-700">match ✓</span>
      )}
    </p>
  );
}

/* ------------------------------ completion status (light) ------------------------------ */

/** One shared fetch for every card on the page: all jobs' completion capture,
 *  keyed by LD job id (same pattern as the photo status above). A failure
 *  degrades to an empty map (cards simply show nothing). */
let completionStatusesPromise: Promise<Record<string, CompletionCaptureStatus>> | null = null;
function loadAllCompletionStatuses(): Promise<Record<string, CompletionCaptureStatus>> {
  completionStatusesPromise ??= getAllCompletionCaptures()
    .then((rows) => {
      const map: Record<string, CompletionCaptureStatus> = {};
      for (const r of rows) map[r.jobId] = r;
      return map;
    })
    .catch(() => ({}));
  return completionStatusesPromise;
}
function useCompletionStatuses(): Record<string, CompletionCaptureStatus> {
  const [map, setMap] = useState<Record<string, CompletionCaptureStatus>>({});
  useEffect(() => {
    let live = true;
    void loadAllCompletionStatuses().then((m) => { if (live) setMap(m); });
    return () => { live = false; };
  }, []);
  return map;
}

/** Compact per-job completion pill for the owner/ops cards: e.g. "✓ signature"
 *  once the customer capture is on file, plus the tip state ("tip $5 pending" /
 *  "tip $5 ✓") when the customer was handed a Square payment link. Hidden until
 *  something is captured. */
function CompletionStatusLine({ jobId }: { jobId: string }) {
  const map = useCompletionStatuses();
  const c = map[jobId];
  if (!c || c.status === "none") return null;
  const tipLabel = c.tip ? `tip ${(c.tip.amountCents / 100).toFixed(0)}` : null;
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-ink-500">
      <span className="uppercase tracking-wide text-ink-400">Completion</span>
      {c.status === "captured" || c.status === "tip_link_created" || c.status === "tip_paid" ? (
        <span className="rounded-full bg-success-100 px-2 py-0.5 font-bold text-success-700">✓ signature{c.survey ? ` · ${c.survey.rating}★` : ""}</span>
      ) : null}
      {tipLabel && (
        <span className={`rounded-full px-2 py-0.5 font-bold ${c.tip?.status === "paid" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
          {tipLabel} {c.tip?.status === "paid" ? "✓" : "pending"}
        </span>
      )}
    </p>
  );
}

/* ---------------------------------- queue ---------------------------------- */

export function QueueView() {
  const { state, loading } = useDispatchStore();
  const [role, setRole] = useState<Role>("dispatcher");
  useEffect(() => { void authStatus().then((s) => { if (s.user) setRole(s.user.role); }); }, []);
  const jobs = state.jobs;
  const incoming = useMemo(() => jobs.filter((j) => j.status === "new"), [jobs]);
  const active = useMemo(() => jobs.filter((j) => ACTIVE_STATUSES.includes(j.status)), [jobs]);
  const completed = useMemo(() => jobs.filter((j) => j.status === "completed"), [jobs]);
  const onlineCount = useMemo(() => state.contractors.filter((c) => c.status === "online").length, [state.contractors]);

  if (loading) {
    return <BoardSkeleton rows={Math.max(1, incoming.length + active.length)} />;
  }

  return (
    <div className="space-y-8">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Incoming" value={incoming.length} detail="waiting for assignment" topBar />
        <StatCard label="Active jobs" value={active.length} detail="in flight now" />
        <StatCard label="Contractors online" value={onlineCount} detail="available now" />
        <StatCard label="Completed" value={completed.length} detail="in total" />
      </section>

      <section>
        <SectionTitle
          title="Incoming jobs"
          hint={incoming.length ? "AI recommends a contractor for each — one tap to assign." : "Queue clear."}
        />
        {jobs.length === 0 ? (
          <EmptyState
            icon={Plug}
            title="Connect Towbook to see jobs"
            body="Live jobs from Towbook populate the queue here."
            action={role === "owner" || role === "admin" ? <Link to="/owner/settings" className="inline-flex h-11 items-center justify-center rounded-xl bg-brand-500 px-4 text-sm font-semibold text-white">Connect Towbook</Link> : <p className="text-xs font-semibold text-ink-500">Ask the owner to connect Towbook</p>}
          />
        ) : incoming.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="No new requests right now"
            body="When a new job lands, the AI recommendation and one-tap assign appear here."
          />
        ) : (
          <div className="space-y-4">
            {incoming.map((job) => (
              <IncomingJobCard key={job.id} job={job} contractors={state.contractors} />
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionTitle title="Active jobs" hint="Use the advance control to step a job through its lifecycle." />
        {active.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="No jobs in flight"
            body="Assign an incoming job and it shows up here with its full lifecycle."
          />
        ) : (
          <div className="space-y-4">
            {active.map((job) => (
              <ActiveJobCard key={job.id} job={job} contractors={state.contractors} />
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionTitle title="Recently completed" hint={completed.length ? "Last few jobs finished." : "Nothing completed yet."} />
        {completed.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="No completed jobs yet"
            body="Step one through the lifecycle above — it lands here when done."
          />
        ) : (
          <Card className="overflow-hidden">
            {completed
              .slice()
              .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))
              .slice(0, 5)
              .map((job, i) => (
                <CompletedRow key={job.id} job={job} contractors={state.contractors} last={i === 4} />
              ))}
          </Card>        )}
      </section>
    </div>
  );
}

/* ------------------------------- active jobs ------------------------------- */

/** Data-backed active-jobs tab: every job in offered → arrived, with the
 *  assigned contractor, service, and real timestamps. */
export function ActiveJobsView() {
  const { state, loading } = useDispatchStore();
  const active = useMemo(
    () =>
      state.jobs
        .filter((j) => ACTIVE_STATUSES.includes(j.status))
        .sort((a, b) => (b.assignedAt ?? b.createdAt).localeCompare(a.assignedAt ?? a.createdAt)),
    [state.jobs],
  );

  if (loading) return <BoardSkeleton rows={2} />;

  return (
    <div className="space-y-4">
      {active.length === 0 ? (
        <EmptyState
          icon={Briefcase}
          title="No active jobs"
          body="Jobs between offered and arrived appear here with their assigned contractor and live timestamps."
        />
      ) : (
        active.map((job) => <ActiveJobCard key={job.id} job={job} contractors={state.contractors} />)
      )}
    </div>
  );
}

/* --------------------------------- history --------------------------------- */

/** Data-backed history tab: terminal jobs (completed + cancelled), each with its
 *  status timeline drawn from status_events (org-scoped, real history). Cancelled
 *  jobs (Towbook 255 imports) belong here for PO/invoice reconciliation — never
 *  in Active. */
export function HistoryView() {
  const { state, loading } = useDispatchStore();
  const [events, setEvents] = useState<StatusEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  useEffect(() => {
    let live = true;
    void getStatusEvents().then((r) => {
      if (!live) return;
      if (Array.isArray(r)) setEvents(r);
      setEventsLoading(false);
    }).catch(() => { if (live) setEventsLoading(false); });
    return () => { live = false; };
  }, []);
  const history = useMemo(
    () =>
      state.jobs
        .filter((j) => HISTORY_STATUSES.includes(j.status))
        .sort((a, b) => (b.completedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.createdAt)),
    [state.jobs],
  );
  const byJob = useMemo(() => {
    const m = new Map<string, StatusEvent[]>();
    for (const e of events) {
      const list = m.get(e.jobId) ?? [];
      list.push(e);
      m.set(e.jobId, list);
    }
    for (const list of m.values()) list.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    return m;
  }, [events]);

  if (loading || eventsLoading) return <BoardSkeleton rows={2} />;

  return (
    <div className="space-y-4">
      {history.length === 0 ? (
        <EmptyState
          icon={History}
          title="No finished jobs yet"
          body="Completed jobs land here with their full status timeline — cancelled jobs (from Towbook) too."
        />
      ) : (
        history.map((job) => {
          const driverName = jobDriverName(job, state.contractors);
          const timeline = byJob.get(job.id) ?? [];
          const meta = JOB_STATUS_META[job.status];
          return (
            <Card key={job.id} className="p-4">
              <div className="flex items-start gap-3">
                <ServiceChip serviceType={job.serviceType} tone="ink" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <h3 className="font-bold leading-tight">{job.customerName}</h3>
                    <StatusBadge className={meta.badge}>{meta.label}</StatusBadge>
                  </div>
                  <p className="mt-0.5 text-sm text-ink-600">
                    {SERVICE_LABELS[job.serviceType]} · {job.location.area}
                  </p>
                  <p className="mt-1 text-xs tabular-nums text-ink-400">
                    {job.status === "cancelled"
                      ? `${driverName ?? "Unassigned"} · cancelled ${timeAgo(job.createdAt)}`
                      : `${driverName ?? "Unassigned"} · ${fmtDuration(job.createdAt, job.completedAt)} · completed ${timeAgo(job.completedAt)}`}
                  </p>
                </div>
              </div>
              {timeline.length > 0 && (
                <div className="mt-3 border-t border-ink-100 pt-3">
                  <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-ink-400">Status timeline</p>
                  <ol className="space-y-1.5">
                    {timeline.map((e, i) => (
                      <li key={i} className="flex items-baseline gap-2 text-xs">
                        <span className="w-14 shrink-0 text-right font-mono tabular-nums text-ink-400">
                          {new Date(e.occurredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                        <span className="text-ink-400">→</span>
                        <span className="font-semibold text-ink-700">{statusLabel(e.toStatus)}</span>
                        {e.actorRole && <span className="capitalize text-ink-400">by {e.actorRole}</span>}
                        {e.note && <span className="truncate text-ink-400">· {e.note}</span>}
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              <JobDetailDisclosure jobId={job.id} label="Details & photos" />
            </Card>
          );
        })
      )}
    </div>
  );
}

/* -------------------------------- contractors ------------------------------ */

/** Data-backed roster tab: name, status, capabilities, and any active job. */
export function ContractorsView() {
  const { state, loading } = useDispatchStore();
  const activeJobs = useMemo(() => state.jobs.filter((j) => ACTIVE_STATUSES.includes(j.status)), [state.jobs]);
  const jobFor = (contractorId: string) => activeJobs.find((j) => j.assignedContractorId === contractorId);
  const online = state.contractors.filter((c) => c.status === "online").length;

  if (loading) return <BoardSkeleton rows={2} />;

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Contractors" value={state.contractors.length} detail="on the roster" topBar />
        <StatCard label="Online" value={online} detail="available now" />
        <StatCard label="Active jobs" value={activeJobs.length} detail="in flight now" />
        <StatCard label="Completed" value={state.jobs.filter((j) => j.status === "completed").length} detail="jobs done" />
      </section>
      {state.contractors.length === 0 ? (
        <EmptyState
          icon={Users}
          title="Add your first contractor"
          body="Contractors appear here once they're added to the fleet — their status, capabilities, and current job."
        />
      ) : (
        <Card className="overflow-hidden">
          {state.contractors.map((c, i) => {
            const active = jobFor(c.id);
            return (
              <div key={c.id} className={`flex items-center gap-3 px-4 py-3.5 ${i === state.contractors.length - 1 ? "" : "border-b border-ink-100"}`}>
                <Avatar name={c.name} />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-semibold">
                    <span className="truncate">{c.name}</span>
                    <span className="flex shrink-0 items-center gap-1 text-[11px] font-semibold">
                      <span aria-hidden="true" className={`inline-block size-2 rounded-full ${c.status === "online" ? "bg-success-500" : "bg-ink-300"}`} />
                      <span className={c.status === "online" ? "text-success-600" : "text-ink-400"}>{c.status}</span>
                    </span>
                  </p>
                  <p className="mt-0.5 truncate text-xs text-ink-500">{c.vehicleTypes.length ? c.vehicleTypes.join(" · ") : "No capabilities listed"}</p>
                  {active ? (
                    <p className="mt-0.5 truncate text-xs font-medium text-brand-700">
                      {SERVICE_LABELS[active.serviceType]} · {active.customerName} · {JOB_STATUS_META[active.status].label}
                    </p>
                  ) : (
                    <p className="mt-0.5 text-xs text-ink-400">No active job</p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <p className="flex items-center justify-end gap-1 text-sm font-bold tabular-nums text-ink-900">
                    <Star className="size-3.5 fill-accent-500 text-accent-500" aria-hidden="true" />
                    {c.rating.toFixed(1)}
                  </p>
                  <p className="mt-0.5 text-[11px] tabular-nums text-ink-400">
                    {c.completedJobCount} jobs · {Math.round(avgResponseMinutes(c))} min avg
                  </p>
                </div>
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}

/* -------------------------------- performance ------------------------------ */

/** Owner performance tab — KPIs from real dispatch_jobs + status_events. The
 *  "Contractors" stat reads the REAL roster (the same listContractorsCore the
 *  Contractors tab renders — users rows in the org, deactivated excluded), NOT
 *  the legacy dispatch_contractors demo table that is empty for real orgs
 *  (BUG 3 fix 2026-08-11: the Performance tab previously showed 0). */
export function PerformanceView() {
  const { state, loading } = useDispatchStore();
  const [roster, setRoster] = useState<ContractorRow[] | null>(null);
  const [events, setEvents] = useState<StatusEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  useEffect(() => {
    let live = true;
    void listContractors().then((r) => { if (live && r.ok) setRoster(r.data); }).catch(() => {});
    void getStatusEvents().then((r) => {
      if (!live) return;
      if (Array.isArray(r)) setEvents(r);
      setEventsLoading(false);
    }).catch(() => { if (live) setEventsLoading(false); });
    return () => { live = false; };
  }, []);
  const jobs = state.jobs;
  const total = jobs.length;
  const completed = jobs.filter((j) => j.status === "completed");
  const cancelled = jobs.filter((j) => j.status === "cancelled");
  // Cancelled jobs (Towbook 255 imports) are NOT completions and NOT failures —
  // excluded from both the numerator and the denominator of the completion rate.
  const eligible = jobs.filter((j) => j.status !== "cancelled");
  const completionRate = eligible.length ? Math.round((completed.length / eligible.length) * 100) : 0;
  const counts = [...JOB_LIFECYCLE, "cancelled"].map((status) => ({ status, count: jobs.filter((j) => j.status === status).length }));
  // Avg time-to-complete from status_events: per completed job, the elapsed
  // time between its first recorded event and its completed event.
  const byJob = useMemo(() => {
    const m = new Map<string, StatusEvent[]>();
    for (const e of events) {
      const list = m.get(e.jobId) ?? [];
      list.push(e);
      m.set(e.jobId, list);
    }
    return m;
  }, [events]);
  const avgMinutes = useMemo(() => {
    let sum = 0, n = 0;
    for (const j of completed) {
      const evs = byJob.get(j.id);
      if (evs && evs.length) {
        const first = evs.reduce((a, b) => (a.occurredAt < b.occurredAt ? a : b)).occurredAt;
        const done = evs.find((e) => e.toStatus === "completed");
        if (done) { sum += Math.max(0, (new Date(done.occurredAt).getTime() - new Date(first).getTime()) / 60000); n++; }
      } else if (j.completedAt) {
        sum += Math.max(0, (new Date(j.completedAt).getTime() - new Date(j.createdAt).getTime()) / 60000);
        n++;
      }
    }
    return n ? Math.round(sum / n) : 0;
  }, [completed, byJob]);
  // Top contractors by completed count (real assigned jobs). Keyed by the
  // driver NAME — for synced jobs that is the driver the AI dispatcher /
  // Towbook assigned (assignedDriverName); for legacy manual assigns the
  // dispatch_contractors name — so completed Towbook jobs count toward the
  // right driver even when the legacy FK is unset (BUG 4 fix 2026-08-11).
  const topContractors = useMemo(() => {
    const m = new Map<string, number>();
    for (const j of completed) {
      const name = jobDriverName(j, state.contractors);
      if (name) m.set(name, (m.get(name) ?? 0) + 1);
    }
    return [...m.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }, [completed, state.contractors]);

  if (loading || eventsLoading) return <BoardSkeleton rows={3} />;

  return (
    <div className="space-y-8">
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total jobs" value={total} detail="all jobs in the system" topBar />
        <StatCard label="Completion rate" value={`${completionRate}%`} detail={`${completed.length} of ${eligible.length} completed${cancelled.length ? ` · ${cancelled.length} cancelled` : ""}`} />
        <StatCard label="Avg time to complete" value={`${avgMinutes} min`} detail="from first event to completed" />
        <StatCard label="Contractors" value={roster === null ? "—" : roster.length} detail="on the roster" />
      </section>

      <section>
        <SectionTitle title="Jobs by status" hint={`${total} total jobs`} />
        {total === 0 ? (
          <EmptyState
            icon={BarChart3}
            title="No jobs to break down yet"
            body="Once jobs flow through the system, this bar shows how the queue is split by status."
          />
        ) : (
          <Card className="p-4">
            <div className="flex h-3 overflow-hidden rounded-full bg-ink-100" role="img" aria-label="Jobs by status">
              {counts.map(({ status, count }) =>
                count > 0 ? (
                  <div key={status} title={`${JOB_STATUS_META[status].label}: ${count}`} className={JOB_STATUS_META[status].dot} style={{ width: `${(count / total) * 100}%` }} />
                ) : null,
              )}
            </div>
            <div className="mt-4 grid grid-cols-3 gap-x-3 gap-y-3 sm:grid-cols-7">
              {counts.map(({ status, count }) => (
                <div key={status} className="flex items-center gap-1.5 text-xs">
                  <span aria-hidden="true" className={`size-2 rounded-full ${JOB_STATUS_META[status].dot}`} />
                  <span className="text-ink-500">{JOB_STATUS_META[status].label}</span>
                  <strong className="tabular-nums text-ink-900">{count}</strong>
                </div>
              ))}
            </div>
          </Card>
        )}
      </section>

      <section>
        <SectionTitle title="Top contractors by completed jobs" hint={topContractors.length ? "From completed assignments" : "No completed assignments yet"} />
        {topContractors.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No completed assignments yet"
            body="As jobs finish, the contractor leaderboard builds from real data."
          />
        ) : (
          <Card className="overflow-hidden">
            {topContractors.map(({ name, count }, i) => (
              <div key={name} className={`flex items-center gap-3 px-4 py-3.5 ${i === topContractors.length - 1 ? "" : "border-b border-ink-100"}`}>
                <span className="w-6 shrink-0 text-center text-sm font-extrabold tabular-nums text-ink-300">{i + 1}</span>
                <Avatar name={name} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{name}</p>
                  <p className="text-xs text-ink-400">assigned driver</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-bold tabular-nums text-ink-900">{count}</p>
                  <p className="text-[11px] text-ink-400">{count === 1 ? "job" : "jobs"}</p>
                </div>
              </div>
            ))}
          </Card>
        )}
      </section>
    </div>
  );
}

/* ================================ shared bits =============================== */

function SectionTitle({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-1">
      <h2 className="text-lg font-bold tracking-tight">{title}</h2>
      <p className="text-xs text-ink-500">{hint}</p>
    </div>
  );
}

function ServiceChip({ serviceType, tone = "brand" }: { serviceType: Job["serviceType"]; tone?: "brand" | "ink" }) {
  const Icon = SERVICE_ICONS[serviceType];
  return (
    <span className={`grid size-10 shrink-0 place-items-center rounded-xl ${tone === "brand" ? "bg-brand-50 text-brand-600" : "bg-ink-50 text-ink-500"}`}>
      <Icon className="size-5" strokeWidth={2} aria-hidden="true" />
    </span>
  );
}

function contractorById(contractors: Contractor[], id?: string) {
  return contractors.find((c) => c.id === id);
}

function fmtDistance(miles: number) {
  return miles >= 10 ? `${Math.round(miles)} mi` : `${miles.toFixed(1)} mi`;
}

function statusLabel(status: string): string {
  const meta = JOB_STATUS_META[status as Job["status"]];
  if (meta) return meta.label;
  if (status === "import") return "Imported";
  return status;
}

/* ------------------------------- incoming job ------------------------------ */

function IncomingJobCard({ job, contractors }: { job: Job; contractors: Contractor[] }) {
  const { assignJob, isPending, getError } = useDispatchStore();
  const toast = useToast();
  const [picking, setPicking] = useState(false);
  const rec = useMemo(() => recommendForJob(job, contractors), [job, contractors]);
  const key = mutationKey.assign(job.id);
  const pending = isPending(key);
  const error = getError(key);

  const assign = async (contractorId: string) => {
    const ok = await assignJob(job.id, contractorId);
    if (ok) {
      const name = contractors.find((c) => c.id === contractorId)?.name.split(" ")[0];
      toast(`Assigned ${job.customerName} to ${name}`);
    }
  };

  return (
    <Card className="overflow-hidden">
      <div className="flex items-start gap-3 p-4 pb-3">
        <ServiceChip serviceType={job.serviceType} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="font-bold leading-tight">{job.customerName}</h3>
            <StatusBadge className={JOB_STATUS_META.new.badge}>{JOB_STATUS_META.new.label}</StatusBadge>
            <span className="text-[11px] font-medium tabular-nums text-ink-400">created {timeAgo(job.createdAt)}</span>
          </div>
          <p className="mt-0.5 text-sm text-ink-600">{SERVICE_LABELS[job.serviceType]} · {job.location.area}</p>
          <p className="truncate text-xs text-ink-400">{job.note}</p>
        </div>
      </div>

      <RecommendationPanel job={job} rec={rec} picking={picking} />

      <div className="flex gap-2 border-t border-ink-100 p-3">
        {rec.top ? (
          <Button className="flex-1" onClick={() => void assign(rec.top.contractor.id)} loading={pending}>
            {pending ? "Assigning…" : `Assign ${rec.top.contractor.name.split(" ")[0]}`}
          </Button>
        ) : (
          <div className="flex flex-1 items-center justify-center rounded-xl bg-ink-50 px-3 py-2 text-center text-xs font-semibold text-ink-500">
            No contractors available — add contractors to the roster before dispatching.
          </div>
        )}
        <Button variant="secondary" onClick={() => setPicking((p) => !p)} disabled={pending} className={picking ? "border-brand-300 bg-brand-50 text-brand-700 hover:bg-brand-100" : ""}>
          {pending ? "…" : "Override…"}
        </Button>
      </div>

      {error && (
        <div className="border-t border-danger-100 p-3">
          <InlineError message={error} />
          <p className="mt-1.5 text-[11px] text-ink-400">Try again — the assign button will retry once the current attempt settles.</p>
        </div>
      )}

      {picking && <OverridePicker job={job} rec={rec} contractors={contractors} onAssign={(id) => void assign(id)} />}

      <JobDetailDisclosure jobId={job.id} />
    </Card>
  );
}

function RecommendationPanel({ job, rec, picking }: { job: Job; rec: DispatchRecommendation; picking: boolean }) {
  const top = rec.top;
  const conf = CONFIDENCE_META[rec.confidence];
  if (!top) {
    // Empty roster safety rail (BUG 2 2026-08-11): no recommendation exists —
    // render a clear state, never crash on top.contractor.
    return (
      <div className="mx-3 mb-1 rounded-xl border border-ink-100 bg-hover p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-ink-500">
            <span className="grid size-5 place-items-center rounded-md bg-accent-100 text-accent-600">
              <Zap className="size-3.5" fill="currentColor" strokeWidth={0} aria-hidden="true" />
            </span>
            <span className="inline-block size-1.5 animate-pulse rounded-full bg-accent-500 motion-reduce:animate-none" />
            AI dispatch recommendation
          </span>
          <StatusBadge className={conf.badge}>{conf.label}</StatusBadge>
        </div>
        <p className="text-sm font-semibold text-ink-600">No contractors available</p>
        <p className="mt-0.5 text-xs italic text-ink-400">{rec.reason}</p>
      </div>
    );
  }
  return (
    <div className={`mx-3 mb-1 rounded-xl border p-3 ${picking ? "border-accent-200 bg-accent-50/60" : "border-ink-100 bg-hover"}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-ink-500">
          <span className="grid size-5 place-items-center rounded-md bg-accent-100 text-accent-600">
            <Zap className="size-3.5" fill="currentColor" strokeWidth={0} aria-hidden="true" />
          </span>
          <span className="inline-block size-1.5 animate-pulse rounded-full bg-accent-500 motion-reduce:animate-none" />
          AI dispatch recommendation
        </span>
        <StatusBadge className={conf.badge}>{conf.label}</StatusBadge>
      </div>
      <div className="flex items-center gap-3">
        <Avatar name={top.contractor.name} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 text-sm font-bold">
            {top.contractor.name}
            <span className="flex items-center gap-1 text-xs font-semibold text-success-600">
              <span className="inline-block size-1.5 rounded-full bg-success-500" /> online
            </span>
          </p>
          <p className="text-xs text-ink-500">{rec.explanation}</p>
          <p className="mt-0.5 text-xs italic text-ink-400">{rec.reason}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[28px] font-extrabold leading-none tracking-tight tabular-nums text-ink-900">{top.score}</p>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-400">score</p>
        </div>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-200">
        <div className="h-full rounded-full bg-gradient-to-r from-brand-500 to-brand-400" style={{ width: `${top.score}%` }} />
      </div>
      <p className="mt-1.5 text-[11px] text-ink-400">Job {job.id} · {SERVICE_LABELS[job.serviceType]} at {job.location.area}</p>
    </div>
  );
}

function OverridePicker({ job, rec, contractors, onAssign }: { job: Job; rec: DispatchRecommendation; contractors: Contractor[]; onAssign: (contractorId: string) => void }) {
  const { isPending } = useDispatchStore();
  const pending = isPending(mutationKey.assign(job.id));
  const rows = useMemo(() => {
    const candidateIds = new Set(rec.candidates.map((c) => c.contractor.id));
    const extras = contractors
      .filter((c) => !candidateIds.has(c.id))
      .map((c) => ({ contractor: c, score: null as number | null, distanceMiles: haversineMiles(job.location, c.location), avgResponseMin: Math.round(avgResponseMinutes(c)) }));
    return [
      ...rec.candidates.map((c) => ({ contractor: c.contractor, score: c.score, distanceMiles: c.distanceMiles, avgResponseMin: c.avgResponseMin })),
      ...extras,
    ];
  }, [rec, contractors, job]);

  return (
    <div className="border-t border-accent-100 bg-accent-50/50 p-3">
      <p className="mb-2 text-xs font-bold uppercase tracking-wider text-accent-700">All contractors — the AI pick stays visible, you choose</p>
      <div className="space-y-1.5">
        {rows.map((row) => {
          const c = row.contractor;
          const isTop = rec.top?.contractor.id === c.id;
          const offline = c.status !== "online";
          return (
            <div key={c.id} className={`flex items-center justify-between gap-2 rounded-lg border bg-surface px-3 py-2 ${isTop ? "border-accent-200" : "border-ink-100"} ${offline ? "opacity-60" : ""}`}>
              <div className="flex min-w-0 items-center gap-2">
                <span className={`truncate text-sm font-semibold ${offline ? "text-ink-400" : ""}`}>{c.name}</span>
                {isTop && <span className="shrink-0 rounded-full bg-accent-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent-700">AI pick</span>}
                {offline && <span className="shrink-0 rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ink-400">offline</span>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="hidden items-center gap-1 text-[11px] tabular-nums text-ink-400 sm:flex">
                  <Star className="size-3.5 fill-accent-500 text-accent-500" aria-hidden="true" />
                  {c.rating.toFixed(1)} · {fmtDistance(row.distanceMiles)} · {row.avgResponseMin} min avg
                </span>
                <span className="rounded-md bg-ink-100 px-1.5 py-0.5 text-xs font-bold tabular-nums text-ink-600">{row.score ?? "—"}</span>
                <Button variant="secondary" size="md" disabled={pending} onClick={() => onAssign(c.id)}>{pending ? "…" : "Assign"}</Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* -------------------------------- active job ------------------------------- */

function ActiveJobCard({ job, contractors }: { job: Job; contractors: Contractor[] }) {
  const { advanceJob, isPending, getError } = useDispatchStore();
  const toast = useToast();
  const contractor = contractorById(contractors, job.assignedContractorId);
  const driverName = jobDriverName(job, contractors);
  const rec = useMemo(() => recommendForJob(job, contractors), [job, contractors]);
  const overridden = contractor && rec.top && contractor.id !== rec.top.contractor.id;
  const next = nextStatus(job.status);
  const key = mutationKey.advance(job.id);
  const pending = isPending(key);
  const error = getError(key);

  const advance = async () => {
    const ok = await advanceJob(job.id);
    if (ok && next) {
      toast(next === "completed" ? `${job.customerName} marked completed` : `${job.customerName} → ${JOB_STATUS_META[next].label}`);
    }
  };

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <ServiceChip serviceType={job.serviceType} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="font-bold leading-tight">{job.customerName}</h3>
            <StatusBadge className={JOB_STATUS_META[job.status].badge}>{JOB_STATUS_META[job.status].label}</StatusBadge>
          </div>
          <p className="mt-0.5 text-sm text-ink-600">{SERVICE_LABELS[job.serviceType]} · {job.location.area}</p>
          {(contractor || driverName) && (
            <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-ink-500">
              <span className="inline-flex items-center gap-1.5 font-semibold text-ink-700">
                <span className="inline-block size-1.5 rounded-full bg-success-500" />
                {driverName ?? contractor?.name}
              </span>
              {overridden && (
                <span className="rounded-full bg-accent-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent-700">Override — AI suggested {rec.top.contractor.name}</span>
              )}
              <span className="tabular-nums">assigned {timeAgo(job.assignedAt)}</span>
            </p>
          )}
        </div>
      </div>

      <div className="mt-4">
        <JobStatusStepper status={job.status} />
      </div>

      <PhotoStatusLine jobId={job.id} />
      <CompletionStatusLine jobId={job.id} />

      {next && (
        <div className="mt-3 flex flex-col items-end gap-2 border-t border-ink-100 pt-3">
          {error && <InlineError message={error} className="w-full" />}
          <Button variant="ghost" size="md" onClick={() => void advance()} loading={pending}>
            {pending ? "Working…" : `Mark ${next === "completed" ? "completed" : JOB_STATUS_META[next].label.toLowerCase()}`}
          </Button>
        </div>
      )}

      <JobDetailDisclosure jobId={job.id} />
    </Card>
  );
}

/* ------------------------------ completed row ------------------------------ */

function CompletedRow({ job, contractors, last }: { job: Job; contractors: Contractor[]; last: boolean }) {
  const driverName = jobDriverName(job, contractors);
  const duration = fmtDuration(job.assignedAt ?? job.createdAt, job.completedAt);
  return (
    <div className={`${last ? "" : "border-b border-ink-100"}`}>
      <div className="flex items-center gap-3 px-4 py-3">
        <ServiceChip serviceType={job.serviceType} tone="ink" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">
            {job.customerName} <span className="font-normal text-ink-400">·</span>{" "}
            <span className="font-medium text-ink-500">{SERVICE_LABELS[job.serviceType]}</span>
          </p>
          <p className="text-xs tabular-nums text-ink-400">
            {driverName ?? "Unassigned"} · {duration} · done {timeAgo(job.completedAt)}
          </p>
        </div>
        <StatusBadge className={`shrink-0 ${JOB_STATUS_META.completed.badge}`}>Done</StatusBadge>
      </div>
      <JobDetailDisclosure jobId={job.id} label="Details & photos" />
    </div>
  );
}
