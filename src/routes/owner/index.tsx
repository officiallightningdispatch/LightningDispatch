import { createFileRoute } from "@tanstack/react-router";
import { BarChart3, CheckCircle2, Star, Users, Zap } from "lucide-react";
import { AppShell } from "~/components/app-shell";
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
import { avgResponseMinutes, recommendForJob } from "~/lib/dispatch-recommendation";
import {
  ACTIVE_STATUSES,
  fmtDuration,
  JOB_LIFECYCLE,
  JOB_STATUS_META,
  SERVICE_ICONS,
  SERVICE_LABELS,
  timeAgo,
} from "~/lib/job-ui";
import { mutationKey, useDispatchStore } from "~/lib/store";

export const Route = createFileRoute("/owner/")({ component: OwnerDashboard });

function OwnerDashboard() {
  const { state, loading, resetDemo, isDemoMode, isPending, getError } = useDispatchStore();
  const toast = useToast();
  const resetPending = isPending(mutationKey.reset());
  const resetError = getError(mutationKey.reset());
  const active = state.jobs.filter((j) => ACTIVE_STATUSES.includes(j.status));
  const completed = state.jobs.filter((j) => j.status === "completed");
  const online = state.contractors.filter((c) => c.status === "online").length;
  const assigned = state.jobs.filter((j) => !!j.assignedContractorId);
  const adopted = assigned.filter((j) => {
    const rec = recommendForJob(j, state.contractors);
    return rec.top?.contractor.id === j.assignedContractorId;
  }).length;
  const averageDuration = completed.length
    ? Math.round(completed.reduce((sum, j) => sum + durationMinutes(j), 0) / completed.length)
    : 0;
  const counts = JOB_LIFECYCLE.map((status) => ({
    status,
    count: state.jobs.filter((j) => j.status === status).length,
  }));

  if (loading) return <BoardSkeleton rows={3} />;

  const reset = async () => {
    if (!confirm("Reset all demo data back to the seeded state?")) return;
    const ok = await resetDemo();
    if (ok) toast("Demo data reset to the seeded state");
  };

  return (
    <AppShell
      title="Owner dashboard"
      description="A live, at-a-glance view of the operation and team performance."
    >
      <div className="space-y-8">
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Jobs in flight" value={active.length} detail="offered through arrived" topBar />
          <StatCard label="Contractors online" value={`${online} / ${state.contractors.length}`} detail="available now" />
          <StatCard label="Completed jobs" value={completed.length} detail={`${completedToday(completed)} completed today`} />
          <StatCard label="Avg completion" value={`${averageDuration} min`} detail="from completed jobs" />
        </section>

        <Card className="border-l-4 border-l-brand-500 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-ink-500">
                <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600">
                  <Zap className="size-3.5" fill="currentColor" strokeWidth={0} aria-hidden="true" />
                </span>
                AI recommendation adoption
              </p>
              <p className="mt-2.5 text-[28px] font-extrabold leading-none tracking-tight tabular-nums text-ink-900">
                {adopted}
                <span className="text-sm font-semibold text-ink-400"> of {assigned.length} assignments</span>
              </p>
            </div>
            <span className="shrink-0 rounded-full bg-brand-50 px-3 py-1.5 text-sm font-bold tabular-nums text-brand-700">
              {assigned.length ? Math.round((adopted / assigned.length) * 100) : 0}%
            </span>
          </div>
          <p className="mt-2.5 text-xs text-ink-400">
             assignments matched to the AI engine’s top pick.
          </p>
        </Card>

        <section>
          <SectionTitle title="Jobs by status" hint={`${state.jobs.length} total jobs`} />
          {state.jobs.length === 0 ? (
            <EmptyState
              icon={BarChart3}
              title="No jobs to break down yet"
              body="Once jobs flow through the system, this bar shows how the queue is split by status."
            />
          ) : (
            <Card className="p-4">
              <div
                className="flex h-3 overflow-hidden rounded-full bg-ink-100"
                role="img"
                aria-label="Jobs by status"
              >
                {counts.map(({ status, count }) =>
                  count > 0 ? (
                    <div
                      key={status}
                      title={`${JOB_STATUS_META[status].label}: ${count}`}
                      className={JOB_STATUS_META[status].dot}
                      style={{ width: `${(count / state.jobs.length) * 100}%` }}
                    />
                  ) : null,
                )}
              </div>
              <div className="mt-4 grid grid-cols-3 gap-x-3 gap-y-3 sm:grid-cols-6">
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
          <SectionTitle title="Contractor performance" hint="Sorted by rating" />
          {state.contractors.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No contractors on the roster"
              body="Contractors appear here once they’re added to the fleet."
            />
          ) : (
            <Card className="overflow-hidden">
              {state.contractors
                .slice()
                .sort((a, b) => b.rating - a.rating || b.completedJobCount - a.completedJobCount)
                .map((c) => (
                  <ContractorRow key={c.id} contractor={c} />
                ))}
            </Card>
          )}
        </section>

        <section>
          <SectionTitle
            title="Recently completed"
            hint={completed.length ? "Latest work finished" : "Nothing completed yet"}
          />
          {completed.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title="No completed jobs yet"
              body="Step a job through its lifecycle in the dispatcher — it lands here when done."
            />
          ) : (
            <Card className="overflow-hidden">
              {completed
                .slice()
                .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))
                .slice(0, 5)
                .map((job) => (
                  <CompletedRow key={job.id} job={job} contractors={state.contractors} />
                ))}
            </Card>
          )}
        </section>

        {isDemoMode && <div className="flex flex-col items-end gap-2">
          {resetError && <InlineError message={resetError} className="max-w-sm" />}
          <Button variant="ghost" size="md" onClick={() => void reset()} loading={resetPending}>
            {resetPending ? "Resetting…" : "Reset demo data"}
          </Button>
        </div>}
      </div>
    </AppShell>
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

