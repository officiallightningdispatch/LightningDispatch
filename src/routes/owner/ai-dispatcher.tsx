import { createFileRoute, Link } from "@tanstack/react-router";
import { Bot, Clock, MapPin, Plug, TrafficCone } from "lucide-react";
import { useEffect, useState } from "react";
import { AppShell } from "~/components/app-shell";
import { AiDecisionsEmpty, AiDecisionRow, AiToggle } from "~/components/ai-dispatcher-views";
import { Alert, Card } from "~/components/ui";
import {
  getAiDispatcherStatus,
  latestDispatcherRun,
  listAiDispatcherDecisions,
  setAiDispatcherEnabled,
  type AiDispatcherDecisionRow,
  type AiDispatcherRunRow,
  type AiDispatcherStatus,
} from "~/data/server";
import { timeAgo } from "~/lib/job-ui";

export const Route = createFileRoute("/owner/ai-dispatcher")({ component: OwnerAiDispatcher });

/** ETA source labels for the panel — which provider produces the quoted ETA
 *  (v3 traffic layer: TomTom live traffic when the key is configured, else
 *  OSRM static routing, else the distance model). */
const ETA_SOURCE_LABEL: Record<string, string> = {
  tomtom: "TomTom live traffic",
  osrm: "OSRM static (no traffic key set)",
  factor: "Distance estimate",
};
const ETA_SOURCE_DEFAULT = "OSRM static (no traffic key set)";
const etaSourceLabel = (s: AiDispatcherStatus | null) =>
  s ? ETA_SOURCE_LABEL[s.etaProvider] ?? ETA_SOURCE_DEFAULT : ETA_SOURCE_DEFAULT;
/** One-line summary of the newest tick row for the "last run" line — the
 *  at-a-glance answer to "is it working?": what the engine saw on its latest
 *  poll and why it did (or didn't) act. */
const dispatcherRunSummary = (run: AiDispatcherRunRow | null): string => {
  if (!run) return "no tick recorded yet";
  if (run.gated) return "paused — no auto-accepts";
  if (run.skipped) return `skipped: ${run.skipped}`;
  if (run.offersSeen === 0) return "feed empty";
  if (run.processed > 0) {
    return run.processed === 1 ? "offer seen — auto-accepted" : `${run.processed} offers seen — processed`;
  }
  return `${run.offersSeen} offer${run.offersSeen === 1 ? "" : "s"} seen — none processed`;
};

/** Owner control panel for the AI dispatcher engine: live toggle, zone card,
 *  recent decision ledger with collapsible raw responses, and a Towbook
 *  connect prompt when the engine can't see offers. */
