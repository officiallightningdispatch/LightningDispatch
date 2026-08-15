/**
 * In-app notifications with sound (backlog #1, owner-directed 2026-08-11).
 *
 * Three triggers, all rendered as a branded, mobile-first banner stack that
 * slides in below the app header (fixed, top-16, z-40):
 *   1. OWNER — a NEW job arrives (id not seen this session) →
 *      "New job — <customer> · <service> · <area>", tap → /owner/queue.
 *   2. OWNER — the AI dispatcher ESCALATES (new ai_dispatcher_decisions row
 *      whose decision starts with `escalated_`, incl. the session-expired
 *      contractor-push failure) → alert-styled banner with the reason text,
 *      tap → /owner/ai-dispatcher. Fires once per decision id.
 *   3. DRIVER — a NEW job appears in the signed-in driver's queue mid-session
 *      → "New job assigned", tap dismisses (the card is on the same page).
 *
 * Each banner plays ONE synthesized lightning strike (Web Audio, sound.ts),
 * auto-dismisses after ~7s, has a manual close, and stacks when several
 * arrive together. Sound respects the per-role mute toggle (localStorage) and
 * the browser autoplay policy (primed on the first user gesture; blocked →
 * banner-only fallback, silent).
 *
 * No-fire-on-first-load: the first successful poll SEEDS the seen-set with
 * everything currently visible, so nothing on screen at login ever fires.
 * Seen-sets live in a module ref + localStorage (notify-seen.ts) and are
 * bounded to ~200 ids (notify.ts mergeSeen).
 */

import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Volume2, VolumeX, X, XCircle, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SERVICE_LABELS } from "~/lib/job-ui";
import { diffCancelledJobIds, diffEscalatedDecisionIds, diffNewCashoutIds, diffNewJobIds, formatCountdown, mergeSeen, reconcileEscalatedBanner, type NotifyCall } from "~/lib/notify";
import { getSeenIds, seenKey, setSeenIds } from "~/lib/notify-seen";
import { playAlertSound, primeAudio, soundMuted, toggleSoundMuted, type SoundRole } from "~/lib/sound";
import { etaMinutesLabel } from "~/components/driver-eta";
import { useDispatchStore } from "~/lib/store";
import { listAiDispatcherDecisions } from "~/data/server";
import { listTipCashoutRequests } from "~/data/tip-cashout";

export type BannerKind = "job" | "escalation" | "cancelled" | "assignment" | "completed" | "cashout";

/** Routes banners can navigate to (typed so navigate() typechecks). */
export type BannerTarget = "/owner/queue" | "/owner/ai-dispatcher" | "/owner/money" | "/driver";

export type BannerItem = {
  /** Unique key — job:LDID / esc:DECISIONID / driverjob:CALLID */
  id: string;
  kind: BannerKind;
  title: string;
  body: string;
  /** Route to navigate to when the banner is tapped. */
  to: BannerTarget;
  /** Assignment banners carry the ETA pill label (etaMinutesLabel). */
  etaLabel?: string | null;
  /** Grounded expiry; when absent, createdAt + 180s is explicitly estimated. */
  countdown?: { expiresAt: number; estimated: boolean } | null;
  /** Backend-confirmed resolution; resolved banners retain local dismissal only. */
  resolution?: "claimed" | "expired";
};

const AUTO_DISMISS_MS = 7000;
const MAX_STACK = 5;

/* ------------------------------ sound toggle ------------------------------ */

/** Small speaker button bound to the role's persisted mute toggle. */
export function SoundToggle({ role, className = "" }: { role: SoundRole; className?: string }) {
  const [muted, setMuted] = useState(() => soundMuted(role));
  const onToggle = () => setMuted(toggleSoundMuted(role));
  const Icon = muted ? VolumeX : Volume2;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={!muted}
      aria-label={muted ? "Unmute notification sounds" : "Mute notification sounds"}
      title={muted ? "Notification sound: off" : "Notification sound: on"}
      className={`inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-ink-500 transition-colors duration-150 hover:bg-ink-50 hover:text-ink-700 active:scale-[0.97] ${className}`}
    >
      <Icon className="size-4" aria-hidden="true" />
    </button>
  );
}

/* ------------------------------ banner stack ------------------------------ */

