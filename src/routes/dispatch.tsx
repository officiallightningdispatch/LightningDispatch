import { createFileRoute } from "@tanstack/react-router";
import { Inbox, Star, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { AppShell } from "~/components/app-shell";
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
import type { Contractor, Job, JobStatus } from "~/data/seed";
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
  JOB_STATUS_META,
  jobDriverName,
  SERVICE_ICONS,
  SERVICE_LABELS,
  timeAgo,
} from "~/lib/job-ui";
import { canSetJobStatus, SETTABLE_JOB_STATUSES } from "~/data/server";
import { mutationKey, useDispatchStore } from "~/lib/store";

import { OpsGate } from "~/components/portal-gate";
export const Route = createFileRoute("/dispatch")({ component: () => <OpsGate><DispatchConsole /></OpsGate> });

function DispatchConsole() {
  return (
    <AppShell portal="ops"
      title="Dispatcher console"
      description="Review incoming requests, see the AI recommendation, and keep every assignment moving."
    >
      <DispatchBoard />
    </AppShell>
  );
}

function DispatchBoard() {
  const { state, loading, resetDemo, isDemoMode, isPending, getError } = useDispatchStore();
  const jobs = state.jobs;
  const incoming = useMemo(() => jobs.filter((j) => j.status === "new"), [jobs]);
  const active = useMemo(() => jobs.filter((j) => ACTIVE_STATUSES.includes(j.status)), [jobs]);
  const completed = useMemo(() => jobs.filter((j) => j.status === "completed"), [jobs]);
  const onlineCount = useMemo(() => state.contractors.filter((c) => c.status === "online").length, [state.contractors]);
  const resetPending = isPending(mutationKey.reset());
  const resetError = getError(mutationKey.reset());

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
        {incoming.length === 0 ? (
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
        <SectionTitle
          title="Active jobs"
          hint="Use the simulate control to step a job through its lifecycle for the operation."
        />
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
          </Card>
        )}
      </section>

      {isDemoMode && <div className="flex flex-col items-end gap-2">
        {resetError && <InlineError message={resetError} className="max-w-sm" />}
        <Button
          variant="ghost"
          size="md"
          onClick={() => {
            if (confirm("Reset all demo data back to the seeded state?")) void resetDemo();
          }}
          loading={resetPending}
        >
          {resetPending ? "Resetting…" : "Reset demo data"}
        </Button>
      </div>}
    </div>
  );
}

/* ---------------------------------- bits ---------------------------------- */

function SectionTitle({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-1">
      <h2 className="text-lg font-bold tracking-tight">{title}</h2>
      <p className="text-xs text-ink-500">{hint}</p>
    </div>
  );
}

function ServiceChip({
  serviceType,
  tone = "brand",
}: {
  serviceType: Job["serviceType"];
  tone?: "brand" | "ink";
}) {
  const Icon = SERVICE_ICONS[serviceType];
  return (
    <span
      className={`grid size-10 shrink-0 place-items-center rounded-xl ${
        tone === "brand" ? "bg-brand-50 text-brand-600" : "bg-ink-50 text-ink-500"
      }`}
    >
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
            <StatusBadge className={JOB_STATUS_META.new.badge}>
              {JOB_STATUS_META.new.label}
            </StatusBadge>
            <span className="text-[11px] font-medium tabular-nums text-ink-400">
              created {timeAgo(job.createdAt)}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-ink-600">
            {SERVICE_LABELS[job.serviceType]} · {job.location.area}
          </p>
          <p className="whitespace-pre-wrap break-words text-xs text-ink-400">{job.note}</p>
        </div>
      </div>

      <RecommendationPanel job={job} rec={rec} picking={picking} />

      <div className="flex gap-2 border-t border-ink-100 p-3">
        {rec.top ? (
          <Button
            className="flex-1"
            onClick={() => void assign(rec.top.contractor.id)}
            loading={pending}
          >
            {pending ? "Assigning…" : `Assign ${rec.top.contractor.name.split(" ")[0]}`}
          </Button>
        ) : (
          <div className="flex flex-1 items-center justify-center rounded-xl bg-ink-50 px-3 py-2 text-center text-xs font-semibold text-ink-500">
            No contractors available — add contractors to the roster before dispatching.
          </div>
        )}
        <Button
          variant="secondary"
          onClick={() => setPicking((p) => !p)}
          disabled={pending}
          className={picking ? "border-brand-300 bg-brand-50 text-brand-700 hover:bg-brand-100" : ""}
        >
          {pending ? "…" : "Override…"}
        </Button>
      </div>

      {error && (
        <div className="border-t border-danger-100 p-3">
          <InlineError message={error} />
          <p className="mt-1.5 text-[11px] text-ink-400">
            Try again — the assign button will retry once the current attempt settles.
          </p>
        </div>
      )}

      {picking && <OverridePicker job={job} rec={rec} contractors={contractors} onAssign={(id) => void assign(id)} />}
    </Card>
  );
}

