/**
 * AI BATTERY SALES AGENT — contractor portal UI (owner-directed 2026-08-13,
 * Phase 1). Mounted on the ACTIVE jumpstart job in the driver portal
 * (JobCardActions): a guided, agent-style flow that RUNS the battery sale —
 * agent prompts, contractor answers, deterministic server-validated steps.
 *
 * Flow: REQUIRED battery test (ok/faulty) → VIN → NHTSA decode (manual
 * fallback) → approved fitment → Lightning product/install type
 * → LIVE QUOTE → customer approval →
 * PAYMENT HAND-OFF (HARD GATE): full-screen "Hand your phone to your customer"
 * state with Square Web Payments' card form in CUSTOMER-PRESENT mode — the
 * agent NEVER sees or controls the card form (Square's iframe + nonce); the
 * charge is server-side on the owner's Square account, idempotent per attempt.
 * Success → "Battery paid — head to the warehouse" (+ address); the install
 * job appears in the contractor's queue automatically.
 *
 * Client-safe: imports ONLY the createServerFn facade (~/data/battery-sales)
 * + the shared Square public-config facade (~/data/completion).
 */
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  BatteryCharging,
  Check,
  CreditCard,
  MapPin,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "~/components/ui";
import { getSquareWebPaymentsConfig } from "~/data/completion";
import {
  batteryAgentStep,
  chargeBatterySale,
  listBatteryInstallTypes,
  getBatteryAgentState,
  recordBatteryTest,
  type BatteryAgentState,
} from "~/data/battery-sales";

type SquareCard = { tokenize: () => Promise<{ status: string; token?: string; errors?: Array<{ detail?: string }> }>; attach: (selector: string) => Promise<void>; destroy: () => Promise<void> };
type SquarePaymentsFactory = { card: () => Promise<SquareCard> };
type SquareGlobal = { payments: (applicationId: string, locationId: string) => SquarePaymentsFactory };

let squareScriptPromise: Promise<void> | null = null;
function loadSquareScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("Client only"));
  if ((window as unknown as { Square?: unknown }).Square) return Promise.resolve();
  squareScriptPromise ??= new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = "https://web.squarecdn.com/v1/square.js";
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => { squareScriptPromise = null; reject(new Error("Square payments couldn't load — check the connection.")); };
    document.head.appendChild(el);
  });
  return squareScriptPromise;
}

const money = (cents: number | null | undefined): string => `$${((cents ?? 0) / 100).toFixed(2)}`;

/** Is this call a jumpstart/battery job? (mirror of the sync's service map —
 *  Towbook service names: "Jump Start", "Battery", "Boost", …). */
export const isJumpstartService = (serviceName: string): boolean =>
  /jump|battery|boost|dead batt/i.test(serviceName || "");

