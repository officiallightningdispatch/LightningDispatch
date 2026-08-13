import { createFileRoute } from "@tanstack/react-router";
import { Inbox, Navigation, Phone, Route as RouteIcon, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "~/components/app-shell";
import { RealDriverPortal } from "~/components/driver-portal";
import { GateSkeleton } from "~/components/portal-gate";
import { JobStatusStepper } from "~/components/job-status-stepper";
import { InlineError } from "~/components/mutation-status";
import {
  Avatar,
  BoardSkeleton,
  Button,
  Card,
  DemoChip,
  EmptyState,
  StatusBadge,
  useToast,
} from "~/components/ui";
import type { Contractor, Job, JobStatus, ServiceType } from "~/data/seed";
import { avgResponseMinutes } from "~/lib/dispatch-recommendation";
import { JOB_STATUS_META, SERVICE_ICONS, SERVICE_LABELS, timeAgo } from "~/lib/job-ui";
import { buildNavigateUrl } from "~/lib/navigation";
import { mutationKey, useDispatchStore } from "~/lib/store";

import { authStatus } from "~/data/auth";
export const Route = createFileRoute("/driver/")({ component: ContractorView });
/** Real vs demo: a signed-in contractor gets the real driver portal; demo mode
 *  (no DATABASE_URL) keeps the seeded demo experience untouched. A FAILED auth
 *  check must never drop a real user into the demo view — it gets an honest
 *  error/retry state instead (2026-08-12: a transient authStatus() rejection
 *  was showing seeded demo data to real contractors). */
function ContractorView() {
  const [mode, setMode] = useState<"checking" | "demo" | "real" | "error">("checking");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    void authStatus().then((s) => {
      if (s.mode === "demo") setMode("demo");
      else if (s.user?.role === "contractor") setMode("real");
      else if ((s.user?.role === "owner" || s.user?.role === "admin") && s.user.driverIdentity && !s.user.driverIdentity.deactivated) setMode("real"); // owner↔contractor view toggle: staff with a driver identity drive from the same sign-in
      else setMode("error"); // signed-in non-contractor: their gate will route them
    }).catch(() => setMode("error"));
  }, [retry]);
  if (mode === "checking") return <GateSkeleton />;
  if (mode === "real") return <RealDriverPortal />;
  if (mode === "error") {
    return (
      <main className="grid min-h-dvh place-items-center bg-canvas px-4">
        <div className="w-full max-w-sm rounded-2xl border border-ink-100 bg-surface p-6 text-center shadow-card" role="alert">
          <p className="text-sm font-bold text-ink-700">Couldn&apos;t verify your session</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-500">
            We couldn&apos;t confirm your contractor account. Check your connection and try again.
          </p>
          <button
            type="button"
            onClick={() => { setMode("checking"); setRetry((n) => n + 1); }}
            className="mt-4 inline-flex h-10 items-center justify-center rounded-xl bg-brand-500 px-5 text-sm font-bold text-white transition-colors hover:bg-brand-600"
          >
            Retry
          </button>
        </div>
      </main>
    );
  }
  return <DemoContractorView />;
}

/** Persisted contractor identity — the demo has no login, so the demo user
 *  picks which seeded contractor they are acting as. */
const IDENTITY_KEY = "lightning-contractor-identity-v1";

/** Flat DEMO rate per completed service. NOT the real compensation engine —
 *  payroll/compensation is a later phase. Clearly labeled in the UI. */
const DEMO_RATE: Record<ServiceType, number> = {
  jump_start: 85,
  tire_change: 85,
  lockout: 85,
  flatbed_tow: 160,
  fuel_delivery: 160,
  battery_install: 45,
};

/** Contextual primary action for the current step of an active job. */
const NEXT_STEP_ACTION: Partial<Record<JobStatus, { label: string; sub: string; toast: string }>> = {
  accepted: {
    label: "Start service · en route",
    sub: "Mark that you're heading to the customer",
    toast: "Marked en route — heading to the customer",
  },
  en_route: {
    label: "Arrived on scene",
    sub: "Confirm you're at the location",
    toast: "Arrived on scene",
  },
  arrived: {
    label: "Complete job",
    sub: "Close out the job",
    toast: "Job completed — demo earnings updated",
  },
};

