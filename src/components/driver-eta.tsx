/**
 * EtaHero — the Uber-style ETA countdown overlay for the Active screen (R2 spec
 * §b/§c item 2). Pure client component: 1s tick from `call.arrivalETA`, no
 * server call (v1). Display-only derivation: the "Travel X · on scene Y"
 * breakdown is a rough split of the quoted window (the dispatcher's exact
 * workload split isn't persisted per call — see spec §e Q5), with an honest
 * fallback line. Also exports etaCountdown + useRequoteFlash for the pages.
 */
import { useEffect, useReducer, useRef, useState } from "react";
import type { DriverCall } from "~/data/driver-auth";

/** mm:ss remaining until arrivalETA; "--:--" when the ETA is missing/unparseable. */
export const etaCountdown = (call: Pick<DriverCall, "arrivalETA">): string => {
  if (!call.arrivalETA) return "--:--";
  const t = new Date(call.arrivalETA).getTime() - Date.now();
  if (!Number.isFinite(t)) return "--:--";
  if (t <= 0) return "00:00";
  const total = Math.floor(t / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

/** Whole minutes until arrivalETA (floored, ≥0); null when missing. */
export const etaMinutesLeft = (call: Pick<DriverCall, "arrivalETA">): number | null => {
  if (!call.arrivalETA) return null;
  const t = new Date(call.arrivalETA).getTime() - Date.now();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor(t / 60000));
};

/** "~12 min" or "Pickup ETA pending dispatcher" (never fabricate). */
export const etaMinutesLabel = (call: Pick<DriverCall, "arrivalETA">): string => {
  const n = etaMinutesLeft(call);
  return n == null ? "Pickup ETA pending dispatcher" : `~${Math.max(1, n)} min`;
};

const fmtClock = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/**
 * Re-quote flash: compare `arrivalETA` across queue polls. When it CHANGES to a
 * new non-null value, return a 3s floating pill label; null otherwise. The
 * page renders the pill (accent-400 = the ONLY yellow on the Active screen).
 */
export function useRequoteFlash(call: Pick<DriverCall, "arrivalETA"> | null): string | null {
  const [flash, setFlash] = useState<string | null>(null);
  const prevRef = useRef<string | null>(null);
  const eta = call?.arrivalETA ?? null;
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = eta;
    if (prev != null && eta != null && prev !== eta) {
      setFlash(`ETA updated — now ${fmtClock(eta)}`);
      const t = setTimeout(() => setFlash(null), 3000);
      return () => clearTimeout(t);
    }
  }, [eta]);
  return flash;
}

export function EtaHero({ call }: { call: DriverCall }) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const t = setInterval(force, 1000);
    return () => clearInterval(t);
  }, []);

  /* Progress-bar anchor: when the CURRENT arrivalETA value was first seen
   * (requote resets it). useRef is unconditional — hooks rule. */
  const anchorRef = useRef<{ eta: string | null; at: number }>({ eta: null, at: 0 });

  const statusId = call.statusId;
  const eta = call.arrivalETA;

  /* Offered (1): static line from arrivalETA — no countdown yet. */
  if (statusId === 1) {
    return (
      <div className="pointer-events-auto w-fit max-w-[92vw] rounded-2xl bg-surface/95 px-4 py-3 shadow-card backdrop-blur">
        <p className="text-[10px] font-bold uppercase tracking-[.16em] text-ink-400">Offer</p>
        <p className="mt-0.5 text-lg font-black tabular-nums text-ink-950">
          {eta ? `Arrive in ${etaMinutesLabel(call)}` : "Pickup ETA pending dispatcher"}
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
  /* Accepted (2) / En route (3): big mm:ss countdown + progress bar. */
  const nowMs = Date.now();
  const arrivalMs = eta ? new Date(eta).getTime() : Number.NaN;
  const hasEta = Number.isFinite(arrivalMs) && arrivalMs > nowMs;
  const crossed = Number.isFinite(arrivalMs) && arrivalMs <= nowMs;

  if (anchorRef.current.eta !== eta) anchorRef.current = { eta, at: Date.now() };
  const elapsed = (nowMs - anchorRef.current.at) / 1000;
  const quoted = hasEta ? (arrivalMs - anchorRef.current.at) / 1000 : 0;
  const pct = hasEta && quoted > 0 ? Math.min(1, Math.max(0, elapsed / quoted)) : 0;

  const travelMin = hasEta ? Math.max(1, Math.round(quoted / 60 * 0.6)) : null;
  const sceneMin = hasEta ? Math.max(1, Math.round(quoted / 60 * 0.4)) : null;

  return (
    <div className="pointer-events-auto w-fit max-w-[92vw] rounded-2xl bg-surface/95 px-4 py-3 shadow-card backdrop-blur">
      <p className="text-[10px] font-bold uppercase tracking-[.16em] text-ink-400">Arrive in</p>
      <p className="mt-0.5 text-3xl font-black tabular-nums leading-none text-ink-950">
        {crossed ? "Arriving now" : hasEta ? etaCountdown(call) : "--:--"}
      </p>
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
