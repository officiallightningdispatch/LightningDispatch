/**
 * HomeSheet + TripSheet — the R2 bottom-sheet content for the driver portal
 * (spec §b/§c). Built on DriverBottomSheet; the page owns snapIndex (tap-map
 * expands). Reuses the shared JobCardActions (accept/en-route/photo flow/
 * disclosure) so the dominant-action logic has ONE source of truth.
 */
import { ChevronDown, MapPin, Navigation, Phone, RefreshCw, Truck } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { DriverBottomSheet } from "~/components/driver-bottom-sheet";
import { ProgressRail } from "~/components/driver-progress";
import { etaLabel, JobCardActions, STATUS_META, type GpsState } from "~/components/driver-queue";
import { GpsStatusChip } from "~/components/driver-queue";
import { buildNavigateUrl } from "~/lib/navigation";
import { Button } from "~/components/ui";
import type { DriverCall } from "~/data/driver-auth";

/* ------------------------------ shared bits ------------------------------ */

const addressOf = (call: DriverCall): string => [call.pickupAddress, call.zip].filter(Boolean).join(", ");

/** "?" style: one prominent job front-and-center (peek) — the Uber look. */
export function PrimaryJobPeek({ call, acting, onAct, onQueueChanged }: { call: DriverCall; acting: boolean; onAct: (id: string, a: "accept" | "en_route") => Promise<void>; onQueueChanged: () => void }) {
  const meta = STATUS_META[call.statusId] ?? { label: `Status ${call.statusId}`, badge: "bg-ink-100 text-ink-600" };
  const address = addressOf(call);
  const [ua, setUa] = useState("");
  useEffect(() => {
    if (typeof navigator !== "undefined") setUa(navigator.userAgent);
  }, []);
  const navUrl = buildNavigateUrl(call.pickupLat, call.pickupLng, address, ua);
  const isActive = call.statusId === 2 || call.statusId === 3 || call.statusId === 4;
  return (
    <div>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">
            Call #{call.callNumber}{call.customerName ? ` · ${call.customerName}` : ""}
          </p>
          <h2 className="mt-0.5 text-lg font-black tracking-tight text-ink-950 text-pretty">{call.serviceName}</h2>
        </div>
        <span className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-[11px] font-bold ${meta.badge}`}>{meta.label}</span>
      </div>
      {address && (
        <p className="mt-1.5 flex items-start gap-1.5 text-sm text-ink-700">
          <MapPin className="mt-0.5 size-4 shrink-0 text-brand-600" />
          <span className="min-w-0">{address}</span>
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-500">
        <span>
          ETA <strong className="font-semibold tabular-nums text-ink-700">{etaLabel(call.arrivalETA)}</strong>
        </span>
        {call.vehicle && (
          <span className="flex min-w-0 items-center gap-1"><Truck className="size-3.5 shrink-0" /><span className="break-words">{call.vehicle}</span></span>
        )}
      </div>
      {/* Navigate — one tap into the phone's maps app (owner-directed 2026-08-13):
          coords when the job has them, address query when not. Active jobs only;
          offers stay on Accept. ≥44px tap target, sits above the job actions. */}
      {isActive && navUrl && (
        <a
          href={navUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="Open the customer's location in your maps app"
          className="mt-2.5 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-ink-950 text-sm font-semibold text-white transition-colors hover:bg-ink-800 active:scale-[0.98]"
        >
          <Navigation className="size-5 text-brand-400" /> Navigate
        </a>
      )}
      <JobCardActions call={call} acting={acting} onAct={onAct} onQueueChanged={onQueueChanged} />
    </div>
  );
}

/** Compact "More offers" row (expanded Home sheet) — offers only. */
export function OfferRow({ call, acting, onAct }: { call: DriverCall; acting: boolean; onAct: (id: string, a: "accept" | "en_route") => Promise<void> }) {
  const address = addressOf(call);
  return (
    <div className="flex items-center gap-3 border-b border-ink-100 py-3 last:border-0">
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm font-bold text-ink-800">{call.serviceName}</p>
        <p className="break-words text-xs text-ink-500">{address || `Call #${call.callNumber}`}</p>
        <p className="mt-0.5 text-[11px] font-semibold tabular-nums text-brand-700">{etaLabel(call.arrivalETA)}</p>
      </div>
      <Button size="md" loading={acting} onClick={() => void onAct(call.id, "accept")} className="shrink-0">
        Accept
      </Button>
    </div>
  );
}

/* -------------------------------- HomeSheet -------------------------------- */

export type HomeEarnings = { completed: number; tipsCents: number } | null;