/** Main panel — mounts on active jumpstart jobs in JobCardActions. */
export function BatterySalesAgent({ callId }: { callId: string }) {
  const [state, setState] = useState<BatteryAgentState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [stepError, setStepError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let live = true;
    setLoadError("");
    void getBatteryAgentState({ data: { jobId: callId } }).then((r) => {
      if (!live) return;
      if (r.ok) setState(r.state);
      else setLoadError(r.message);
    }).catch(() => { if (live) setLoadError("Couldn't load the battery flow."); });
    return () => { live = false; };
  }, [callId, refreshKey]);

  const run = async (fn: () => Promise<{ ok: boolean } & Record<string, unknown>>) => {
    setBusy(true);
    setStepError("");
    try {
      const r = await fn();
      if (r.ok && r.state) setState(r.state as BatteryAgentState);
      else setStepError(String(r.message ?? "Couldn't do that — try again."));
    } catch {
      setStepError("Couldn't reach the server — check your connection and try again.");
    }
    setBusy(false);
  };

  if (loadError) {
    return (
      <div className="mt-3 rounded-xl border border-ink-200 bg-surface p-3">
        <p className="text-xs font-medium text-ink-500">{loadError}</p>
        <Button size="sm" variant="secondary" className="mt-2" onClick={() => setRefreshKey((n) => n + 1)}>
          <RotateCcw className="size-3.5" /> Retry
        </Button>
      </div>
    );
  }
  if (!state) return null; // still loading

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-brand-200 bg-surface">
      <div className="flex items-center gap-2 bg-brand-50 px-3 py-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-brand-500 text-white">
          <Sparkles className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold text-brand-800">AI Battery Sales Agent</p>
          <p className="text-[10px] font-medium text-brand-600">Battery test · quote · payment</p>
        </div>
        <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-700">
          {state.step}
        </span>
      </div>

      {/* Agent bubble */}
      <div className="px-3 py-3">
        <div className="rounded-2xl rounded-tl-sm bg-ink-50 px-3 py-2.5 text-[13px] leading-relaxed text-ink-700">
          {state.agentMessage}
        </div>

        {stepError && <p role="alert" className="mt-2 text-xs font-medium text-danger-600">{stepError}</p>}

        <StepControls state={state} busy={busy} onStep={run} onState={setState} />
      </div>
    </div>
  );
}