function useBannerStack(role: SoundRole) {
  const [banners, setBanners] = useState<BannerItem[]>([]);
  const timeouts = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const setBannerResolutions = useCallback((decisions: readonly { id: string; offerStatus?: "claimed" | "expired" | "unknown"; offerExpiresAt?: string | null }[]) => {
    setBanners((prev) => prev.map((b) => {
      if (b.kind !== "escalation") return b;
      const id = b.id.slice(4); const d = decisions.find((x) => x.id === id);
      const resolution = d ? reconcileEscalatedBanner(d) : null;
      if (!resolution) return b;
      return { ...b, resolution, countdown: null, title: resolution === "claimed" ? "Offer claimed in Towbook" : "Offer expired — no action was recorded", body: "" };
    }));
  }, []);

  const dismiss = useCallback((id: string) => {
    setBanners((prev) => prev.filter((b) => b.id !== id));
    const t = timeouts.current.get(id);
    if (t) { clearTimeout(t); timeouts.current.delete(id); }
  }, []);

  const push = useCallback((items: BannerItem[]) => {
    if (!items.length) return;
    setBanners((prev) => [...prev, ...items].slice(-MAX_STACK));
    // One alert per notification — never a loop. The OWNER'S EXACT MP3
    // (playAlertSound; synthesized fallback if the asset is blocked).
    for (const _ of items) playAlertSound(role);
    for (const it of items) {
      const t = setTimeout(() => dismiss(it.id), AUTO_DISMISS_MS);
      timeouts.current.set(it.id, t);
    }
  }, [role, dismiss]);

  useEffect(() => () => { for (const t of timeouts.current.values()) clearTimeout(t); }, []);

  return { banners, push, dismiss, setBannerResolutions };
}

/** Shared renderer: fixed stack under the app header. Slide-in animation
 *  (notify-in keyframe in app.css), tap-through navigation, manual close. */