function OwnerAiDispatcher() {
  const [status, setStatus] = useState<AiDispatcherStatus | null>(null);
  const [run, setRun] = useState<AiDispatcherRunRow | null>(null);
  const [decisions, setDecisions] = useState<AiDispatcherDecisionRow[] | null>(null);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState("");

  const refresh = async () => {
    const [st, r] = await Promise.all([getAiDispatcherStatus(), latestDispatcherRun()]);
    setStatus(st);
    setRun(r);
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { void listAiDispatcherDecisions({ data: { limit: 25 } }).then(setDecisions); }, []);

  // Optimistic toggle with rollback on failure.
  const toggle = async (next: boolean) => {
    setToggling(true);
    setToggleError("");
    const prev = status?.enabled;
    if (status) setStatus({ ...status, enabled: next });
    const r = await setAiDispatcherEnabled({ data: { enabled: next } });
    if (!r.ok) {
      if (status && prev != null) setStatus({ ...status, enabled: prev });
      setToggleError(r.error.message);
    }
    setToggling(false);
    void refresh();
  };

  const enabled = status?.enabled ?? true;

  return (
    <AppShell
      portal="owner"
      title="AI Dispatcher"
      description="Watch the auto-accept engine decide — and flip it off whenever you need to."
    >
      <div className="space-y-6">
        {/* ---- status + live toggle ---- */}
        <Card className="border-brand-200 bg-gradient-to-br from-brand-50/70 to-surface p-5 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex gap-4">
              <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-brand-500 text-white">
                <Bot className="size-6" />
              </span>
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-brand-700">Dispatch engine</p>
                <h2 className="mt-1 text-xl font-bold">Auto-accept is {enabled ? "on" : "off"}</h2>
                <p className="mt-1 max-w-lg text-sm text-ink-500">
                  {enabled
                    ? "Incoming Towbook offers inside the service zone are accepted automatically and dispatched to the best available driver."
                    : "Incoming offers are left untouched until a dispatcher handles them."}
                </p>
                {status && (
                  <p className="mt-2 text-xs text-ink-400">
                    {status.decisionsLast24h} decisions in the last 24 h · {status.escalationsOpen} open escalation
                    {status.escalationsOpen === 1 ? "" : "s"}
                    {status.lastDecisionAt ? ` · last decision ${timeAgo(status.lastDecisionAt)}` : ""}
                  </p>
                )}
                <p className="mt-1 text-xs font-medium text-ink-500" aria-live="polite">
                  Last check {run ? timeAgo(run.ranAt) : "—"} · {dispatcherRunSummary(run)}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
              <AiToggle
                checked={enabled}
                onChange={toggle}
                disabled={toggling || status == null}
                label="AI dispatcher auto-accept"
              />
              <span className={`text-xs font-bold ${enabled ? "text-success-700" : "text-ink-400"}`}>
                {enabled ? "Live — accepting offers" : "Paused — no auto-accepts"}
              </span>
            </div>
          </div>
          {toggleError && (
            <Alert variant="danger">
              <span>Could not update the AI dispatcher: {toggleError}</span>
            </Alert>
          )}
        </Card>

        {/* ---- zone + ETA cards ---- */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Card className="p-5">
            <div className="flex items-center gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
                <MapPin className="size-5" />
              </span>
              <div>
                <p className="text-sm font-bold">Service zone</p>
                <p className="text-xs text-ink-400">Offers inside this radius are auto-accepted</p>
              </div>
            </div>
            <div className="mt-4 space-y-1.5 text-sm">
              <p className="flex justify-between gap-3"><span className="text-ink-400">Center</span><span className="font-semibold">Bridgeport, CT 06606</span></p>
              <p className="flex justify-between gap-3"><span className="text-ink-400">Radius</span><span className="font-semibold">{status ? status.zoneRadiusMiles : 30} miles</span></p>
              <p className="flex justify-between gap-3">
                <span className="text-ink-400">Coordinates</span>
                <span className="font-mono text-xs">{status ? `${status.zoneLat.toFixed(6)}, ${status.zoneLng.toFixed(6)}` : "41.208862, -73.207253"}</span>
              </p>
            </div>
          </Card>
          <Card className="p-5">
            <div className="flex items-center gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
                <Clock className="size-5" />
              </span>
              <div>
                <p className="text-sm font-bold">ETA commitment</p>
                <p className="text-xs text-ink-400">The ETA sent to the motor club with each accept</p>
              </div>
            </div>
            <div className="mt-4 space-y-1.5 text-sm">
              <p className="flex justify-between gap-3"><span className="text-ink-400">Max ETA</span><span className="font-semibold">{status ? status.maxEtaMinutes : 45} minutes</span></p>
              <p className="flex justify-between gap-3">
                <span className="text-ink-400">ETA source</span>
                <span className="flex items-center gap-1.5 font-semibold">
                  <TrafficCone className={`size-3.5 ${status?.etaProvider === "tomtom" ? "text-brand-500" : "text-ink-300"}`} aria-hidden="true" />
                  {etaSourceLabel(status)}
                </span>
              </p>
              <p className="flex justify-between gap-3">
                <span className="text-ink-400">Towbook</span>
                <span className={`font-semibold ${status?.connected ? "text-success-700" : "text-danger-600"}`}>
                  {status?.connected ? (status.lastSyncAt ? `synced ${timeAgo(status.lastSyncAt)}` : "connected") : "not connected"}
                </span>
              </p>
            </div>
          </Card>
        </div>

        {/* ---- not connected prompt ---- */}
        {status && !status.connected && (
          <Alert variant="warning">
            <span>
              Towbook isn&apos;t connected, so the AI dispatcher can&apos;t see offers.{" "}
              <Link to="/owner/settings" className="font-bold underline">Connect Towbook</Link>{" "}
              to start auto-accepting.
            </span>
          </Alert>
        )}

        {/* ---- decision ledger ---- */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-bold uppercase tracking-wider text-ink-500">Recent decisions</h3>
            <span className="text-xs text-ink-400">newest first</span>
          </div>
          {decisions === null ? (
            <Card className="p-8 text-center text-sm text-ink-400">Loading decisions…</Card>
          ) : decisions.length === 0 ? (
            <AiDecisionsEmpty connected={Boolean(status?.connected)} />
          ) : (
            <Card className="overflow-hidden">
              {decisions.map((d) => (
                <AiDecisionRow key={d.id} row={d} />
              ))}
            </Card>
          )}
        </section>

        <p className="flex items-center gap-2 text-xs text-ink-400">
          <Plug className="size-3.5" /> Every decision the engine makes — accept or escalate — is recorded here with its raw Towbook response for full transparency.
        </p>
      </div>
    </AppShell>
  );
}