export function HomeSheet({
  primary,
  offers,
  history,
  acting,
  onAct,
  onQueueChanged,
  onRefresh,
  refreshing,
  lastUpdated,
  snapIndex,
  onSnapChange,
  earnings,
  onOpenEarnings,
  topSlot,
}: {
  /** Optional content rendered at the TOP of the sheet content — the push
   *  permission card (spec A4: first contractor sign-in, above the job). */
  topSlot?: ReactNode;
  /** The single job shown front-and-center: active[0] ?? offers[0], else null. */
  primary: DriverCall | null;
  /** Remaining offers for the expanded "More offers" list (excludes primary
   *  when primary IS an offer). */
  offers: DriverCall[];
  /** Past jobs — completed (5/6/252) + cancelled (255) — rendered as the
   *  expanded "History" list (Uber-style; owner-directed 2026-08-12). */
  history: DriverCall[];
  acting: string | null;
  onAct: (id: string, a: "accept" | "en_route") => Promise<void>;
  onQueueChanged: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  lastUpdated: Date | null;
  snapIndex: number;
  onSnapChange: (i: number) => void;
  earnings: HomeEarnings;
  onOpenEarnings: () => void;
}) {
  const expanded = snapIndex > 0;
  return (
    <DriverBottomSheet
      snapPoints={[0.38, 0.78]}
      snapIndex={snapIndex}
      onSnapChange={onSnapChange}
      label="Home jobs"
    >
      {!expanded && (
        <div className="mb-3 flex items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-[.14em] text-ink-400">
            {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Live queue"}
          </p>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Refresh jobs"
            className="grid size-10 place-items-center rounded-lg text-ink-400 transition-colors hover:bg-ink-50 hover:text-ink-600 disabled:opacity-50"
          >
            <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
          </button>
        </div>
      )}

      {topSlot}
      {primary ? (
        <>
          <PrimaryJobPeek call={primary} acting={acting === primary.id} onAct={onAct} onQueueChanged={onQueueChanged} />
          {/* Earnings strip (peek only): N completed · $X in tips — honest: no
              per-job rate yet (owner-side payday milestone). */}
          {!expanded && earnings && (
            <button
              type="button"
              onClick={onOpenEarnings}
              className="mt-3 flex w-full items-center justify-between gap-2 border-t border-ink-100 pt-3 text-left"
            >
              <span className="text-xs font-semibold text-ink-500">This week</span>
              <span className="flex items-center gap-1 text-sm font-black tabular-nums text-ink-950">
                {earnings.completed} completed · ${(earnings.tipsCents / 100).toFixed(0)} tips
                <ChevronDown className="size-4 text-ink-400" />
              </span>
            </button>
          )}
        </>
      ) : (
        <div className="py-4 text-center">
          <p className="font-bold text-ink-700">No offers right now</p>
          <p className="mx-auto mt-1 max-w-60 text-sm text-ink-400">
            The AI dispatcher offers jobs to available contractors — new offers land here automatically.
          </p>
        </div>
      )}

      {expanded && (
        <>
          {offers.length > 0 && (
            <div className="mt-3 border-t border-ink-100">
              <p className="pb-1 pt-3 text-xs font-bold uppercase tracking-[.14em] text-ink-400">
                More offers ({offers.length})
              </p>
              {offers.map((c) => (
                <OfferRow key={c.id} call={c} acting={acting === c.id} onAct={onAct} />
              ))}
            </div>
          )}
          {primary && offers.length === 0 && (
            <p className="mt-3 border-t border-ink-100 pt-3 text-center text-xs text-ink-400">
              No other offers right now — this is the only one in your queue.
            </p>
          )}
          {history.length > 0 && (
            <div className="mt-3 border-t border-ink-100">
              <p className="pb-1 pt-3 text-xs font-bold uppercase tracking-[.14em] text-ink-400">
                History ({history.length})
              </p>
              {history.map((c) => (
                <HistoryRow key={c.id} call={c} />
              ))}
            </div>
          )}
        </>
      )}
    </DriverBottomSheet>
  );
}

/* -------------------------------- History row -------------------------------- */

/** Uber-style past-job row: completed (5/6/252) or cancelled (255) with a
 *  distinct badge — cancelled jobs leave Active/Offers and live here
 *  (owner-directed 2026-08-12). */
function HistoryRow({ call }: { call: DriverCall }) {
  const cancelled = call.statusId === 255;
  const meta = cancelled ? STATUS_META[255] : STATUS_META[5];
  const address = addressOf(call);
  return (
    <div className="flex items-start gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">Call #{call.callNumber}</p>
        <p className="break-words text-sm font-semibold text-ink-800">{call.serviceName}</p>
        {address && <p className="break-words text-xs text-ink-500">{address}</p>}
      </div>
      <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${meta.badge}`}>
        <span className={`size-1.5 rounded-full ${meta.dot}`} /> {meta.label}
      </span>
    </div>
  );
}

/* -------------------------------- TripSheet -------------------------------- */

export function TripSheet({
  call,
  acting,
  onAct,
  onQueueChanged,
  snapIndex,
  onSnapChange,
}: {
  call: DriverCall;
  acting: boolean;
  onAct: (id: string, a: "accept" | "en_route") => Promise<void>;
  onQueueChanged: () => void;
  snapIndex: number;
  onSnapChange: (i: number) => void;
}) {
  const address = addressOf(call);
  const phoneDigits = call.customerPhone.replace(/[^+\d]/g, "");
  const [ua, setUa] = useState("");
  useEffect(() => {
    if (typeof navigator !== "undefined") setUa(navigator.userAgent);
  }, []);
  // One tap into the phone's maps app (owner-directed 2026-08-13): coords deep
  // link when the job has them, geocodable address query when it doesn't.
  // iOS → Apple Maps, Android → Google Maps, desktop → Google Maps search.
  const navUrl = buildNavigateUrl(call.pickupLat, call.pickupLng, address, ua);
  return (
    <DriverBottomSheet
      snapPoints={[0.55, 0.85]}
      snapIndex={snapIndex}
      onSnapChange={onSnapChange}
      label="Active trip"
    >
      {/* Row 1: pickup + call/service meta */}
      <p className="text-lg font-black leading-snug tracking-tight text-ink-950">{address || "Pickup location"}</p>
      <p className="mt-0.5 text-xs font-semibold uppercase tracking-wide text-ink-400">
        Call #{call.callNumber} · {call.serviceName}
      </p>

      {/* Row 2: call + navigate — the Navigate button is a direct maps deep
          link (coords OR address; ≥44px target), near the address block. */}
      <div className="mt-3 flex gap-2">
        {phoneDigits ? (
          <a
            href={`tel:${phoneDigits}`}
            title={`Call ${call.customerName || "customer"}`}
            className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl border border-ink-200 bg-surface text-sm font-semibold text-ink-700 transition-colors hover:bg-hover active:scale-[0.98]"
          >
            <Phone className="size-5 text-brand-600" /> Call {call.customerName || "customer"}
          </a>
        ) : null}
        {navUrl ? (
          <a
            href={navUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Open the customer's location in your maps app"
            className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-ink-950 text-sm font-semibold text-white transition-colors hover:bg-ink-800 active:scale-[0.98]"
          >
            <Navigation className="size-5 text-brand-400" /> Navigate
          </a>
        ) : null}
        {!phoneDigits && !navUrl && (
          <p className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl border border-dashed border-ink-200 bg-ink-50 px-3 text-xs text-ink-400">
            Contact + directions weren&apos;t provided on this call.
          </p>
        )}
      </div>

      {/* Row 3: lifecycle rail */}
      <div className="mt-4">
        <ProgressRail statusId={call.statusId} />
      </div>

      {/* Row 4: dominant action + photo flow + disclosure */}
      <JobCardActions call={call} acting={acting} onAct={onAct} onQueueChanged={onQueueChanged} />
    </DriverBottomSheet>
  );
}

/* ------------------------------ floating chips ------------------------------ */

/** Banner/chip stack rendered over the map hero (Home/Active): notification
 *  banners, expired-session, queue error, GPS state — all as floating chips
 *  (top-center stack, z-20), not full-width blocks (R2 spec §b). */
export function MapChips({
  chips,
  gps,
}: {
  chips: { kind: "error" | "expired"; text: string; onAction?: () => void }[];
  gps: GpsState;
}) {
  if (chips.length === 0 && gps === "idle") return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex flex-col items-center gap-2 px-4">
      {chips.map((c, i) => (
        <button
          key={i}
          type="button"
          onClick={c.onAction}
          className={`pointer-events-auto w-full max-w-sm rounded-2xl border px-3.5 py-2.5 text-left text-xs font-semibold shadow-card backdrop-blur ${
            c.kind === "expired"
              ? "border-amber-200 bg-amber-50/95 text-amber-800"
              : "border-danger-100 bg-danger-50/95 text-danger-600"
          }`}
        >
          {c.text}
        </button>
      ))}
      <div className="pointer-events-auto w-full max-w-sm">
        <GpsStatusChip state={gps} />
      </div>
    </div>
  );
}
