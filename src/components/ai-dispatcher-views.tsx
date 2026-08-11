import { AlertTriangle, Bot, ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { getAiDispatcherDecisionDetail, getAiDispatcherStatus, listAiDispatcherDecisions, type AiDispatcherDecisionRow } from "~/data/server";
import { timeAgo } from "~/lib/job-ui";
import { Card, StatusBadge } from "~/components/ui";

/* ============================================================================
 * AI dispatcher shared views — rendered in the owner control panel
 * (/owner/ai-dispatcher) and the ops queue (/ops) escalation banner.
 * Green = accepted+dispatched, amber = accepted but needs a driver,
 * red = escalated to a human. Data is org-scoped server-side; never demo.
 * ========================================================================== */

export const AI_DECISION_META: Record<string, { label: string; badge: string }> = {
  auto_accept_with_driver: { label: "Auto-accepted · dispatched", badge: "bg-success-50 text-success-700" },
  auto_accept_no_driver: { label: "Auto-accepted · needs dispatch", badge: "bg-accent-50 text-accent-700" },
  escalated_out_of_zone: { label: "Escalated · out of zone", badge: "bg-danger-50 text-danger-700" },
  escalated_missing_coords: { label: "Escalated · no coordinates", badge: "bg-danger-50 text-danger-700" },
  escalated_expired: { label: "Escalated · expired", badge: "bg-danger-50 text-danger-700" },
  escalated_driver_lookup_failed: { label: "Escalated · driver lookup failed", badge: "bg-danger-50 text-danger-700" },
  escalated_accept_failed: { label: "Escalated · accept failed", badge: "bg-danger-50 text-danger-700" },
  escalated_unexpected_shape: { label: "Escalated · unexpected offer", badge: "bg-danger-50 text-danger-700" },
  escalated_dispatch_failed: { label: "Escalated · dispatch failed", badge: "bg-danger-50 text-danger-700" },
  escalated_auto_arrive_failed: { label: "Escalated · auto-arrive failed", badge: "bg-danger-50 text-danger-700" },
  escalated_photo_upload_failed: { label: "Escalated · PO photo upload failed", badge: "bg-danger-50 text-danger-700" },
};
const DECISION_FALLBACK = { label: "Decision", badge: "bg-ink-100 text-ink-600" };

/** Mobile-friendly on/off switch (role=switch, keyboard accessible). */
export function AiToggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:opacity-50 ${
        checked ? "bg-brand-500" : "bg-ink-200"
      }`}
    >
      <span
        aria-hidden="true"
        className={`inline-block size-5 transform rounded-full bg-white shadow transition-transform duration-150 ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

/** One decision row: badge + reason + meta, with a collapsible raw-response
 *  viewer (fetches the heavy payload on demand — the list itself stays light). */
export function AiDecisionRow({ row }: { row: AiDispatcherDecisionRow }) {
  const meta = AI_DECISION_META[row.decision] ?? DECISION_FALLBACK;
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const toggleRaw = async () => {
    const next = !open;
    setOpen(next);
    if (next && raw == null && !failed) {
      setLoading(true);
      try {
        const r = await getAiDispatcherDecisionDetail({ data: { id: row.id } });
        if (r && r.ok) setRaw(r.raw);
        else setFailed(true);
      } catch {
        setFailed(true);
      }
      setLoading(false);
    }
  };

  return (
    <div className="border-b border-ink-100 last:border-0">
      <div className="flex items-start gap-3 px-4 py-3">
        <StatusBadge className={`shrink-0 ${meta.badge}`}>{meta.label}</StatusBadge>
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug text-ink-700">{row.reason}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-400">
            <span>{timeAgo(row.createdAt)}</span>
            {row.driverName && <span>· {row.driverName}</span>}
            {row.etaMinutes != null && <span>· ETA {row.etaMinutes} min</span>}
            {row.callId && <span>· call {row.callId}</span>}
            <span className="font-mono">· offer {row.callRequestId}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={toggleRaw}
          aria-expanded={open}
          aria-label={open ? "Hide raw response" : "Show raw response"}
          className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-400 hover:bg-ink-50 hover:text-ink-600"
        >
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
      </div>
      {open && (
        <div className="border-t border-ink-100 bg-canvas/60 px-4 py-3">
          <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-ink-400">Raw response</p>
          {loading ? (
            <p className="text-xs text-ink-400">Loading…</p>
          ) : failed ? (
            <p className="text-xs text-danger-600">Could not load the raw response.</p>
          ) : raw == null ? (
            <p className="text-xs text-ink-400">No raw response recorded for this decision.</p>
          ) : (
            <pre className="max-h-72 overflow-auto rounded-lg bg-ink-950 p-3 font-mono text-[11px] leading-relaxed text-ink-100">
              {raw}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Decision types a dispatcher can actually act on (per owner direction): the
 *  offer was accepted without a driver, or an accept/lookup failed, or it
 *  expired — everything else was correctly left alone and needs no human. */
const ACTIONABLE_ESCALATIONS = new Set([
  "auto_accept_no_driver",
  "escalated_accept_failed",
  "escalated_driver_lookup_failed",
  "escalated_expired",
  "escalated_dispatch_failed",
  "escalated_photo_upload_failed",
]);

/** Ops queue banner: "Needs attention" when the engine escalated anything a
 *  human should act on. Self-contained — reads status + recent escalations. */
export function AiEscalationsBanner() {
  const [count, setCount] = useState<number | null>(null);
  const [rows, setRows] = useState<AiDispatcherDecisionRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [st, list] = await Promise.all([
          getAiDispatcherStatus(),
          listAiDispatcherDecisions({ data: { limit: 8, escalatedOnly: true } }),
        ]);
        if (!live) return;
        setCount(st ? st.escalationsOpen : 0);
        setRows(list);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => { live = false; };
  }, []);

  if (failed) return null;
  if (count === null) return null;
  if (count === 0) return null;

  const actionable = (rows ?? []).filter((d) => ACTIONABLE_ESCALATIONS.has(d.decision));

  return (
    <Card className="border-accent-200 bg-accent-50/70 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-100 text-accent-700">
          <AlertTriangle className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-accent-800">
            Needs attention — {count} open escalation{count === 1 ? "" : "s"}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-accent-700/90">
            The AI dispatcher flagged offers a human should handle. Review them below or in the owner's AI Dispatcher panel.
          </p>
        </div>
        <Link
          to="/owner/ai-dispatcher"
          className="hidden shrink-0 items-center rounded-lg border border-accent-200 bg-surface px-3 py-1.5 text-xs font-bold text-accent-700 hover:bg-accent-50 sm:inline-flex"
        >
          Open panel
        </Link>
      </div>
      {actionable.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {actionable.map((d) => {
            const m = AI_DECISION_META[d.decision] ?? DECISION_FALLBACK;
            return (
              <li key={d.id} className="flex items-start gap-2.5 rounded-xl border border-accent-100 bg-surface px-3 py-2.5">
                <StatusBadge className={`shrink-0 ${m.badge}`}>{m.label}</StatusBadge>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs leading-snug text-ink-600">{d.reason}</p>
                  <p className="mt-0.5 text-[11px] text-ink-400">
                    {timeAgo(d.createdAt)} · offer <span className="font-mono">{d.callRequestId}</span>
                    {d.driverName ? ` · ${d.driverName}` : ""}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-accent-700/90">
          The recent escalations are review-only (out of zone, missing coordinates, or an unexpected offer shape) — nothing to act on yet.
        </p>
      )}
      <Link
        to="/owner/ai-dispatcher"
        className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-accent-700 underline sm:hidden"
      >
        Open the AI Dispatcher panel <ChevronRight className="size-3.5" />
      </Link>
    </Card>
  );
}

/** Shared empty state for "no decisions yet" — used by the owner panel. */
export function AiDecisionsEmpty({ connected }: { connected: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-ink-200 bg-canvas/60 p-8 text-center">
      <span className="grid size-12 place-items-center rounded-xl bg-brand-50 text-brand-600">
        <Bot className="size-6" strokeWidth={2} aria-hidden="true" />
      </span>
      <p className="text-sm font-semibold text-ink-700">
        {connected ? "No decisions yet" : "The AI dispatcher is standing by"}
      </p>
      <p className="max-w-xs text-xs leading-relaxed text-ink-400">
        {connected
          ? "The AI dispatcher is watching for offers within 30 mi of 06606. Every auto-accept and escalation will show up here."
          : "Connect Towbook and the AI dispatcher will start watching for offers within 30 mi of 06606."}
      </p>
    </div>
  );
}