function durationMinutes(j: Job) {
  if (!j.completedAt) return 0;
  return Math.max(0, Math.round((new Date(j.completedAt).getTime() - new Date(j.createdAt).getTime()) / 60000));
}

function completedToday(jobs: Job[]) {
  const today = new Date().toDateString();
  return jobs.filter((j) => j.completedAt && new Date(j.completedAt).toDateString() === today).length;
}

function ContractorRow({ contractor: c }: { contractor: Contractor }) {
  const online = c.status === "online";
  return (
    <div className="flex items-center gap-3 border-b border-ink-100 px-4 py-3.5 transition-colors duration-150 last:border-0 hover:bg-hover">
      <Avatar name={c.name} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-semibold">
          <span className="truncate">{c.name}</span>
          <span className="flex shrink-0 items-center gap-1 text-[11px] font-semibold">
            <span
              aria-hidden="true"
              className={`inline-block size-2 rounded-full ${online ? "bg-success-500" : "bg-ink-300"}`}
            />
            <span className={online ? "text-success-600" : "text-ink-400"}>{online ? "online" : "offline"}</span>
          </span>
        </p>
        <p className="mt-0.5 truncate text-xs text-ink-500">{c.vehicleTypes.join(" · ")}</p>
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
}

function CompletedRow({ job, contractors }: { job: Job; contractors: Contractor[] }) {
  const contractor = contractors.find((c) => c.id === job.assignedContractorId);
  const Icon = SERVICE_ICONS[job.serviceType];
  return (
    <div className="flex items-center gap-3 border-b border-ink-100 px-4 py-3.5 transition-colors duration-150 last:border-0 hover:bg-hover">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-ink-50 text-ink-500">
        <Icon className="size-5" strokeWidth={2} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">
          {job.customerName} <span className="font-normal text-ink-400">·</span>{" "}
          <span className="font-medium text-ink-500">{SERVICE_LABELS[job.serviceType]}</span>
        </p>
        <p className="text-xs tabular-nums text-ink-400">
          {contractor?.name ?? "Unassigned"} · {fmtDuration(job.createdAt, job.completedAt)} · done{" "}
          {timeAgo(job.completedAt)}
        </p>
      </div>
      <StatusBadge className={`shrink-0 ${JOB_STATUS_META.completed.badge}`}>Done</StatusBadge>
    </div>
  );
}
