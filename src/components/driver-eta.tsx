/**
 * EtaHero — the Uber-style ETA countdown overlay for the Active screen (R2 spec
 * §b/§c item 2). Pure client component: 1s tick. The countdown runs from a
 * DURATION (the AI dispatcher's quoted ETA, `call.ldEtaMinutes`) when one
 * exists — not a possibly-stale absolute Towbook `arrivalETA` — and re-anchors
 * the progress bar when the quote changes (SUB B defect 4). Falls back to
 * Towbook's absolute arrivalETA for legacy rows; keeps the honest
 * "pending dispatcher" / "--:--" strings when neither exists.
 */
import { useEffect, useReducer, useRef, useState } from "react";
import { Navigation } from "lucide-react";
import { NavigateMenu } from "~/components/nav-sheet";
import type { DriverCall } from "~/data/driver-auth";
import {
  etaQuoteKey,
  etaTargetMs,
  etaRemainingSeconds,
  formatCountdown,
  anchorEta,
  type EtaLike,
} from "~/lib/driver-eta-core";

/** mm:ss remaining until the ETA target; "--:--" when missing/unparseable. */
export const etaCountdown = (call: EtaLike, nowMs = Date.now()): string => {
  const remaining = etaRemainingSeconds(etaTargetMs(call, nowMs), nowMs);
  if (remaining == null) return "--:--";
  return formatCountdown(remaining);
};

/** Whole minutes until the ETA (floored, ≥0); null when missing. A duration
 *  quote reports its full quoted minutes. */
export const etaMinutesLeft = (call: EtaLike, nowMs = Date.now()): number | null => {
  if (call.ldEtaMinutes != null && Number.isFinite(call.ldEtaMinutes) && call.ldEtaMinutes >= 0) {
    return Math.floor(call.ldEtaMinutes);
  }
  const remaining = etaRemainingSeconds(etaTargetMs(call, nowMs), nowMs);
  return remaining == null ? null : Math.floor(remaining / 60);
};

/** "~12 min" or "Pickup ETA pending dispatcher" (never fabricate). */
export const etaMinutesLabel = (call: EtaLike): string => {
  const n = etaMinutesLeft(call);
  return n == null ? "Pickup ETA pending dispatcher" : `~${Math.max(1, n)} min`;
};

const fmtClock = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

const flashLabelFor = (key: string | null): string => {
  if (key == null) return "";
  if (key.startsWith("ld:")) return `${key.slice(3)} min`;
  return fmtClock(key);
};

/**
 * Re-quote flash: compare the quote key (duration or absolute) across queue
 * polls. When it CHANGES to a new non-null value, return a 3s floating pill
 * label; null otherwise.
 */
export function useRequoteFlash(call: EtaLike | null): string | null {
  const [flash, setFlash] = useState<string | null>(null);
  const prevRef = useRef<string | null>(null);
  const eta = etaQuoteKey(call);
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = eta;
    if (prev != null && eta != null && prev !== eta) {
      setFlash(`ETA updated — now ${flashLabelFor(eta)}`);
      const t = setTimeout(() => setFlash(null), 3000);
      return () => clearTimeout(t);
    }
  }, [eta]);
  return flash;
}

export function EtaHero({ call }: { call: DriverCall }) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => {
    const t = setInterval(force, 1000);
    return () => clearInterval(t);
  }, []);

  /* Progress-bar anchor: when the CURRENT quote (duration or absolute) was
   * first seen — a re-quote resets it. useRef is unconditional — hooks rule. */
  const anchorRef = useRef<{ key: string | null; at: number }>({ key: null, at: 0 });

  const statusId = call.statusId;
  const hasCoords = call.pickupLat != null && call.pickupLng != null;

  /* Offered (1): static line — no countdown yet. */
  if (statusId === 1) {
    return (
      <div className="pointer-events-auto w-fit max-w-[92vw] rounded-2xl bg-surface/95 px-4 py-3 shadow-card backdrop-blur">
        <p className="text-[10px] font-bold uppercase tracking-[.16em] text-ink-400">Offer</p>
        <p className="mt-0.5 text-lg font-black tabular-nums text-ink-950">
          {etaQuoteKey(call) ? `Arrive in ${etaMinutesLabel(call)}` : "Pickup ETA pending dispatcher"}
        </p>
      </div>
    );
  }
  /* Arrived (4): success line. */
  if (statusId === 4) {
    return (
      <div className="pointer-events-auto w-fit max-w-[92vw] rounded-2xl bg-surface/95 px-4 py-3 shadow-card backdrop-blur">
        <p className="text-sm font-bold text-success-600">You&apos;ve arrived — ETA met ✓</p>
      </div>
    );
  }
  /* Accepted (2) / En route (3): big mm:ss countdown + progress bar + a
   * navigation shortcut (feature batch 6 — in-app navigation DEFAULT with a
   * maps menu, owner-directed 2026-08-12). */
  const nowMs = Date.now();
  anchorRef.current = anchorEta(anchorRef.current, call, nowMs);
  const anchorMs = anchorRef.current.at;
  const targetMs = etaTargetMs(call, anchorMs);
  const hasEta = targetMs != null && targetMs > nowMs;
  const crossed = targetMs != null && targetMs <= nowMs;

  const elapsed = (nowMs - anchorMs) / 1000;
  const quoted = hasEta ? (targetMs - anchorMs) / 1000 : 0;
  const pct = hasEta && quoted > 0 ? Math.min(1, Math.max(0, elapsed / quoted)) : 0;
  const remaining = etaRemainingSeconds(targetMs, nowMs);

  const travelMin = hasEta ? Math.max(1, Math.round(quoted / 60 * 0.6)) : null;
  const sceneMin = hasEta ? Math.max(1, Math.round(quoted / 60 * 0.4)) : null;

  return (
    <div className="pointer-events-auto w-fit max-w-[92vw] rounded-2xl bg-surface/95 px-4 py-3 shadow-card backdrop-blur">
      <p className="text-[10px] font-bold uppercase tracking-[.16em] text-ink-400">Arrive in</p>
      <div className="mt-0.5 flex items-center gap-3">
        <p className="text-3xl font-black tabular-nums leading-none text-ink-950">
          {crossed ? "Arriving now" : hasEta && remaining != null ? formatCountdown(remaining) : "--:--"}
        </p>
        {hasCoords && (
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            aria-label="Start navigation to the customer"
            title="Start navigation"
            className="grid size-11 shrink-0 place-items-center rounded-full bg-ink-950 text-white shadow-md transition-transform active:scale-95"
          >
            <Navigation className="size-5 text-brand-400" strokeWidth={2} aria-hidden="true" />
          </button>
        )}
      </div>
      <NavigateMenu
        open={navOpen}
        onClose={() => setNavOpen(false)}
        lat={call.pickupLat ?? 0}
        lng={call.pickupLng ?? 0}
        address={[call.pickupAddress, call.zip].filter(Boolean).join(", ")}
      />
      {hasEta && (
        <div className="mt-2 h-1.5 w-36 overflow-hidden rounded-full bg-ink-100">
          <div className="h-full rounded-full bg-brand-500 transition-[width] duration-1000 ease-linear" style={{ width: `${pct * 100}%` }} />
        </div>
      )}
      <p className="mt-1.5 max-w-52 text-xs text-ink-500">
        {crossed
          ? "Look for the vehicle."
          : travelMin != null && sceneMin != null
            ? `Travel ~${travelMin} min · on scene ~${sceneMin} min`
            : "Quoted by the dispatch AI — traffic-aware."}
      </p>
    </div>
  );
}