function StepControls({
  state,
  busy,
  onStep,
  onState,
}: {
  state: BatteryAgentState;
  busy: boolean;
  onStep: (fn: () => Promise<{ ok: boolean } & Record<string, unknown>>) => Promise<void>;
  onState: (s: BatteryAgentState) => void;
}) {
  const step = state.step;
  const sale = state.sale;
  const vehicle = sale ? `${sale.vehicleYear} ${sale.vehicleMake} ${sale.vehicleModel}`.trim() : "";

  // REQUIRED battery test — the gate for completing the job
  if (step === "test") {
    return (
      <div className="mt-3 grid grid-cols-1 gap-2">
        <Button className="w-full" loading={busy} onClick={() => onStep(() => recordBatteryTest({ data: { jobId: state.jobId, result: "ok" } }))}>
          <BatteryCharging className="size-4" /> Battery is OK — holds a charge
        </Button>
        <Button className="w-full" variant="secondary" loading={busy} onClick={() => onStep(() => recordBatteryTest({ data: { jobId: state.jobId, result: "faulty" } }))}>
          Battery is faulty — needs replacement
        </Button>
      </div>
    );
  }

  if (step === "ok") {
    return (
      <div className="mt-3 flex items-start gap-2 rounded-xl border border-success-200 bg-success-50 p-3">
        <Check className="mt-0.5 size-4 shrink-0 text-success-600" strokeWidth={3} />
        <div>
          <p className="text-xs font-bold text-success-700">Battery tested OK — no sale needed.</p>
          <p className="mt-0.5 text-[11px] leading-snug text-success-700/80">
            The test result is recorded on the job. You can complete it now.
          </p>
        </div>
      </div>
    );
  }

  if (step === "vin") {
    return <VinStep state={state} busy={busy} onStep={onStep} />;
  }

  if (step === "vehicle") {
    return (
      <div className="mt-3 space-y-2">
        <div className="rounded-xl border border-ink-200 bg-ink-50 px-3 py-2.5">
          <p className="text-sm font-bold text-ink-800">{vehicle}</p>
          <p className="text-[11px] text-ink-500">
            {sale?.vehicleManual ? "Vehicle entered manually" : "Vehicle decoded from VIN"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button className="flex-1" loading={busy} onClick={() => onStep(() => batteryAgentStep({ data: { jobId: state.jobId, action: "confirm_vehicle" } }))}>
            Confirm — that&apos;s the vehicle
          </Button>
          <p className="flex-1 text-center text-xs text-ink-500">
            Need a correction? Start a new vehicle lookup.
          </p>
        </div>
      </div>
    );
  }

  if (step === "install") return <InstallTypePicker state={state} busy={busy} onStep={onStep} />;

  if (step === "quote") {
    return (
      <div className="mt-3 space-y-2">
        <QuoteSummary state={state} />
        <div className="flex gap-2">
          <Button className="flex-1" loading={busy} onClick={() => onStep(() => batteryAgentStep({ data: { jobId: state.jobId, action: "approve" } }))}>
            <Check className="size-4" /> Customer approves
          </Button>
          <Button className="flex-1" variant="danger-ghost" loading={busy} onClick={() => onStep(() => batteryAgentStep({ data: { jobId: state.jobId, action: "decline" } }))}>
            Customer declined
          </Button>
        </div>
      </div>
    );
  }

  if (step === "handoff") {
    return <HandoffStep state={state} busy={busy} onStep={onStep} onState={onState} />;
  }

  if (step === "paid") {
    return (
      <div className="mt-3 space-y-2">
        <div className="rounded-xl border border-success-200 bg-success-50 p-3">
          <p className="flex items-center gap-1.5 text-sm font-black text-success-700">
            <Check className="size-4" strokeWidth={3} /> Battery paid — {money(sale?.totalCents)}
          </p>
          <p className="mt-1 text-xs font-semibold text-success-700/90">Head to the warehouse to pick it up.</p>
          {state.rates.warehouseAddress && (
            <p className="mt-1.5 flex items-start gap-1.5 text-xs text-success-700/90">
              <MapPin className="mt-0.5 size-3.5 shrink-0" /> {state.rates.warehouseAddress}
            </p>
          )}
        </div>
        {state.installJob && (
          <div className="flex items-start gap-2 rounded-xl border border-ink-200 bg-ink-50 p-3">
            <ArrowRight className="mt-0.5 size-4 shrink-0 text-brand-600" />
            <div>
              <p className="text-xs font-bold text-ink-700">Battery installation job created</p>
              <p className="mt-0.5 text-[11px] leading-snug text-ink-500">
                Job {state.installJob.id} is in your queue — accept it when you&apos;ve picked up the battery, then install and complete it.
              </p>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (step === "voided") {
    return <VoidedStep state={state} busy={busy} onStep={onStep} />;
  }

  return null;
}

function VoidedStep({ state, busy, onStep }: { state: BatteryAgentState; busy: boolean; onStep: (fn: () => Promise<{ ok: boolean } & Record<string, unknown>>) => Promise<void> }) {
  const [restarting, setRestarting] = useState(false);
  if (restarting) return <VinStep state={state} busy={busy} onStep={onStep} />;
  return (
    <div className="mt-3 space-y-2">
      <div className="rounded-xl border border-ink-200 bg-ink-50 p-3">
        <p className="text-xs font-semibold text-ink-600">Customer declined the battery — no charge. You can complete the job.</p>
      </div>
      <Button className="w-full" variant="secondary" onClick={() => setRestarting(true)}>
        <RotateCcw className="size-4" /> Customer changed their mind — start a new quote
      </Button>
    </div>
  );
}

function InstallTypePicker({ state, busy, onStep }: { state: BatteryAgentState; busy: boolean; onStep: (fn: () => Promise<{ok:boolean} & Record<string,unknown>>) => Promise<void> }) {
  const [types, setTypes] = useState<Awaited<ReturnType<typeof listBatteryInstallTypes>>>([]);
  useEffect(() => { void listBatteryInstallTypes().then(setTypes).catch(() => setTypes([])); }, []);
  const shown = types.length ? types : [{code:"STANDARD",label:"Standard",description:"Top-terminal job",customerPriceCents:state.rates.installStandardCents},{code:"ADVANCED",label:"Advanced",description:"Buried battery / heavy-duty",customerPriceCents:state.rates.installAdvancedCents}] as typeof types;
  return <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">{shown.map(t => <InstallCard key={t.code} title={t.label} fee={t.customerPriceCents} desc={[t.description, ...(t.requirements ?? [])].filter(Boolean).join(" ")} selected={false} busy={busy} onClick={() => onStep(() => batteryAgentStep({data:{jobId:state.jobId,action:"install",installType:t.code}}))} />)}</div>;
}
function InstallCard({ title, fee, desc, selected, busy, onClick }: { title: string; fee: number; desc: string; selected: boolean; busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className={`rounded-xl border p-3 text-left transition-colors active:scale-[0.99] disabled:opacity-60 ${
        selected ? "border-brand-500 bg-brand-50" : "border-ink-200 bg-surface hover:bg-hover"
      }`}
    >
      <p className="text-sm font-bold text-ink-800">{title}</p>
      <p className="mt-0.5 text-[11px] leading-snug text-ink-500">{desc}</p>
      <p className="mt-1.5 text-base font-black text-brand-600">{money(fee)}</p>
    </button>
  );
}

function QuoteSummary({ state }: { state: BatteryAgentState }) {
  const sale = state.sale;
  if (!sale) return null;
  const rows = [
    ["Battery", money(sale.batteryPriceCents)],
    [`Install (${sale.installType === "advanced" ? "advanced" : "standard"})`, money(sale.installFeeCents)],
    ["Sales tax", money(sale.salesTaxCents)],
    ["Admin fee", money(sale.adminFeeCents)],
  ];
  return (
    <div className="rounded-xl border border-ink-200 bg-ink-50 px-3 py-2.5">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-center justify-between gap-3 py-0.5">
          <span className="text-xs text-ink-500">{label}</span>
          <span className="text-xs font-semibold tabular-nums text-ink-700">{value}</span>
        </div>
      ))}
      <div className="mt-1 flex items-center justify-between gap-3 border-t border-ink-200 pt-1.5">
        <span className="text-xs font-bold text-ink-700">Total</span>
        <span className="text-base font-black tabular-nums text-brand-600">{money(sale.totalCents)}</span>
      </div>
    </div>
  );
}

function VinStep({ state, busy, onStep }: { state: BatteryAgentState; busy: boolean; onStep: (fn: () => Promise<{ ok: boolean } & Record<string, unknown>>) => Promise<void> }) {
  const [vin, setVin] = useState("");
  const [manual, setManual] = useState(false);
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [year, setYear] = useState("");
  const [trim, setTrim] = useState("");
  const [engine, setEngine] = useState("");
  return (
    <div className="mt-3 space-y-2">
      {!manual ? (
        <>
          <input
            type="text"
            inputMode="text"
            autoCapitalize="characters"
            maxLength={17}
            placeholder="17-character VIN — e.g. 1HGCM82633A004352"
            value={vin}
            onChange={(e) => setVin(e.target.value.toUpperCase())}
            className="h-12 w-full rounded-xl border border-ink-200 bg-surface px-3.5 text-sm font-semibold tracking-wider text-ink-900 focus:border-brand-500 focus:outline-2 focus:outline-brand-500/40"
          />
          <Button className="w-full" loading={busy} disabled={vin.trim().length < 10} onClick={() => onStep(() => batteryAgentStep({ data: { jobId: state.jobId, action: "vin", vin: vin.trim() } }))}>
            Look up the VIN
          </Button>
          <button type="button" onClick={() => setManual(true)} className="w-full text-center text-[11px] font-semibold text-ink-500 underline decoration-ink-200 underline-offset-2 hover:text-brand-600">
            Can&apos;t read the VIN? Enter the vehicle manually
          </button>
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <input type="text" placeholder="Make (e.g. Honda)" value={make} onChange={(e) => setMake(e.target.value)} className="h-12 w-full rounded-xl border border-ink-200 bg-surface px-3.5 text-sm text-ink-900 focus:border-brand-500 focus:outline-2 focus:outline-brand-500/40" />
            <input type="text" placeholder="Model (e.g. Accord)" value={model} onChange={(e) => setModel(e.target.value)} className="h-12 w-full rounded-xl border border-ink-200 bg-surface px-3.5 text-sm text-ink-900 focus:border-brand-500 focus:outline-2 focus:outline-brand-500/40" />
          </div>
          <input type="text" inputMode="numeric" maxLength={4} placeholder="Year (e.g. 2019)" value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, "").slice(0, 4))} className="h-12 w-full rounded-xl border border-ink-200 bg-surface px-3.5 text-sm text-ink-900 focus:border-brand-500 focus:outline-2 focus:outline-brand-500/40" />
          <div className="grid grid-cols-2 gap-2">
            <input type="text" placeholder="Trim (optional)" value={trim} onChange={(e) => setTrim(e.target.value)} className="h-12 w-full rounded-xl border border-ink-200 bg-surface px-3.5 text-sm text-ink-900 focus:border-brand-500 focus:outline-2 focus:outline-brand-500/40" />
            <input type="text" placeholder="Engine (optional)" value={engine} onChange={(e) => setEngine(e.target.value)} className="h-12 w-full rounded-xl border border-ink-200 bg-surface px-3.5 text-sm text-ink-900 focus:border-brand-500 focus:outline-2 focus:outline-brand-500/40" />
          </div>
          <Button className="w-full" loading={busy} disabled={!make.trim() || !model.trim() || year.length !== 4} onClick={() => onStep(() => batteryAgentStep({ data: { jobId: state.jobId, action: "vehicle_manual", make: make.trim(), model: model.trim(), year, trim: trim.trim() || undefined, engine: engine.trim() || undefined } }))}>
            Save vehicle
          </Button>
          <button type="button" onClick={() => setManual(false)} className="w-full text-center text-[11px] font-semibold text-ink-500 underline decoration-ink-200 underline-offset-2 hover:text-brand-600">
            Back to VIN lookup
          </button>
        </>
      )}
    </div>
  );
}