function BannerStack({
  role,
  banners,
  onDismiss,
  showSoundToggle,
}: {
  role: SoundRole;
  banners: BannerItem[];
  onDismiss: (id: string) => void;
  showSoundToggle?: boolean;
}) {
  const nav = useNavigate();
  const [, setClock] = useState(() => Date.now());
  useEffect(() => { if (!banners.some((b) => b.countdown)) return; const t = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(t); }, [banners]);
  if (banners.length === 0) return null;
  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-16 z-40 flex flex-col items-center gap-2 px-3 sm:items-end sm:px-6"
      role="region"
      aria-label="Notifications"
    >
      {showSoundToggle && (
        <div className="pointer-events-auto flex w-full max-w-md items-center justify-between rounded-full border border-ink-100 bg-surface/95 px-3 py-1 shadow-card backdrop-blur sm:max-w-sm">
          <span className="text-[11px] font-bold uppercase tracking-wider text-ink-400">
            {banners.length} notification{banners.length === 1 ? "" : "s"}
          </span>
          <SoundToggle role={role} />
        </div>
      )}
      {banners.map((b) => (
        <div
          key={b.id}
          role="status"
          className={`pointer-events-auto w-full max-w-md animate-[notify-in_0.25s_ease-out] overflow-hidden rounded-2xl border shadow-card ${
            b.kind === "escalation" ? "border-danger-200 bg-danger-50" : b.kind === "cancelled" ? "border-accent-200 bg-accent-50" : b.kind === "cashout" ? "border-success-200 bg-success-50" : "border-brand-200 bg-surface"
          }`}
        >
          <div className="flex items-stretch">
            <button
              type="button"
              onClick={() => { void nav({ to: b.to }); onDismiss(b.id); }}
              className="flex min-w-0 flex-1 items-start gap-3 p-3.5 text-left"
            >
              <span
                className={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg ${
                  b.kind === "escalation" ? "bg-danger-100 text-danger-600" : b.kind === "cancelled" ? "bg-accent-100 text-accent-700" : b.kind === "cashout" ? "bg-success-100 text-success-700" : b.kind === "assignment" ? "bg-brand-500 text-white" : "bg-brand-50 text-brand-600"
                }`}
              >
                {b.kind === "escalation" ? (
                  <AlertTriangle className="size-4" aria-hidden="true" />
                ) : b.kind === "cancelled" ? (
                  <XCircle className="size-4" aria-hidden="true" />
                ) : (
                  <Zap className="size-4" fill="currentColor" strokeWidth={0} aria-hidden="true" />
                )}
              </span>
              <span className="flex min-w-0 flex-1 items-center gap-3">
                <span className="min-w-0 flex-1">
                  <span className={`block text-sm font-bold ${b.kind === "escalation" ? "text-danger-700" : b.kind === "cancelled" ? "text-accent-800" : "text-ink-900"}`}>
                    {b.title}
                  </span>
                  <span className={`mt-0.5 block text-xs leading-snug ${b.kind === "escalation" ? "text-danger-700/90" : b.kind === "cancelled" ? "text-accent-800/90" : "text-ink-500"}`}>
                    {b.body}
                    {b.countdown && (() => {
                      const remaining = Math.max(0, Math.ceil((b.countdown.expiresAt - Date.now()) / 1000));
                      const label = formatCountdown(remaining) ?? "00:00";
                      return <span className="mt-1 inline-flex rounded-full bg-danger-100 px-2 py-0.5 text-xs font-bold tabular-nums text-danger-700" aria-label={`${b.countdown.estimated ? "Estimated time remaining" : "Expires in"} ${label}`}>
                        {b.countdown.estimated ? "Estimated time remaining" : "Expires in"} {label}
                      </span>;
                    })()}
                  </span>
                </span>
                {b.etaLabel && b.kind === "assignment" && (
                  <span className="inline-flex shrink-0 items-center rounded-full bg-brand-50 px-2.5 py-1 text-xs font-bold tabular-nums text-brand-700">
                    {b.etaLabel}
                  </span>
                )}
              </span>
            </button>
            <button
              type="button"
              onClick={() => onDismiss(b.id)}
              aria-label="Dismiss notification"
              className="grid size-9 shrink-0 place-items-center self-start rounded-lg p-2 text-ink-400 hover:bg-ink-50 hover:text-ink-600"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Prime the AudioContext on the first user gesture anywhere (once). */
function useAudioPrimer() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onGesture = () => primeAudio();
    window.addEventListener("pointerdown", onGesture);
    window.addEventListener("keydown", onGesture);
    return () => {
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
    };
  }, []);
}

/* --------------------------- owner notification layer --------------------------- */

/**
 * Mounted once in the /owner layout. Polls the SAME plumbing the owner portal
 * already uses (getDispatchData via the store's refresh — which also keeps the
 * queue live — plus listAiDispatcherDecisions escalated-only), diffs against
 * the seen-set, and raises job + escalation banners. Demo mode is skipped
 * entirely (there is no live feed to watch).
 */
export function OwnerNotificationLayer() {
  const { refresh } = useDispatchStore();
  const { banners, push, dismiss, setBannerResolutions } = useBannerStack("owner");
  const booted = useRef(false);
  const previousJobs = useRef<Map<string, string>>(new Map());
  useAudioPrimer();

  const jobsKey = seenKey("owner", "jobs");
  const decisionsKey = seenKey("owner", "decisions");
  const cashoutsKey = seenKey("owner", "cashouts");

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        // refresh() re-hydrates the store so a tapped banner lands on a queue
        // that actually shows the job — and returns the fresh payload for
        // arrival detection. null outside database mode / on a transient
        // failure — in that case leave the seen-set untouched so a later tick
        // still bootstraps cleanly (no burst).
        const data = await refresh();
        const decisions = await listAiDispatcherDecisions({ data: { escalatedOnly: true, limit: 20 } });
        const cashoutResult = await listTipCashoutRequests();
        if (stop || !data) return;
        const cashouts = cashoutResult.ok ? cashoutResult.data.open : [];

        const jobs = (data?.jobs ?? []).map((j) => ({
          id: j.id,
          customerName: j.customerName,
          serviceType: j.serviceType,
          area: j.location?.area ?? null,
        }));

        if (!booted.current) {
          // First poll: seed everything visible — nothing on screen fires.
          setSeenIds(jobsKey, mergeSeen(getSeenIds(jobsKey), jobs.map((j) => j.id)));
          setSeenIds(decisionsKey, mergeSeen(getSeenIds(decisionsKey), decisions.map((d) => d.id)));
          setSeenIds(cashoutsKey, mergeSeen(getSeenIds(cashoutsKey), cashouts.map((c) => c.id)));
          previousJobs.current = new Map(jobs.map((j) => [j.id, String((data?.jobs ?? []).find((raw) => raw.id === j.id)?.status ?? "")]));
          booted.current = true;
          return;
        }

        const newJobs = diffNewJobIds(getSeenIds(jobsKey), jobs);
        const completedJobs = jobs.filter((j) => previousJobs.current.get(j.id) !== "completed" && (data?.jobs ?? []).find((raw) => raw.id === j.id)?.status === "completed");
        previousJobs.current = new Map(jobs.map((j) => [j.id, String((data?.jobs ?? []).find((raw) => raw.id === j.id)?.status ?? "")]));
        // Reconcile only active escalation banners. This never changes the
        // decision or seen-set; it updates the local presentation from refreshed
        // dispatch/Towbook evidence.
        setBannerResolutions(decisions);
        const newDecs = diffEscalatedDecisionIds(getSeenIds(decisionsKey), decisions);
        const newCashouts = diffNewCashoutIds(getSeenIds(cashoutsKey), cashouts);
        if (newJobs.length) setSeenIds(jobsKey, mergeSeen(getSeenIds(jobsKey), newJobs.map((j) => j.id)));
        if (newDecs.length) setSeenIds(decisionsKey, mergeSeen(getSeenIds(decisionsKey), newDecs.map((d) => d.id)));
        if (newCashouts.length) setSeenIds(cashoutsKey, mergeSeen(getSeenIds(cashoutsKey), newCashouts.map((c) => c.id)));

        const items: BannerItem[] = [];
        for (const j of newJobs) {
          const raw = (data?.jobs ?? []).find((candidate) => candidate.id === j.id);
          items.push({
            id: `job:${j.id}`,
            kind: "job",
            title: `New job${raw?.towbookJobId ? ` #${raw.towbookJobId}` : raw?.id ? ` #${raw.id}` : ""}`,
            body: `${j.customerName ?? "Customer"} · ${SERVICE_LABELS[j.serviceType as keyof typeof SERVICE_LABELS] ?? "Service"} · ${j.area ?? "—"}${raw?.assignedDriverName ? ` · ${raw.assignedDriverName}` : ""}`,
            to: "/owner/queue",
          });
        }
        for (const j of completedJobs) {
          const raw = (data?.jobs ?? []).find((candidate) => candidate.id === j.id);
          items.push({
            id: `completed:${j.id}`,
            kind: "completed",
            title: `Job completed${raw?.towbookJobId ? ` #${raw.towbookJobId}` : raw?.id ? ` #${raw.id}` : ""}`,
            body: `${j.customerName ?? "Customer"} · ${SERVICE_LABELS[j.serviceType as keyof typeof SERVICE_LABELS] ?? "Service"} · ${j.area ?? "—"}${raw?.assignedDriverName ? ` · ${raw.assignedDriverName}` : ""} · status: completed`,
            to: "/owner/queue",
          });
        }
        const reasonCopy: Record<string, string> = {
          escalated_unexpected_shape: "Towbook offer format needs a human review.",
          escalated_missing_coords: "Offer has no usable location; claim it in Towbook.",
          escalated_accept_failed: "Automatic acceptance failed; claim it in Towbook.",
          escalated_dispatch_failed: "Dispatch verification failed; review and claim it in Towbook.",
          escalated_driver_lookup_failed: "Driver lookup failed; review and claim it in Towbook.",
          escalated_state_unknown: "Driver/job state could not be verified; review in Towbook.",
          escalated_cross_state: "Cross-state assignment was blocked; review in Towbook.",
        };
        for (const d of newDecs) {
          const authoritative = d.offerExpiresAt ? Date.parse(d.offerExpiresAt) : NaN;
          const created = Date.parse(d.createdAt);
          const expiry = Number.isFinite(authoritative) ? authoritative : Number.isFinite(created) ? created + 180_000 : NaN;
          const rejectedTow = d.decision === "rejected_tow_no_eligible_driver";
          items.push({
            id: `esc:${d.id}`, kind: "escalation", title: rejectedTow ? "REJECTED TOW JOB" : "Offer needs your attention",
            body: rejectedTow
              ? `Call ${d.callId ?? d.callRequestId}${d.customerName ? ` · ${d.customerName}` : ""}${d.location ? ` · ${d.location}` : ""} · ${d.reason}`
              : `${reasonCopy[d.reason ?? ""] ?? "Offer needs a human review."}${d.callRequestId ? ` Offer ${d.callRequestId}` : ""}${Number.isFinite(expiry) ? "" : " Expiry time unavailable — open Towbook now"}`,
            countdown: rejectedTow ? null : (Number.isFinite(expiry) ? { expiresAt: expiry, estimated: !Number.isFinite(authoritative) } : null),
            to: "/owner/ai-dispatcher",
          });
        }
        for (const c of newCashouts) {
          const dollars = (Number(c.amountCents ?? 0) / 100).toLocaleString(undefined, { style: "currency", currency: "USD" });
          items.push({
            id: `cashout:${c.id}`,
            kind: "cashout",
            title: "Tip cash-out request",
            body: `${c.contractorName?.trim() || "Contractor"} · ${dollars} · ${c.rail === "cash_app" ? "Cash App" : c.rail ? c.rail.charAt(0).toUpperCase() + c.rail.slice(1) : "Payout"}`,
            to: "/owner/money",
          });
        }
        if (items.length) push(items);
      } catch {
        /* transient poll failure — never break the loop */
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 5000);
    return () => { stop = true; clearInterval(t); };
  }, [refresh, jobsKey, decisionsKey, cashoutsKey, push]);

  return <BannerStack role="owner" banners={banners} onDismiss={dismiss} showSoundToggle />;
}

/* --------------------------- driver notification banners --------------------------- */

/**
 * Mounted inside the real driver portal. Hooks into the portal's existing
 * 20s queue poll: whenever `calls` changes, diff new call ids against the
 * seen-set and raise a "New job assigned" banner for each arrival. The first
 * successful load seeds the set (no burst on sign-in).
 */
export function DriverNotificationBanners({ calls, showSoundToggle = false }: { calls: readonly NotifyCall[] | null; showSoundToggle?: boolean }) {
  const { banners, push, dismiss } = useBannerStack("driver");
  const booted = useRef(false);
  // Previous queue snapshot — used to spot live→cancelled transitions.
  const prevCalls = useRef<readonly { id: string }[] | null>(null);
  useAudioPrimer();
  const key = seenKey("driver", "jobs");
  const cancelledKey = seenKey("driver", "cancelled");

  useEffect(() => {
    // `calls` starts null (not loaded yet). The FIRST successful response —
    // empty or not — bootstraps the seen-set: nothing already in the queue at
    // sign-in ever fires. A job that lands AFTER that first response fires.
    if (calls === null || calls === undefined) return;
    if (!booted.current) {
      booted.current = true;
      setSeenIds(key, mergeSeen(getSeenIds(key), calls.map((c) => c.id)));
      prevCalls.current = calls;
      return;
    }
    const prev = prevCalls.current;
    prevCalls.current = calls;

    const added = diffNewJobIds(getSeenIds(key), calls.map((c) => ({ id: c.id })));
    if (added.length) {
      setSeenIds(key, mergeSeen(getSeenIds(key), added.map((j) => j.id)));
      const byId = new Map(calls.map((c) => [c.id, c]));
      push(
        added.map((j) => {
          const call = byId.get(j.id) as NotifyCall | undefined;
          const body = [call?.serviceName, [call?.pickupAddress, call?.zip].filter(Boolean).join(", ")]
            .filter(Boolean)
            .join(" · ");
          return {
            id: `driverjob:${j.id}`,
            kind: "assignment",
            title: "New job — Lightning Dispatch",
            body: body || "A new job landed in your queue.",
            to: "/driver",
            etaLabel: call?.arrivalETA ? etaMinutesLabel({ arrivalETA: call.arrivalETA }) : null,
          };
        }),
      );
    }

    // Cancellation notice (owner-directed 2026-08-12, "like Uber — notify the
    // driver and move it to history"): a job the driver was live on (offered →
    // towing) that is now cancelled (255) or gone from the queue fires once per
    // call id. The banner carries the pickup/vehicle context from the previous
    // snapshot.
    const cancelled = prev ? diffCancelledJobIds(prev as NotifyCall[], calls as NotifyCall[]) : [];
    if (cancelled.length) {
      const already = new Set(getSeenIds(cancelledKey));
      const unseen = cancelled.filter((c) => !already.has(c.id));
      if (unseen.length) {
        setSeenIds(cancelledKey, mergeSeen(getSeenIds(cancelledKey), unseen.map((c) => c.id)));
        push(
          unseen.map((c) => {
            const body = [c.serviceName, [c.pickupAddress, c.zip].filter(Boolean).join(", "), c.vehicle]
              .filter(Boolean)
              .join(" · ");
            return {
              id: `drivercancelled:${c.id}`,
              kind: "cancelled",
              title: "This job was cancelled",
              body: body || "The job was cancelled before you got there.",
              to: "/driver",
            };
          }),
        );
      }
    }
  }, [calls, key, cancelledKey, push]);

  return <BannerStack role="driver" banners={banners} onDismiss={dismiss} showSoundToggle={showSoundToggle} />;
}