function RecommendationPanel({
  job,
  rec,
  picking,
}: {
  job: Job;
  rec: DispatchRecommendation;
  picking: boolean;
}) {
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
    <div
      className={`mx-3 mb-1 rounded-xl border p-3 ${
        picking ? "border-accent-200 bg-accent-50/60" : "border-ink-100 bg-hover"
      }`}
    >
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
          <p className="text-[28px] font-extrabold leading-none tracking-tight tabular-nums text-ink-900">
            {top.score}
          </p>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-400">score</p>
        </div>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-200">
        <div
          className="h-full rounded-full bg-gradient-to-r from-brand-500 to-brand-400"
          style={{ width: `${top.score}%` }}
        />
      </div>
      <p className="mt-1.5 text-[11px] text-ink-400">
        Job {job.id} · {SERVICE_LABELS[job.serviceType]} at {job.location.area}
      </p>
    </div>
  );
}

function OverridePicker({
  job,
  rec,
  contractors,
  onAssign,
}: {
  job: Job;
  rec: DispatchRecommendation;
  contractors: Contractor[];
  onAssign: (contractorId: string) => void;
}) {
  const { isPending } = useDispatchStore();
  const pending = isPending(mutationKey.assign(job.id));
  // Every contractor is listed — the AI pick stays visible, you choose. Offline
  // rows are flagged but left assignable: the server (and the demo-mode
  // validation mirror) rejects the assignment with the offline_contractor
  // error, which renders inline on the card.
  const rows = useMemo(() => {
    const candidateIds = new Set(rec.candidates.map((c) => c.contractor.id));
    const extras = contractors
      .filter((c) => !candidateIds.has(c.id))
      .map((c) => ({
        contractor: c,
        score: null as number | null,
        distanceMiles: haversineMiles(job.location, c.location),
        avgResponseMin: Math.round(avgResponseMinutes(c)),
      }));
    return [
      ...rec.candidates.map((c) => ({
        contractor: c.contractor,
        score: c.score,
        distanceMiles: c.distanceMiles,
        avgResponseMin: c.avgResponseMin,
      })),
      ...extras,
    ];
  }, [rec, contractors, job]);

  return (
    <div className="border-t border-accent-100 bg-accent-50/50 p-3">
      <p className="mb-2 text-xs font-bold uppercase tracking-wider text-accent-700">
        All contractors — the AI pick stays visible, you choose
      </p>
      <div className="space-y-1.5">
        {rows.map((row) => {
          const c = row.contractor;
          const isTop = rec.top?.contractor.id === c.id;
          const offline = c.status !== "online";
          return (
            <div
              key={c.id}
              className={`flex items-center justify-between gap-2 rounded-lg border bg-surface px-3 py-2 ${
                isTop ? "border-accent-200" : "border-ink-100"
              } ${offline ? "opacity-60" : ""}`}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className={`break-words text-sm font-semibold ${offline ? "text-ink-400" : ""}`}>
                  {c.name}
                </span>
                {isTop && (
                  <span className="shrink-0 rounded-full bg-accent-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent-700">
                    AI pick
                  </span>
                )}
                {offline && (
                  <span className="shrink-0 rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ink-400">
                    offline
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="hidden items-center gap-1 text-[11px] tabular-nums text-ink-400 sm:flex">
                  <Star className="size-3.5 fill-accent-500 text-accent-500" aria-hidden="true" />
                  {c.rating.toFixed(1)} · {fmtDistance(row.distanceMiles)} · {row.avgResponseMin} min avg
                </span>
                <span className="rounded-md bg-ink-100 px-1.5 py-0.5 text-xs font-bold tabular-nums text-ink-600">
                  {row.score ?? "—"}
                </span>
                <Button
                  variant="secondary"
                  size="md"
                  disabled={pending}
                  onClick={() => onAssign(c.id)}
                >
                  {pending ? "…" : "Assign"}
                </Button>
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
  const { setJobStatus, isPending, getError, getPushResult } = useDispatchStore();
  const toast = useToast();
  const contractor = contractorById(contractors, job.assignedContractorId);
  const driverName = jobDriverName(job, contractors);
  const rec = useMemo(() => recommendForJob(job, contractors), [job, contractors]);
  const overridden = contractor && rec.top && contractor.id !== rec.top.contractor.id;
  const key = mutationKey.setStatus(job.id);
  const pending = isPending(key);
  const error = getError(key);

  // Exact-status apply (owner/admin/dispatcher): the chosen status lands in the
  // portal AND is pushed to Towbook — the push outcome is surfaced in the toast.
  const apply = async (status: JobStatus) => {
    const ok = await setJobStatus(job.id, status);
    if (!ok) return;
    const push = getPushResult(mutationKey.setStatus(job.id));
    const label = JOB_STATUS_META[status].label;
    if (push && push.attempted && !push.verified) {
      toast(`${job.customerName} → ${label} saved — Towbook sync failed and was escalated to "Needs attention".`);
    } else if (push && push.skipped && push.reason === "newer-status-wins") {
      toast(`${job.customerName} — Towbook shows a newer status; portal stays at ${label}.`);
    } else if (push && push.skipped && push.reason === "already-at-status") {
      toast(`${job.customerName} already at ${label} on Towbook.`);
    } else if (push && push.attempted && push.verified) {
      toast(`${job.customerName} → ${label} · synced to Towbook.`);
    } else {
      toast(`${job.customerName} → ${label}`);
    }
  };

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <ServiceChip serviceType={job.serviceType} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="font-bold leading-tight">{job.customerName}</h3>
            <StatusBadge className={JOB_STATUS_META[job.status].badge}>
              {JOB_STATUS_META[job.status].label}
            </StatusBadge>
          </div>
          <p className="mt-0.5 text-sm text-ink-600">
            {SERVICE_LABELS[job.serviceType]} · {job.location.area}
          </p>
          {(contractor || driverName) && (
            <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-ink-500">
              <span className="inline-flex items-center gap-1.5 font-semibold text-ink-700">
                <span className="inline-block size-1.5 rounded-full bg-success-500" />
                {driverName ?? contractor?.name}
              </span>
              {overridden && (
                <span className="rounded-full bg-accent-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent-700">
                  Override — AI suggested {rec.top.contractor.name}
                </span>
              )}
              <span className="tabular-nums">offered {timeAgo(job.assignedAt)}</span>
            </p>
          )}
        </div>
      </div>

      <div className="mt-4">
        <JobStatusStepper status={job.status} />
      </div>

      <div className="mt-3 border-t border-ink-100 pt-3">
        {error && <InlineError message={error} className="mb-2 w-full" />}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] font-bold uppercase tracking-wider text-ink-400">Set status</span>
          {SETTABLE_JOB_STATUSES.map((s) => {
            const meta = JOB_STATUS_META[s];
            const isCurrent = s === job.status;
            const allowed = canSetJobStatus(job.status, s);
            return (
              <button
                key={s}
                type="button"
                disabled={pending || !allowed}
                title={
                  isCurrent
                    ? "Current status (tap to re-verify on Towbook)"
                    : !allowed
                      ? "Cannot move a job backward in the lifecycle"
                      : `Set to ${meta.label} and sync to Towbook`
                }
                onClick={() => void apply(s)}
                className={`rounded-full border px-2.5 py-1 text-xs font-semibold transition ${
                  isCurrent
                    ? "border-ink-300 bg-ink-100 text-ink-700"
                    : allowed
                      ? "border-brand-200 bg-brand-50 text-brand-700 hover:bg-brand-100"
                      : "cursor-not-allowed border-ink-100 bg-surface text-ink-300"
                } ${pending ? "opacity-60" : ""}`}
              >
                {isCurrent && pending ? "…" : meta.label}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] leading-4 text-ink-400">
          Sets the exact status here and on Towbook — even the one the driver already set on their phone.
        </p>
      </div>
    </Card>
  );
}

/* ------------------------------ completed row ------------------------------ */

function CompletedRow({
  job,
  contractors,
  last,
}: {
  job: Job;
  contractors: Contractor[];
  last: boolean;
}) {
  const driverName = jobDriverName(job, contractors);
  const duration = fmtDuration(job.assignedAt ?? job.createdAt, job.completedAt);
  return (
    <div className={`flex items-center gap-3 px-4 py-3 ${last ? "" : "border-b border-ink-100"}`}>
      <ServiceChip serviceType={job.serviceType} tone="ink" />
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm font-semibold">
          {job.customerName} <span className="font-normal text-ink-400">·</span>{" "}
          <span className="font-medium text-ink-500">{SERVICE_LABELS[job.serviceType]}</span>
        </p>
        <p className="text-xs tabular-nums text-ink-400">
          {driverName ?? "Unassigned"} · {duration} · done {timeAgo(job.completedAt)}
        </p>
      </div>
      <StatusBadge className={`shrink-0 ${JOB_STATUS_META.completed.badge}`}>Done</StatusBadge>
    </div>
  );
}