/** PAYMENT HAND-OFF — the HARD GATE (owner-spec'd 2026-08-13). Full-screen
 *  customer-present state: the driver hands the phone to the customer, the
 *  customer's card is tokenized by Square's own iframe (never touches the app),
 *  then charged server-side on the owner's Square account. */
function HandoffStep({ state, busy, onStep, onState }: { state: BatteryAgentState; busy: boolean; onStep: (fn: () => Promise<{ ok: boolean } & Record<string, unknown>>) => Promise<void>; onState: (s: BatteryAgentState) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 space-y-2">
      <QuoteSummary state={state} />
      <Button className="w-full" onClick={() => setOpen(true)}>
        <CreditCard className="size-4" /> Hand phone to customer — start payment
      </Button>
      <Button className="w-full" variant="danger-ghost" loading={busy} onClick={() => onStep(() => batteryAgentStep({ data: { jobId: state.jobId, action: "decline" } }))}>
        Customer declined — cancel the sale
      </Button>
      {open && (
        <PaymentOverlay
          state={state}
          onClose={() => setOpen(false)}
          onStep={onStep}
          onState={onState}
        />
      )}
    </div>
  );
}

function PaymentOverlay({ state, onClose, onStep, onState }: { state: BatteryAgentState; onClose: () => void; onStep: (fn: () => Promise<{ ok: boolean } & Record<string, unknown>>) => Promise<void>; onState: (s: BatteryAgentState) => void }) {
  const [card, setCard] = useState<SquareCard | null>(null);
  const [cardError, setCardError] = useState("");
  const [chargeError, setChargeError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const attemptRef = useRef(1);
  const containerIdRef = useRef(`batt-sq-${Math.random().toString(36).slice(2, 10)}`);
  const sale = state.sale;

  useEffect(() => {
    let disposed = false;
    let created: SquareCard | null = null;
    void (async () => {
      try {
        const cfg = await getSquareWebPaymentsConfig();
        if (!cfg.ok) throw new Error(cfg.message || "Payments aren't connected yet.");
        await loadSquareScript();
        if (disposed) return;
        const sq = (window as unknown as { Square?: SquareGlobal }).Square;
        const payments = sq?.payments(cfg.applicationId, cfg.locationId);
        if (!payments) throw new Error("Square payments couldn't start — refresh the page.");
        created = await payments.card();
        await created.attach(`#${containerIdRef.current}`);
        if (disposed) { await created.destroy().catch(() => {}); return; }
        setCard(created);
      } catch (err) {
        if (!disposed) setCardError(err instanceof Error ? err.message : "Couldn't start the card form.");
      }
    })();
    return () => {
      disposed = true;
      if (created) void created.destroy().catch(() => {});
    };
  }, []);

  const charge = async () => {
    if (!card || !sale) return;
    setBusy(true);
    setChargeError("");
    try {
      const tok = await card.tokenize();
      if (tok.status !== "OK" || !tok.token) {
        setChargeError(tok.errors?.[0]?.detail ?? "The card couldn't be read — check the details and try again.");
        return;
      }
      const r = await chargeBatterySale({ data: { saleId: sale.id, token: tok.token, attempt: attemptRef.current } });
      if (r.ok) {
        setDone(true);
        onState(r.state);
        onStep(async () => ({ ok: true, state: r.state }));
      } else {
        setChargeError(r.message);
        if (r.retryable) attemptRef.current += 1;
      }
    } catch {
      setChargeError("Couldn't charge the card — check your connection and try again.");
    }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-ink-950/60 sm:items-center sm:justify-center" role="dialog" aria-modal="true" aria-label="Customer payment">
      <div className="max-h-[94dvh] w-full overflow-y-auto rounded-t-3xl bg-surface p-5 sm:max-w-md sm:rounded-3xl">
        {done ? (
          <div className="py-6 text-center">
            <span className="mx-auto grid size-14 place-items-center rounded-full bg-success-100 text-success-600">
              <Check className="size-7" strokeWidth={3} />
            </span>
            <h2 className="mt-4 text-lg font-black text-ink-900">Battery paid — {money(sale?.totalCents)}</h2>
            <p className="mx-auto mt-1 max-w-full text-sm text-ink-500">
              {state.rates.warehouseAddress
                ? `Head to the warehouse: ${state.rates.warehouseAddress}.`
                : "Head to the warehouse to pick up the battery."}
            </p>
            <p className="mx-auto mt-2 max-w-full text-xs text-ink-400">
              The battery installation job is in your queue.
            </p>
            <Button className="mt-5 w-full" onClick={onClose}>Done — back to the job</Button>
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-brand-600">
                  <ShieldCheck className="size-3.5" /> Customer payment — your phone, their card
                </p>
                <h2 className="mt-1 text-lg font-black tracking-tight text-ink-900">Hand your phone to your customer</h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                aria-label="Close payment"
                className="grid size-10 shrink-0 place-items-center rounded-xl text-ink-400 transition-colors hover:bg-ink-50 disabled:opacity-50"
              >
                <X className="size-5" />
              </button>
            </div>
            <p className="mt-2 rounded-xl bg-brand-50 p-3 text-xs leading-relaxed text-brand-800">
              The card is entered on Square&apos;s secure form — the card number never touches this app. Charging {money(sale?.totalCents)} for the battery sale.
            </p>
            <div id={containerIdRef.current} className="mt-3 rounded-xl border border-ink-200 bg-white px-3 py-2" />
            {cardError && <p role="alert" className="mt-2 text-xs font-medium text-danger-600">{cardError}</p>}
            {chargeError && <p role="alert" className="mt-2 text-xs font-medium text-danger-600">{chargeError}</p>}
            <Button className="mt-4 w-full" loading={busy} disabled={!card} onClick={() => void charge()}>
              {busy ? "Charging…" : `Charge ${money(sale?.totalCents)}`}
            </Button>
            <p className="mt-2 text-center text-[11px] text-ink-400">
              The charge is refunded only by the owner — the battery install job is created automatically once paid.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