const ACTIVE_JOB_STATUSES: JobStatus[] = ["accepted", "en_route", "arrived"];

function DemoContractorView() {
  return (
    <AppShell portal="driver" title="Contractor home" description="Go online, accept offers, and work jobs from the road.">
      <ContractorWorkspace />
    </AppShell>
  );
}

function ContractorWorkspace() {
  const { state, loading, setContractorStatus, advanceJob, declineJob, isPending, getError } = useDispatchStore();
  const toast = useToast();
  const [identity, setIdentity] = useState<string | null>(null);
  const statusKey = identity ? mutationKey.status(identity) : null;
  const statusPending = statusKey ? isPending(statusKey) : false;
  const statusError = statusKey ? getError(statusKey) : null;

  // Restore the persisted identity once contractors are loaded; default to an
  // online one. The chosen identity is persisted (including the default) so a
  // refresh keeps the same actor even if their status changed in the store.
  useEffect(() => {
    if (identity !== null || loading) return;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(IDENTITY_KEY);
    } catch {
      // ignore
    }
    const known = state.contractors.some((c) => c.id === saved);
    const fallback =
      state.contractors.find((c) => c.status === "online")?.id ?? state.contractors[0]?.id ?? null;
    const chosen = known && saved ? saved : fallback;
    if (chosen && (!saved || !known)) {
      try {
        localStorage.setItem(IDENTITY_KEY, chosen);
      } catch {
        // ignore
      }
    }
    setIdentity(chosen);
  }, [identity, loading, state.contractors]);

  const chooseIdentity = (id: string) => {
    setIdentity(id);
    try {
      localStorage.setItem(IDENTITY_KEY, id);
    } catch {
      // ignore
    }
  };

  const contractor = useMemo(
    () => state.contractors.find((c) => c.id === identity) ?? null,
    [state.contractors, identity],
  );

  // Only the selected contractor's offers and jobs — the view is role-filtered.
  const offers = useMemo(
    () =>
      state.jobs.filter((j) => j.status === "offered" && j.assignedContractorId === contractor?.id),
    [state.jobs, contractor],
  );

  const activeJobs = useMemo(
    () =>
      state.jobs
        .filter(
          (j) =>
            ACTIVE_JOB_STATUSES.includes(j.status) && j.assignedContractorId === contractor?.id,
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [state.jobs, contractor],
  );

  const completed = useMemo(
    () =>
      state.jobs.filter(
        (j) => j.status === "completed" && j.assignedContractorId === contractor?.id,
      ),
    [state.jobs, contractor],
  );

  if (loading || !contractor) {
    return <BoardSkeleton rows={2} />;
  }

  const online = contractor.status === "online";
  const demoEarnings = completed.reduce((sum, j) => sum + DEMO_RATE[j.serviceType], 0);

  const toggleStatus = async () => {
    const target = contractor.status === "online" ? "offline" : "online";
    const ok = await setContractorStatus(contractor.id, target);
    if (ok) {
      toast(
        target === "online"
          ? "You're online — back in the offer pool"
          : "You're offline — out of the offer pool",
      );
    }
  };

  return (
    <div className="space-y-8">
      <IdentityCard
        contractor={contractor}
        contractors={state.contractors}
        onSelect={chooseIdentity}
        online={online}
        statusPending={statusPending}
        statusError={statusError}
        onToggle={() => void toggleStatus()}
      />

      <section>
        <SectionTitle
          title="Active job"
          hint={activeJobs.length ? "The customer is waiting — keep it moving." : "Nothing in progress."}
        />
        {activeJobs.length === 0 ? (
          <EmptyState
            icon={RouteIcon}
            title={!online ? "Go online to get offers" : "No active job right now"}
            body={
              online
                ? "Accept an offer below and the job shows up here."
                : "Go online — the AI only offers jobs to available contractors."
            }
          />
        ) : (
          <div className="space-y-4">
            {activeJobs.map((job) => (
              <ActiveJobCard key={job.id} job={job} onAdvance={advanceJob} />
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionTitle
          title="Job offers"
          hint={offers.length ? "New offers land here first." : "Nothing waiting."}
        />
        {offers.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="No offers right now"
            body={
              online
                ? "When a dispatcher assigns you, the offer appears here. Accept it to start working."
                : "You're offline, so you're out of the pool. Go online to get offers."
            }
          />
        ) : (
          <div className="space-y-4">
            {offers.map((job) => (
              <OfferCard
                key={job.id}
                job={job}
                onAccept={() => advanceJob(job.id)}
                onDecline={() => declineJob(job.id)}
              />
            ))}
          </div>
        )}
      </section>

      <StatsCard contractor={contractor} completedInDemo={completed.length} demoEarnings={demoEarnings} />
    </div>
  );
}

/* --------------------------- identity + availability -------------------------- */

function IdentityCard({
  contractor,
  contractors,
  onSelect,
  online,
  statusPending,
  statusError,
  onToggle,
}: {
  contractor: Contractor;
  contractors: Contractor[];
  onSelect: (id: string) => void;
  online: boolean;
  statusPending: boolean;
  statusError: string | null;
  onToggle: () => void;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-start gap-3 p-4 pb-3">
        <Avatar name={contractor.name} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="font-bold leading-tight">{contractor.name}</h2>
            <StatusBadge
              dot
              className={
                online ? "bg-success-100 text-success-700" : "bg-ink-100 text-ink-500"
              }
            >
              {online ? "online" : "offline"}
            </StatusBadge>
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-ink-500">
            <span>{contractor.vehicleTypes.join(" · ")}</span>
            <span className="inline-flex items-center gap-0.5">
              <Star className="size-3.5 fill-accent-500 text-accent-500" aria-hidden="true" />
              <span className="tabular-nums">{contractor.rating.toFixed(1)}</span>
            </span>
            <span>· based in {contractor.location.area}</span>
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-ink-100 px-4 py-3 sm:flex-row sm:items-center sm:gap-3">
        <label htmlFor="contractor-identity" className="shrink-0 text-xs font-semibold text-ink-500">
          Acting as
        </label>
        <select
          id="contractor-identity"
          value={contractor.id}
          onChange={(e) => onSelect(e.target.value)}
          className="h-11 w-full rounded-xl border border-ink-200 bg-surface px-3.5 text-sm text-ink-900 transition-colors duration-150 focus:border-brand-500 focus:outline-2 focus:outline-brand-500/40 sm:min-w-0 sm:flex-1"
        >
          {contractors.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} — {c.rating.toFixed(1)} rating · {c.vehicleTypes[0] ?? "roadside"} · {c.status}
            </option>
          ))}
        </select>
      </div>

      <div className="border-t border-ink-100 p-3">
        <button
          onClick={onToggle}
          disabled={statusPending}
          aria-pressed={online}
          className={`flex h-12 w-full items-center gap-3 rounded-xl px-4 text-left transition-colors duration-150 active:scale-[0.99] motion-reduce:transform-none disabled:cursor-not-allowed disabled:opacity-60 ${
            online ? "bg-success-50 ring-1 ring-success-200" : "bg-ink-50 ring-1 ring-ink-200"
          }`}
        >
          <span
            aria-hidden="true"
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
              online ? "bg-success-500" : "bg-ink-300"
            }`}
          >
            <span
              className={`inline-block size-4 transform rounded-full bg-white shadow transition-transform ${
                online ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </span>
          <span className="min-w-0 flex-1">
            <span className={`block text-sm font-bold ${online ? "text-success-800" : "text-ink-600"}`}>
              {statusPending
                ? "Updating availability…"
                : online
                  ? "Online — receiving offers"
                  : "Offline — tap to go online"}
            </span>
            <span className="block text-xs text-ink-500">
              {online
                ? "You're in the pool — the dispatcher's AI can offer you jobs."
                : "You're out of the pool — no new offers until you're online."}
            </span>
          </span>
        </button>
        {statusError && <InlineError message={statusError} className="mt-2" />}
      </div>
    </Card>
  );
}

/* --------------------------------- offers --------------------------------- */

function OfferCard({
  job,
  onAccept,
  onDecline,
}: {
  job: Job;
  onAccept: () => Promise<boolean>;
  onDecline: () => Promise<boolean>;
}) {
  const { isPending, getError } = useDispatchStore();
  const toast = useToast();
  const acceptPending = isPending(mutationKey.advance(job.id));
  const declinePending = isPending(mutationKey.decline(job.id));
  const acceptError = getError(mutationKey.advance(job.id));
  const declineError = getError(mutationKey.decline(job.id));
  const error = acceptError ?? declineError;

  const accept = async () => {
    const ok = await onAccept();
    if (ok) toast(`Offer accepted — ${job.customerName} is yours`);
  };

  const ServiceIcon = SERVICE_ICONS[job.serviceType];
  return (
    <Card className="overflow-hidden">
      <div className="flex items-start gap-3 p-4 pb-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
          <ServiceIcon className="size-5" strokeWidth={2} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="font-bold leading-tight">{job.customerName}</h3>
            <StatusBadge className={JOB_STATUS_META.offered.badge}>
              {JOB_STATUS_META.offered.label}
            </StatusBadge>
            <span className="text-[11px] font-medium tabular-nums text-ink-400">
              created {timeAgo(job.createdAt)}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-ink-600">
            {SERVICE_LABELS[job.serviceType]} · {job.location.area}
          </p>
          <p className="mt-1 text-xs text-ink-400">{job.note}</p>
          {job.assignedAt && (
            <p className="mt-1 text-[11px] font-semibold tabular-nums text-accent-600">
              offered {timeAgo(job.assignedAt)}
            </p>
          )}
        </div>
      </div>
      <div className="flex gap-2 border-t border-ink-100 p-3">
        <Button className="flex-1" onClick={() => void accept()} loading={acceptPending}>
          {acceptPending ? "Accepting…" : "Accept"}
        </Button>
        <Button
          variant="danger-ghost"
          onClick={() => void onDecline()}
          loading={declinePending}
          className="border border-danger-100"
        >
          {declinePending ? "Declining…" : "Decline"}
        </Button>
      </div>
      {error && (
        <div className="border-t border-danger-100 p-3">
          <InlineError message={error} />
          <p className="mt-1.5 text-[11px] text-ink-400">Tap the action again to retry.</p>
        </div>
      )}
    </Card>
  );
}

/* ------------------------------- active job ------------------------------- */

function ActiveJobCard({ job, onAdvance }: { job: Job; onAdvance: (jobId: string) => Promise<boolean> }) {
  const step = NEXT_STEP_ACTION[job.status];
  const phoneDigits = job.phone.replace(/\D/g, "");
  const [ua, setUa] = useState("");
  useEffect(() => {
    if (typeof navigator !== "undefined") setUa(navigator.userAgent);
  }, []);
  // Platform-aware one-tap maps deep link (owner-directed 2026-08-13): coords
  // when present, address query when not — iOS → Apple Maps, Android → Google
  // Maps, desktop → Google Maps search.
  const navUrl = buildNavigateUrl(job.location.lat, job.location.lng, job.location.area, ua);
  const meta = JOB_STATUS_META[job.status];
  const { isPending, getError } = useDispatchStore();
  const toast = useToast();
  const advancePending = isPending(mutationKey.advance(job.id));
  const advanceError = getError(mutationKey.advance(job.id));

  const advance = async () => {
    const ok = await onAdvance(job.id);
    if (ok && step) toast(step.toast);
  };

  const ServiceIcon = SERVICE_ICONS[job.serviceType];
  return (
    <Card className="overflow-hidden">
      <div className="flex items-start gap-3 p-4 pb-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
          <ServiceIcon className="size-5" strokeWidth={2} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="font-bold leading-tight">{job.customerName}</h3>
            <StatusBadge className={meta.badge}>{meta.label}</StatusBadge>
          </div>
          <p className="mt-0.5 text-sm text-ink-600">
            {SERVICE_LABELS[job.serviceType]} · {job.location.area}
          </p>
          <p className="mt-1 text-xs tabular-nums text-ink-400">
            created {timeAgo(job.createdAt)}
            {job.assignedAt ? ` · offered ${timeAgo(job.assignedAt)}` : ""}
            {job.arrivedAt ? ` · arrived ${timeAgo(job.arrivedAt)}` : ""}
          </p>
        </div>
      </div>

      <div className="mx-4 rounded-xl border border-ink-100 bg-ink-50 p-3">
        <dl className="space-y-2 text-sm">
          <div className="flex items-center justify-between gap-3">
            <dt className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-ink-400">Job</dt>
            <dd className="min-w-0 text-right text-xs font-medium tabular-nums text-ink-600">{job.id}</dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-ink-400">Phone</dt>
            <dd className="min-w-0 text-right">
              <a
                href={`tel:${phoneDigits}`}
                className="font-semibold text-ink-900 underline decoration-ink-200 underline-offset-2 transition-colors duration-150 hover:text-brand-600"
              >
                {job.phone}
              </a>
            </dd>
          </div>
          <div className="flex items-start justify-between gap-3">
            <dt className="shrink-0 pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-ink-400">Location</dt>
            <dd className="text-right">
              <span className="block font-semibold">{job.location.area}</span>
              <span className="block text-xs tabular-nums text-ink-500">
                {job.location.lat.toFixed(4)}, {job.location.lng.toFixed(4)}
              </span>
            </dd>
          </div>
          <div className="flex items-start justify-between gap-3">
            <dt className="shrink-0 pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-ink-400">Note</dt>
            <dd className="min-w-0 text-right text-xs text-ink-600">{job.note}</dd>
          </div>
        </dl>
      </div>

      <div className="mt-4 px-4">
        <JobStatusStepper status={job.status} />
      </div>

      <div className="mt-4 flex items-stretch gap-2 border-t border-ink-100 p-3">
        {step && (
          <Button className="min-w-0 flex-1" onClick={() => void advance()} loading={advancePending}>
            {advancePending ? "Updating…" : step.label}
          </Button>
        )}
        <a
          href={navUrl ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
          title="Open directions in your maps app"
          className="grid h-11 w-12 shrink-0 place-items-center rounded-xl border border-ink-200 bg-surface text-ink-600 transition-colors duration-150 hover:bg-hover hover:text-brand-600"
        >
          <Navigation className="size-5" strokeWidth={2} aria-hidden="true" />
          <span className="sr-only">Open directions in your maps app</span>
        </a>
        <a
          href={`tel:${phoneDigits}`}
          title={`Call ${job.customerName}`}
          className="grid h-11 w-12 shrink-0 place-items-center rounded-xl border border-ink-200 bg-surface text-ink-600 transition-colors duration-150 hover:bg-hover hover:text-brand-600"
        >
          <Phone className="size-5" strokeWidth={2} aria-hidden="true" />
          <span className="sr-only">Call {job.customerName}</span>
        </a>
      </div>
      {advanceError && (
        <div className="border-t border-danger-100 p-3">
          <InlineError message={advanceError} />
          <p className="mt-1.5 text-[11px] text-ink-400">Tap the action again to retry.</p>
        </div>
      )}
    </Card>
  );
}

/* --------------------------------- stats --------------------------------- */

function StatsCard({
  contractor,
  completedInDemo,
  demoEarnings,
}: {
  contractor: Contractor;
  completedInDemo: number;
  demoEarnings: number;
}) {
  const avg = Math.round(avgResponseMinutes(contractor));
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-lg font-bold tracking-tight">My stats</h2>
        <DemoChip>demo data</DemoChip>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <StatBox label="Jobs completed" value={String(contractor.completedJobCount)} />
        <StatBox label="Rating" value={contractor.rating.toFixed(1)} />
        <StatBox label="Avg response" value={`${avg} min`} />
      </div>
      <div className="mt-3 rounded-xl border border-ink-100 bg-surface p-3.5">
        <p className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-semibold text-ink-500">This week · demo earnings</span>
          <span className="text-lg font-black tabular-nums text-brand-600">${demoEarnings}</span>
        </p>
        <p className="mt-0.5 text-[11px] text-ink-400">
          {completedInDemo > 0 && (
            <>
              {completedInDemo} completed job{completedInDemo === 1 ? "" : "s"} in this demo ·{" "}
            </>
          )}
          Flat demo rate (${DEMO_RATE.jump_start}/${DEMO_RATE.flatbed_tow}) — the real pay engine is a
          later phase.
        </p>
      </div>
    </Card>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-ink-50 p-3 text-center">
      <p className="text-lg font-black leading-none tabular-nums text-ink-900">{value}</p>
      <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-ink-400">{label}</p>
    </div>
  );
}

/* --------------------------------- bits --------------------------------- */

function SectionTitle({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-1">
      <h2 className="text-lg font-bold tracking-tight">{title}</h2>
      <p className="text-xs text-ink-500">{hint}</p>
    </div>
  );
}
