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
import { AlertTriangle, Volume2, VolumeX, X, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SERVICE_LABELS } from "~/lib/job-ui";
import { diffEscalatedDecisionIds, diffNewJobIds, mergeSeen } from "~/lib/notify";
import { getSeenIds, seenKey, setSeenIds } from "~/lib/notify-seen";
import { playLightning, primeAudio, soundMuted, toggleSoundMuted, type SoundRole } from "~/lib/sound";
import { useDispatchStore } from "~/lib/store";
import { listAiDispatcherDecisions } from "~/data/server";

export type BannerKind = "job" | "escalation";

/** Routes banners can navigate to (typed so navigate() typechecks). */
export type BannerTarget = "/owner/queue" | "/owner/ai-dispatcher" | "/driver";

export type BannerItem = {
  /** Unique key — job:LDID / esc:DECISIONID / driverjob:CALLID */
  id: string;
  kind: BannerKind;
  title: string;
  body: string;
  /** Route to navigate to when the banner is tapped. */
  to: BannerTarget;
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
      className={`inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-500 transition-colors duration-150 hover:bg-ink-50 hover:text-ink-700 active:scale-[0.97] ${className}`}
    >
      <Icon className="size-4" aria-hidden="true" />
    </button>
  );
}

/* ------------------------------ banner stack ------------------------------ */

function useBannerStack(role: SoundRole) {
  const [banners, setBanners] = useState<BannerItem[]>([]);
  const timeouts = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    setBanners((prev) => prev.filter((b) => b.id !== id));
    const t = timeouts.current.get(id);
    if (t) { clearTimeout(t); timeouts.current.delete(id); }
  }, []);

  const push = useCallback((items: BannerItem[]) => {
    if (!items.length) return;
    setBanners((prev) => [...prev, ...items].slice(-MAX_STACK));
    // One strike per notification — never a loop.
    for (const _ of items) playLightning(role);
    for (const it of items) {
      const t = setTimeout(() => dismiss(it.id), AUTO_DISMISS_MS);
      timeouts.current.set(it.id, t);
    }
  }, [role, dismiss]);

  useEffect(() => () => { for (const t of timeouts.current.values()) clearTimeout(t); }, []);

  return { banners, push, dismiss };
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
            b.kind === "escalation" ? "border-danger-200 bg-danger-50" : "border-brand-200 bg-surface"
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
                  b.kind === "escalation" ? "bg-danger-100 text-danger-600" : "bg-brand-50 text-brand-600"
                }`}
              >
                {b.kind === "escalation" ? (
                  <AlertTriangle className="size-4" aria-hidden="true" />
                ) : (
                  <Zap className="size-4" fill="currentColor" strokeWidth={0} aria-hidden="true" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block text-sm font-bold ${b.kind === "escalation" ? "text-danger-700" : "text-ink-900"}`}>
                  {b.title}
                </span>
                <span className={`mt-0.5 block text-xs leading-snug ${b.kind === "escalation" ? "text-danger-700/90" : "text-ink-500"}`}>
                  {b.body}
                </span>
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
  const { refresh, isDemoMode } = useDispatchStore();
  const { banners, push, dismiss } = useBannerStack("owner");
  const booted = useRef(false);
  useAudioPrimer();

  const jobsKey = seenKey("owner", "jobs");
  const decisionsKey = seenKey("owner", "decisions");

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (stop || isDemoMode) return;
      try {
        // refresh() re-hydrates the store so a tapped banner lands on a queue
        // that actually shows the job — and returns the fresh payload for
        // arrival detection. null outside database mode / on a transient
        // failure — in that case leave the seen-set untouched so a later tick
        // still bootstraps cleanly (no burst).
        const data = await refresh();
        const decisions = await listAiDispatcherDecisions({ data: { escalatedOnly: true, limit: 20 } });
        if (stop || !data) return;

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
          booted.current = true;
          return;
        }

        const newJobs = diffNewJobIds(getSeenIds(jobsKey), jobs);
        const newDecs = diffEscalatedDecisionIds(getSeenIds(decisionsKey), decisions);
        if (newJobs.length) setSeenIds(jobsKey, mergeSeen(getSeenIds(jobsKey), newJobs.map((j) => j.id)));
        if (newDecs.length) setSeenIds(decisionsKey, mergeSeen(getSeenIds(decisionsKey), newDecs.map((d) => d.id)));

        const items: BannerItem[] = [];
        for (const j of newJobs) {
          items.push({
            id: `job:${j.id}`,
            kind: "job",
            title: "New job",
            body: `${j.customerName ?? "Customer"} · ${SERVICE_LABELS[j.serviceType as keyof typeof SERVICE_LABELS] ?? "Service"} · ${j.area ?? "—"}`,
            to: "/owner/queue",
          });
        }
        for (const d of newDecs) {
          items.push({
            id: `esc:${d.id}`,
            kind: "escalation",
            title: "Dispatch alert",
            body: d.reason?.trim() || "The AI dispatcher escalated a decision.",
            to: "/owner/ai-dispatcher",
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
  }, [refresh, isDemoMode, jobsKey, decisionsKey, push]);

  return <BannerStack role="owner" banners={banners} onDismiss={dismiss} showSoundToggle />;
}

/* --------------------------- driver notification banners --------------------------- */

/**
 * Mounted inside the real driver portal. Hooks into the portal's existing
 * 20s queue poll: whenever `calls` changes, diff new call ids against the
 * seen-set and raise a "New job assigned" banner for each arrival. The first
 * successful load seeds the set (no burst on sign-in).
 */
export function DriverNotificationBanners({ calls }: { calls: readonly { id: string }[] | null }) {
  const { banners, push, dismiss } = useBannerStack("driver");
  const booted = useRef(false);
  useAudioPrimer();
  const key = seenKey("driver", "jobs");

  useEffect(() => {
    // `calls` starts null (not loaded yet). The FIRST successful response —
    // empty or not — bootstraps the seen-set: nothing already in the queue at
    // sign-in ever fires. A job that lands AFTER that first response fires.
    if (calls === null || calls === undefined) return;
    if (!booted.current) {
      booted.current = true;
      setSeenIds(key, mergeSeen(getSeenIds(key), calls.map((c) => c.id)));
      return;
    }
    const added = diffNewJobIds(getSeenIds(key), calls.map((c) => ({ id: c.id })));
    if (!added.length) return;
    setSeenIds(key, mergeSeen(getSeenIds(key), added.map((j) => j.id)));
    const byId = new Map(calls.map((c) => [c.id, c]));
    push(
      added.map((j) => {
        const call = byId.get(j.id) as
          | { serviceName?: string; pickupAddress?: string; zip?: string }
          | undefined;
        const body = [call?.serviceName, [call?.pickupAddress, call?.zip].filter(Boolean).join(", ")]
          .filter(Boolean)
          .join(" · ");
        return {
          id: `driverjob:${j.id}`,
          kind: "job",
          title: "New job assigned",
          body: body || "A new job landed in your queue.",
          to: "/driver",
        };
      }),
    );
  }, [calls, key, push]);

  return <BannerStack role="driver" banners={banners} onDismiss={dismiss} />;
}
