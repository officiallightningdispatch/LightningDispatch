/**
 * AI BATTERY SALES AGENT — SERVER-ONLY core (owner-directed 2026-08-13,
 * Phase 1: pricing + sale flow; owner-spec'd in /home/team/shared/battery-build-brief.md).
 *
 * Jumpstart jobs: the contractor REQUIRED battery test → if faulty, a guided
 * AI-agent sale runs on the ACTIVE jumpstart job (agent prompts, contractor
 * answers; deterministic state machine — the UX is the requirement, the
 * PAYMENT step is deterministic/ungated-by-LLM by design):
 *
 *   test → VIN/vehicle → approved fitment → Lightning product/install type
 *   → LIVE QUOTE → customer approval → PAYMENT HAND-OFF (hard gate:
 *   "Hand your phone to your customer") → Square Web Payments card form in
 *   CUSTOMER-PRESENT mode (the agent NEVER sees/controls the card form — the
 *   nonce is charged server-side with the OWNER's Square credentials, exactly
 *   one idempotent POST /v2/payments) → 'paid' → warehouse instructions + an
 *   auto-created "Battery installation" job in the contractor's queue.
 *
 * PRICING FORMULA (NON-NEGOTIABLE, owner-corrected 2026-08-13):
 *   customerTotal = batteryPrice + installFee + salesTax + adminFee
 *   salesTax = batteryPrice × taxRate (default 6.35% — CT; configurable)
 *   adminFee = batteryPrice × adminFeeRate (default 8.75%)
 *   ** Tax + admin fee apply to the BATTERY PRICE ONLY. The install fee is
 *      neither taxed nor admin-fee'd. **
 *   All rates live in org_settings (owner Settings tab).
 *
 * HARD RAILS: NO PAN storage anywhere (Square nonce-only; last4 max — actually
 * not even last4 here: only the Square payment id is stored). No automated
 * money movement — the charge is CUSTOMER-PRESENT on the contractor's phone.
 * The card form is Square's iframe (client-side SDK); the access token NEVER
 * leaves this module (loadSquareConfig).
 *
 * Agent state is DERIVED from the battery_sales row + dispatch_jobs
 * (battery_test_result): the current step is whatever the row's columns don't
 * yet have. Imported ONLY by the client-safe facade (src/data/battery-sales.ts)
 * and hermetic tests — never by client-reachable modules.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { loadSquareConfig, createCardPayment, squareIdempotencyKey } from "./square-client";
import { resolveJob, isAssignedDriver } from "./driver-photos-core";
import type { PhotoUser } from "./driver-photos-core";
import { canonicalizeNullableVehicleField } from "./battery-compatibility-canonical";

const configured = () => Boolean(process.env.DATABASE_URL);

export type VinDecodeResult =
  | { ok: true; make: string; model: string; year: string; trim: string | null; engine: string | null }
  | { ok: false; message: string };

/** NHTSA supplies identity evidence only; compatibility approval remains authoritative. */
export async function decodeVin(vin: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<VinDecodeResult> {
  const v = String(vin ?? "").toUpperCase().replace(/\s+/g, "");
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return { ok: false, message: "A VIN is 17 characters (letters and numbers, no I, O, or Q). Check it and try again." };
  try {
    const res = await fetchImpl(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(v)}?format=json`, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return { ok: false, message: `The vehicle lookup returned HTTP ${res.status} — try again or enter the vehicle manually.` };
    const body = (await res.json()) as { Results?: Array<Record<string, unknown>> };
    const r = body.Results?.[0];
    if (!r) return { ok: false, message: "The vehicle lookup returned no data — try again or enter the vehicle manually." };
    const make = String(r.Make ?? "").trim(), model = String(r.Model ?? "").trim(), year = String(r.ModelYear ?? "").trim();
    const errorCode = String(r.ErrorCode ?? "0").trim();
    if (errorCode !== "" && errorCode !== "0") return { ok: false, message: `The vehicle lookup couldn't decode this VIN (${errorCode}) — try again or enter the vehicle manually.` };
    if (!make || !model || !/^\d{4}$/.test(year)) return { ok: false, message: "The vehicle lookup came back incomplete — try again or enter the vehicle manually." };
    return { ok: true, make, model, year, trim: canonicalizeNullableVehicleField(r.Trim), engine: canonicalizeNullableVehicleField(r.EngineModel) };
  } catch { return { ok: false, message: "Couldn't reach the vehicle lookup — check the connection or enter the vehicle manually." }; }
}
let schemaInit: Promise<void> | undefined;
function ensure() {
  if (!configured()) return Promise.resolve();
  schemaInit ??= (async () => {
    const { ensureAuthSchema } = await import("./auth-server");
    await ensureAuthSchema();
    const { ensureSchema } = await import("./migrations");
    await ensureSchema();
  })();
  return schemaInit;
}
const db = () => import("~/db").then((m) => m.sql());

/** Resolve the acting driver user + their Towbook driver id (handler helper —
 *  mirrors completion-core.resolveCompletionUser so the battery agent runs for
 *  the same effective identities, including the owner-in-driver-view). */
async function resolveBatteryUser(): Promise<PhotoUser | null> {
  const { currentUser, effectiveDriverIdentity } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return null;
  const identity = await effectiveDriverIdentity(u);
  if (!identity || identity.deactivated) return null;
  const q = await db();
  const rows = await q`SELECT towbook_driver_id FROM users WHERE id=${identity.userRowId}`;
  const user: PhotoUser = {
    orgId: u.orgId,
    id: identity.userRowId,
    role: "contractor",
    towbookDriverId: rows.length ? String(rows[0].towbook_driver_id ?? "") : "",
  };
  if (u.role !== "contractor") {
    user.actorUserId = u.id;
    user.actorRole = u.role;
    user.ownerInDriverView = true;
  }
  return user;
}

/* --------------------------------- pricing --------------------------------- */

export type BatteryQuote = {
  batteryPriceCents: number;
  installFeeCents: number;
  salesTaxCents: number;
  adminFeeCents: number;
  totalCents: number;
};

/** The owner-corrected formula — PURE and exported for the hermetic suite:
 *  salesTax = batteryPrice × taxRateBps (basis points, 635 = 6.35%),
 *  adminFee = batteryPrice × adminFeeBps (875 = 8.75%) — BOTH on the BATTERY
 *  PRICE ONLY; the install fee is never taxed and carries no admin fee. */
export function batteryQuoteCents(
  batteryPriceCents: number,
  installFeeCents: number,
  taxRateBps: number,
  adminFeeBps: number,
): BatteryQuote {
  const salesTaxCents = Math.round((batteryPriceCents * taxRateBps) / 10000);
  const adminFeeCents = Math.round((batteryPriceCents * adminFeeBps) / 10000);
  const totalCents = batteryPriceCents + installFeeCents + salesTaxCents + adminFeeCents;
  return { batteryPriceCents, installFeeCents, salesTaxCents, adminFeeCents, totalCents };
}

/* ------------------------------- NHTSA decode ------------------------------- */

/* --------------------------------- rates --------------------------------- */

export type BatteryRates = {
  taxRateBps: number;
  adminFeeBps: number;
  installStandardCents: number;
  installAdvancedCents: number;
  warehouseAddress: string;
};

/** Read the org's battery rates (org_settings row lazily created with the
 *  owner-spec'd defaults). */
export async function batteryRatesCore(orgId: string): Promise<BatteryRates> {
  const q = await db();
  await q`INSERT INTO org_settings(org_id) VALUES(${orgId}) ON CONFLICT(org_id) DO NOTHING`;
  const rows = await q`SELECT battery_tax_rate_bps, battery_admin_fee_bps,
    battery_install_standard_cents, battery_install_advanced_cents, warehouse_address
    FROM org_settings WHERE org_id=${orgId}`;
  const r = (rows[0] ?? {}) as Record<string, unknown>;
  return {
    taxRateBps: Number(r.battery_tax_rate_bps ?? 635),
    adminFeeBps: Number(r.battery_admin_fee_bps ?? 875),
    installStandardCents: Number(r.battery_install_standard_cents ?? 4500),
    installAdvancedCents: Number(r.battery_install_advanced_cents ?? 6500),
    warehouseAddress: String(r.warehouse_address ?? ""),
  };
}

export type UpdateBatteryRatesResult =
  | { ok: true; rates: BatteryRates }
  | { ok: false; code: "unauthorized" | "invalid_state"; message: string };

/** Owner/admin-only rates update (owner Settings — Battery sales card). */
export async function updateBatteryRatesCore(
  user: { orgId: string; role: string },
  data: unknown,
): Promise<UpdateBatteryRatesResult> {
  const v = z.object({
    taxRateBps: z.number().int().min(0).max(5000),
    adminFeeBps: z.number().int().min(0).max(5000),
    installStandardCents: z.number().int().min(0).max(100000),
    installAdvancedCents: z.number().int().min(0).max(100000),
    warehouseAddress: z.string().max(500).default(""),
  }).safeParse(data);
  if (!v.success) return { ok: false, code: "invalid_state", message: "Enter valid rates (tax + admin fee as basis points, install fees in cents)." };
  if (user.role !== "owner" && user.role !== "admin") {
    return { ok: false, code: "unauthorized", message: "Only the owner can change battery sale rates." };
  }
  try {
    await ensure();
    const q = await db();
    await q`INSERT INTO org_settings(org_id) VALUES(${user.orgId}) ON CONFLICT(org_id) DO NOTHING`;
    await q`UPDATE org_settings SET battery_tax_rate_bps=${v.data.taxRateBps},
      battery_admin_fee_bps=${v.data.adminFeeBps},
      battery_install_standard_cents=${v.data.installStandardCents},
      battery_install_advanced_cents=${v.data.installAdvancedCents},
      warehouse_address=${v.data.warehouseAddress},
      updated_at=NOW() WHERE org_id=${user.orgId}`;
    return { ok: true, rates: await batteryRatesCore(user.orgId) };
  } catch {
    return { ok: false, code: "invalid_state", message: "Couldn't save the rates — try again." };
  }
}

/* --------------------------------- agent state --------------------------------- */

type BatterySaleRowInternal = {
  id: string;
  jobId: string;
  contractorUserId: string;
  /** Raw VIN is internal-only and stripped at every public serializer boundary. */
  vin: string;
  vehicleMake: string;
  vehicleModel: string;
  vehicleYear: string;
  vehicleManual: boolean;
  vehicleConfirmed: boolean;
  compatibilityId: string | null;
  batteryGroupSize: string | null;
  batteryPriceCents: number | null;
  installType: string | null;
  installFeeCents: number | null;
  salesTaxCents: number | null;
  adminFeeCents: number | null;
  totalCents: number | null;
  currency: string;
  status: "quote" | "approved" | "paid" | "voided";
  squareChargeId: string | null;
  declinedReason: string | null;
  installJobId: string | null;
  paidAt: string | null;
};

export type BatteryAgentState = {
  jobId: string;
  /** The agent's current step — the UI renders the prompt + action for it. */
  step:
    | "test"       // REQUIRED battery test — not yet recorded
    | "ok"         // test = OK — no sale needed, completion allowed
    | "vin"        // test = faulty → enter VIN
    | "vehicle"    // VIN decoded (or manual) → confirm the vehicle
    | "install"    // standard / advanced
    | "quote"      // LIVE QUOTE → customer approves or declines
    | "handoff"    // PAYMENT HAND-OFF (hard gate) — hand phone to customer
    | "paid"       // charged — warehouse pickup + install job
    | "voided";    // customer declined — sale recorded, job can complete
  testResult: "ok" | "faulty" | null;
  sale: BatterySaleRow | null;
  /** The auto-created "Battery installation" job (present when paid). */
  installJob: { id: string; status: string } | null;
  rates: BatteryRates;
  /** The agent's next message — driver-readable, agent-style. */
  agentMessage: string;
};

const SALES_COLUMNS = `id, job_id, contractor_user_id, vin, vehicle_make, vehicle_model, vehicle_year, vehicle_manual, vehicle_confirmed, compatibility_id, battery_group_size,
  product_id, install_type_id, battery_price_cents, install_type, install_fee_cents, sales_tax_cents, admin_fee_cents, total_cents, retail_snapshot_cents, installation_snapshot_cents, warranty_years_snapshot, free_replacement_years_snapshot, core_charge_snapshot_cents, driver_payout_snapshot_cents, currency,
  status, square_charge_id, declined_reason, install_job_id, paid_at`;

function mapSaleRow(r: Record<string, unknown>): BatterySaleRowInternal {
  const cents = (v: unknown): number | null => (v == null ? null : Number(v));
  return {
    id: String(r.id),
    jobId: String(r.job_id),
    contractorUserId: String(r.contractor_user_id),
    vin: String(r.vin),
    vehicleMake: String(r.vehicle_make ?? ""),
    vehicleModel: String(r.vehicle_model ?? ""),
    vehicleYear: String(r.vehicle_year ?? ""),
    vehicleManual: r.vehicle_manual === true,
    vehicleConfirmed: r.vehicle_confirmed === true,
    compatibilityId: r.compatibility_id == null ? null : String(r.compatibility_id),
    batteryGroupSize: r.battery_group_size == null ? null : String(r.battery_group_size),
    batteryPriceCents: cents(r.battery_price_cents),
    installType: r.install_type != null ? String(r.install_type) as BatterySaleRowInternal["installType"] : null,
    installFeeCents: cents(r.install_fee_cents),
    salesTaxCents: cents(r.sales_tax_cents),
    adminFeeCents: cents(r.admin_fee_cents),
    totalCents: cents(r.total_cents),
    currency: String(r.currency ?? "USD"),
    status: String(r.status) as BatterySaleRowInternal["status"],
    squareChargeId: r.square_charge_id != null ? String(r.square_charge_id) : null,
    declinedReason: r.declined_reason != null ? String(r.declined_reason) : null,
    installJobId: r.install_job_id != null ? String(r.install_job_id) : null,
    paidAt: r.paid_at != null ? new Date(String(r.paid_at)).toISOString() : null,
  };
}

type JobFacts = { id: string; status: string | null; serviceType: string; batteryTestResult: "ok" | "faulty" | null; towbookJobId: string | null };

async function loadJobFacts(q: Awaited<ReturnType<typeof db>>, orgId: string, jobId: string): Promise<JobFacts | null> {
  const rows = await q`SELECT id, status, service_type, battery_test_result, towbook_job_id
    FROM dispatch_jobs WHERE org_id=${orgId} AND (id=${jobId} OR towbook_job_id=${jobId}) LIMIT 1`;
  if (!rows.length) return null;
  const r = rows[0] as Record<string, unknown>;
  const t = r.battery_test_result != null ? String(r.battery_test_result) : null;
  return {
    id: String(r.id),
    status: r.status != null ? String(r.status) : null,
    serviceType: String(r.service_type ?? ""),
    batteryTestResult: t === "ok" || t === "faulty" ? t : null,
    towbookJobId: r.towbook_job_id != null ? String(r.towbook_job_id) : null,
  };
}

async function loadSale(q: Awaited<ReturnType<typeof db>>, orgId: string, jobId: string): Promise<BatterySaleRow | null> {
  const rows = await q`SELECT ${q.unsafe(SALES_COLUMNS)} FROM battery_sales
    WHERE org_id=${orgId} AND job_id=${jobId} ORDER BY created_at DESC LIMIT 1`;
  if (!rows.length) return null;
  return mapSaleRow(rows[0] as Record<string, unknown>);
}

async function loadInstallJob(q: Awaited<ReturnType<typeof db>>, orgId: string, installJobId: string): Promise<{ id: string; status: string } | null> {
  const rows = await q`SELECT id, status FROM dispatch_jobs WHERE org_id=${orgId} AND id=${installJobId} LIMIT 1`;
  if (!rows.length) return null;
  const r = rows[0] as Record<string, unknown>;
  return { id: String(r.id), status: String(r.status) };
}

/** Derive the agent step + message from the persisted facts (the state machine
 *  is deterministic — the UI just renders the step). */
export function deriveAgentState(facts: JobFacts, sale: BatterySaleRow | BatterySaleRowInternal | null, rates: BatteryRates, installJob: { id: string; status: string } | null): BatteryAgentState {
  const base = {
    jobId: facts.id,
    testResult: facts.batteryTestResult,
    sale: sale ? (({ vin: _vin, ...safeSale }: BatterySaleRowInternal) => safeSale)(sale as BatterySaleRowInternal) : null,
    installJob,
    rates,
    agentMessage: "",
  };
  if (!facts.batteryTestResult) {
    return {
      ...base,
      step: "test",
      agentMessage: "Before this job can be completed, I need the battery test result. Test the battery — is it holding a charge, or is it faulty?",
    };
  }
  if (facts.batteryTestResult === "ok") {
    return {
      ...base,
      step: "ok",
      agentMessage: "The battery is OK — no replacement needed. You can finish the job.",
    };
  }
  // faulty:
  if (sale?.status === "voided") {
    return {
      ...base,
      step: "voided",
      agentMessage: sale.declinedReason
        ? "The customer declined the battery — no charge. You can complete the job; if they change their mind, I can start a new quote."
        : "This sale was voided — no charge. You can complete the job.",
    };
  }
  if (!sale) {
    return {
      ...base,
      step: "vin",
      agentMessage: "The battery is faulty. I'll set up a replacement battery sale — what's the vehicle's VIN (17 characters, on the driver-side dash or door jamb)?",
    };
  }
  if (sale.status === "paid") {
    return {
      ...base,
      step: "paid",
      agentMessage: "Battery paid — head to the warehouse to pick it up. The install job is in your queue.",
    };
  }
  if (sale.status === "approved") {
    return {
      ...base,
      step: "handoff",
      agentMessage: "The customer approved the quote. Hand your phone to your customer to complete payment — the card form is on the next screen.",
    };
  }
  // status 'quote' — walk the remaining inputs in order. The vehicle step shows
  // the decoded/entered vehicle until the driver CONFIRMS it (vehicle_confirmed);
  // manual entry sets confirmed directly, the NHTSA path needs the confirm tap.
  if (!sale.vehicleConfirmed || !sale.vehicleMake || !sale.vehicleModel || !sale.vehicleYear) {
    return {
      ...base,
      step: "vehicle",
      agentMessage: sale.vehicleManual
        ? `Vehicle on file: ${sale.vehicleYear} ${sale.vehicleMake} ${sale.vehicleModel}. Is that right?`
        : `Here's what the VIN says: ${sale.vehicleYear} ${sale.vehicleMake} ${sale.vehicleModel}. Confirm it matches the vehicle.`,
    };
  }
  if (sale.installType == null || sale.batteryPriceCents == null) {
    return {
      ...base,
      step: "install",
      agentMessage: `Fitment confirmed: LIGHTNING GOLD BATTERY GROUP ${sale.batteryGroupSize}. Select the installation type.`,
    };
  }
  return {
    ...base,
    step: "quote",
    agentMessage: `Here's the quote: battery $${(sale.batteryPriceCents / 100).toFixed(2)} + install $${((sale.installFeeCents ?? 0) / 100).toFixed(2)} + tax $${((sale.salesTaxCents ?? 0) / 100).toFixed(2)} + admin fee $${((sale.adminFeeCents ?? 0) / 100).toFixed(2)} = $${((sale.totalCents ?? 0) / 100).toFixed(2)} total. Does the customer approve?`,
  };
}

/** Full agent state for one job — driver (assigned) only. */
export async function batteryAgentStateCore(user: PhotoUser, data: unknown): Promise<{ ok: true; state: BatteryAgentState } | { ok: false; code: "not_found" | "unauthorized"; message: string }> {
  const v = z.object({ jobId: z.string().min(1).max(128) }).safeParse(data);
  if (!v.success) return { ok: false, code: "not_found", message: "Invalid request." };
  try {
    await ensure();
    const q = await db();
    const job = await resolveJob(user.orgId, v.data.jobId);
    if (!job) return { ok: false, code: "not_found", message: "Job not found on your account — refresh the queue." };
    const assigned = await isAssignedDriver(user.orgId, user.id, user.towbookDriverId, job);
    if (!assigned) return { ok: false, code: "unauthorized", message: "This job is not assigned to you." };
    const facts = await loadJobFacts(q, user.orgId, job.id);
    if (!facts) return { ok: false, code: "not_found", message: "Job not found on your account — refresh the queue." };
    const sale = await loadSale(q, user.orgId, job.id);
    const rates = await batteryRatesCore(user.orgId);
    const installJob = sale?.installJobId ? await loadInstallJob(q, user.orgId, sale.installJobId) : null;
    return { ok: true, state: deriveAgentState(facts, sale, rates, installJob) };
  } catch {
    return { ok: false, code: "not_found", message: "Unable to load the battery flow — try again." };
  }
}

/* ------------------------------- agent steps ------------------------------- */

export type BatteryStepResult =
  | { ok: true; state: BatteryAgentState }
  | { ok: false; code: "not_found" | "unauthorized" | "invalid_state" | "square_not_configured"; message: string };

/** Record the REQUIRED battery test result on a jumpstart job. */
export async function recordBatteryTestCore(user: PhotoUser, data: unknown): Promise<BatteryStepResult> {
  const v = z.object({ jobId: z.string().min(1).max(128), result: z.enum(["ok", "faulty"]) }).safeParse(data);
  if (!v.success) return { ok: false, code: "invalid_state", message: "Pick a test result first." };
  try {
    await ensure();
    const q = await db();
    const job = await resolveJob(user.orgId, v.data.jobId);
    if (!job) return { ok: false, code: "not_found", message: "Job not found on your account — refresh the queue." };
    const assigned = await isAssignedDriver(user.orgId, user.id, user.towbookDriverId, job);
    if (!assigned) return { ok: false, code: "unauthorized", message: "This job is not assigned to you." };
    const facts = await loadJobFacts(q, user.orgId, job.id);
    if (!facts || facts.serviceType !== "jump_start") {
      return { ok: false, code: "invalid_state", message: "The battery test is only for jumpstart jobs." };
    }
    await q`UPDATE dispatch_jobs SET battery_test_result=${v.data.result}, battery_tested_at=NOW() WHERE id=${job.id} AND org_id=${user.orgId}`;
    try {
      await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
        SELECT gen_random_uuid()::text, ${user.orgId}, ${user.id}, ${user.role}, 'battery_test', 'job', ${job.id},
          ${JSON.stringify({ result: v.data.result, towbookJobId: job.towbookJobId })}::jsonb, 'battery-agent'`;
    } catch { /* best-effort audit */ }
    const sale = await loadSale(q, user.orgId, job.id);
    const rates = await batteryRatesCore(user.orgId);
    const facts2 = await loadJobFacts(q, user.orgId, job.id);
    return { ok: true, state: deriveAgentState(facts2!, sale, rates, null) };
  } catch {
    return { ok: false, code: "invalid_state", message: "Couldn't record the test result — try again." };
  }
}

type StepPayload = {
  jobId: string;
  action: "vin" | "vehicle_manual" | "confirm_vehicle" | "install" | "approve" | "decline";
  vin?: string;
  make?: string;
  model?: string;
  year?: string;
  trim?: string;
  engine?: string;
  installType?: string;
};

/** ONE agent step. Every step is validated against the derived machine state:
 *  the server decides what the current step is (never the client), so a client
 *  can't skip the hand-off gate or approve its own quote. */
export async function batteryAgentStepCore(user: PhotoUser, data: unknown, opts: { fetchImpl?: typeof fetch } = {}): Promise<BatteryStepResult> {
  const v = z.object({
    jobId: z.string().min(1).max(128),
    action: z.enum(["vin", "vehicle_manual", "confirm_vehicle", "install", "approve", "decline"]),
    vin: z.string().max(17).optional(),
    make: z.string().max(80).optional(),
    model: z.string().max(80).optional(),
    year: z.string().max(10).optional(),
    trim: z.string().max(120).optional(),
    engine: z.string().max(120).optional(),
    installType: z.string().max(40).optional(),
  }).safeParse(data);
  if (!v.success) return { ok: false, code: "invalid_state", message: "Invalid step." };
  const p = v.data as StepPayload;
  try {
    await ensure();
    const q = await db();
    const job = await resolveJob(user.orgId, p.jobId);
    if (!job) return { ok: false, code: "not_found", message: "Job not found on your account — refresh the queue." };
    const assigned = await isAssignedDriver(user.orgId, user.id, user.towbookDriverId, job);
    if (!assigned) return { ok: false, code: "unauthorized", message: "This job is not assigned to you." };
    const facts = await loadJobFacts(q, user.orgId, job.id);
    if (!facts || facts.serviceType !== "jump_start") {
      return { ok: false, code: "invalid_state", message: "The battery sale is only for jumpstart jobs." };
    }
    if (facts.batteryTestResult !== "faulty") {
      return { ok: false, code: "invalid_state", message: "The battery test must be marked faulty before a sale can start." };
    }
    let sale = await loadSale(q, user.orgId, job.id);
    if (sale && sale.status === "voided") sale = null; // a voided sale frees the slot — start fresh

    const rates = await batteryRatesCore(user.orgId);

    if (p.action === "vin") {
      if (!p.vin || String(p.vin).length < 10) {
        return { ok: false, code: "invalid_state", message: "Enter the full 17-character VIN." };
      }
      const decoded = await decodeVin(p.vin, opts.fetchImpl ?? globalThis.fetch);
      if (!decoded.ok) return { ok: false, code: "invalid_state", message: decoded.message };
      const { lookupBatteryCompatibilityCore } = await import("./battery-compat-core");
      const compatibility = await lookupBatteryCompatibilityCore({ orgId:user.orgId, role:user.role, id:user.id, towbookDriverId:user.towbookDriverId }, { jobId:job.id, make:decoded.make, model:decoded.model, year:decoded.year, trim:decoded.trim, engine:decoded.engine });
      if (!compatibility.ok || compatibility.outcome !== "matched") return { ok:false, code:"invalid_state", message:"We could not safely confirm the battery fitment for this vehicle. No battery sale can be started. Please have the dispatcher or owner review the vehicle." };
      sale = await upsertQuote(q, user, job.id, {
        vin: String(p.vin).toUpperCase(),
        make: decoded.make,
        model: decoded.model,
        year: decoded.year,
        manual: false,
        confirmed: false, compatibilityId: compatibility.match.compatibilityId, batteryGroupSize: compatibility.match.batteryGroupSize
      });
      await audit(q, user, job, "battery_vin_decoded", { vin_sha256: createHash("sha256").update(String(p.vin).toUpperCase()).digest("hex"), make: decoded.make, model: decoded.model, year: decoded.year });
      return { ok: true, state: deriveAgentState(facts, sale, rates, null) };
    }

    if (p.action === "vehicle_manual") {
      const make = String(p.make ?? "").trim();
      const model = String(p.model ?? "").trim();
      const year = String(p.year ?? "").trim();
      if (!make || !model || !/^\d{4}$/.test(year)) {
        return { ok: false, code: "invalid_state", message: "Enter the make, model, and 4-digit year." };
      }
      // Manual entry must use the exact same canonical, approved-only lookup as
      // the VIN/NHTSA path. Never create a sale from an unconfirmed fitment.
      const { lookupBatteryCompatibilityCore } = await import("./battery-compat-core");
      const compatibility = await lookupBatteryCompatibilityCore(
        { orgId: user.orgId, role: user.role, id: user.id, towbookDriverId: user.towbookDriverId },
        { jobId: job.id, make, model, year, trim: p.trim ?? null, engine: p.engine ?? null },
      );
      if (!compatibility.ok) return { ok: false, code: compatibility.reason === "unauthorized" ? "unauthorized" : "invalid_state", message: "Vehicle compatibility requires dispatcher or owner review." };
      if (compatibility.outcome !== "matched") {
        return { ok: false, code: "invalid_state", message: "We could not safely confirm the battery fitment for this vehicle. No battery sale can be started. Please have the dispatcher or owner review the vehicle." };
      }
      sale = await upsertQuote(q, user, job.id, { vin: "", make, model, year, manual: true, confirmed: true, compatibilityId: compatibility.match.compatibilityId, batteryGroupSize: compatibility.match.batteryGroupSize });
      await audit(q, user, job, "battery_vehicle_manual", { make, model, year, trim: p.trim ?? null, engine: p.engine ?? null, compatibilityId: compatibility.match.compatibilityId, batteryGroupSize: compatibility.match.batteryGroupSize });
      return { ok: true, state: deriveAgentState(facts, sale, rates, null) };
    }

    if (!sale) return { ok: false, code: "invalid_state", message: "Enter the VIN first." };

    if (p.action === "confirm_vehicle") {
      if (!sale.vehicleMake || !sale.vehicleModel || !sale.vehicleYear) {
        return { ok: false, code: "invalid_state", message: "No vehicle on file yet — enter the VIN first." };
      }
      await q`UPDATE battery_sales SET vehicle_confirmed=TRUE WHERE id=${sale.id} AND org_id=${user.orgId}`;
      await audit(q, user, job, "battery_vehicle_confirmed", { saleId: sale.id, vehicle: `${sale.vehicleYear} ${sale.vehicleMake} ${sale.vehicleModel}` });
      const afterConfirm = await loadSale(q, user.orgId, job.id);
      sale = afterConfirm ?? sale;
      return { ok: true, state: deriveAgentState(facts, sale, rates, null) };
    }

    if (p.action === "install") {
      if (!sale.vehicleConfirmed || !sale.compatibilityId || !sale.batteryGroupSize) return { ok: false, code: "invalid_state", message: "Approved vehicle fitment is required first." };
      const code = String(p.installType ?? "").toUpperCase();
      const types = await q`SELECT id, code, customer_price_cents, driver_payout_cents FROM battery_install_types WHERE org_id=${user.orgId} AND code=${code} AND active=true LIMIT 1`;
      let installTypeId: string, installFeeCents: number, driverPayoutCents: number;
      if (types.length) { const t=types[0] as Record<string,unknown>; installTypeId=String(t.id); installFeeCents=Number(t.customer_price_cents); driverPayoutCents=Number(t.driver_payout_cents); }
      else if (code === "STANDARD" || code === "ADVANCED") { installTypeId=""; installFeeCents=code === "ADVANCED" ? rates.installAdvancedCents : rates.installStandardCents; driverPayoutCents=code === "ADVANCED" ? 6500 : 4500; }
      else return { ok: false, code: "invalid_state", message: "Select an available installation type." };
      const productRows = await q`SELECT id, retail_cents, installation_cents, warranty_years, free_replacement_years, core_charge_cents, display_name FROM battery_products WHERE org_id=${user.orgId} AND group_size=${sale.batteryGroupSize} AND active=true AND availability <> 'unavailable' LIMIT 1`;
      if (!productRows.length) return { ok: false, code: "invalid_state", message: "This fitment is awaiting dispatcher or owner review." };
      const product=productRows[0] as Record<string,unknown>; const batteryPriceCents=Number(product.retail_cents);
      const quote = batteryQuoteCents(batteryPriceCents, installFeeCents, rates.taxRateBps, rates.adminFeeBps);
      await q`UPDATE battery_sales SET product_id=${String(product.id)}, install_type_id=${installTypeId || null}, install_type=${code}, battery_price_cents=${batteryPriceCents}, install_fee_cents=${quote.installFeeCents}, sales_tax_cents=${quote.salesTaxCents}, admin_fee_cents=${quote.adminFeeCents}, total_cents=${quote.totalCents}, retail_snapshot_cents=${batteryPriceCents}, installation_snapshot_cents=${quote.installFeeCents}, warranty_years_snapshot=${Number(product.warranty_years)}, free_replacement_years_snapshot=${Number(product.free_replacement_years)}, core_charge_snapshot_cents=${Number(product.core_charge_cents)}, driver_payout_snapshot_cents=${driverPayoutCents}, customer_facing_brand='LIGHTNING GOLD BATTERY' WHERE id=${sale.id} AND org_id=${user.orgId}`;
      sale = (await loadSale(q,user.orgId,job.id)) ?? sale;
      await audit(q, user, job, "battery_install_type", { installType: code, quote });
      return { ok: true, state: deriveAgentState(facts, sale, rates, null) };
    }
    // quote OR approved (hand-off) — approve is only allowed from quote;
    // decline is allowed at either point (a customer can back out at the
    // payment hand-off too).
    if (p.action === "approve" && sale.status !== "quote") {
      return { ok: false, code: "invalid_state", message: "This quote is no longer open." };
    }
    if (p.action === "decline" && sale.status !== "quote" && sale.status !== "approved") {
      return { ok: false, code: "invalid_state", message: "This quote is no longer open." };
    }
    if (p.action === "approve") {
      await q`UPDATE battery_sales SET status='approved' WHERE id=${sale.id} AND org_id=${user.orgId}`;
      await audit(q, user, job, "battery_customer_approved", { saleId: sale.id, totalCents: sale.totalCents });
      const afterApprove = await loadSale(q, user.orgId, job.id);
      sale = afterApprove ?? sale;
      return { ok: true, state: deriveAgentState(facts, sale, rates, null) };
    }
    if (p.action === "decline") {
      await q`UPDATE battery_sales SET status='voided', declined_reason='customer declined the battery' WHERE id=${sale.id} AND org_id=${user.orgId}`;
      await audit(q, user, job, "battery_customer_declined", { saleId: sale.id });
      const afterDecline = await loadSale(q, user.orgId, job.id);
      sale = afterDecline ?? sale;
      return { ok: true, state: deriveAgentState(facts, sale, rates, null) };
    }
    return { ok: false, code: "invalid_state", message: "Unknown step." };
  } catch {
    return { ok: false, code: "invalid_state", message: "Couldn't complete that step — try again." };
  }
}

async function upsertQuote(
  q: Awaited<ReturnType<typeof db>>,
  user: PhotoUser,
  jobId: string,
  vehicle: { vin: string; make: string; model: string; year: string; manual: boolean; confirmed: boolean; compatibilityId?: string | null; batteryGroupSize?: string | null; },
): Promise<BatterySaleRowInternal> {
  const rows = await q`INSERT INTO battery_sales(id, org_id, job_id, contractor_user_id, vin, vehicle_make, vehicle_model, vehicle_year, vehicle_manual, vehicle_confirmed, product_id, install_type_id, battery_price_cents, install_type, install_fee_cents, sales_tax_cents, admin_fee_cents, total_cents, currency, status)
    VALUES(gen_random_uuid()::text, ${user.orgId}, ${jobId}, ${user.id}, ${vehicle.vin}, ${vehicle.make}, ${vehicle.model}, ${vehicle.year}, ${vehicle.manual}, ${vehicle.confirmed}, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'USD', 'quote')
    ON CONFLICT (org_id, job_id) WHERE status IN ('quote','approved')
    DO UPDATE SET vin=EXCLUDED.vin, vehicle_make=EXCLUDED.vehicle_make, vehicle_model=EXCLUDED.vehicle_model,
    vehicle_year=EXCLUDED.vehicle_year, vehicle_manual=EXCLUDED.vehicle_manual, vehicle_confirmed=EXCLUDED.vehicle_confirmed, compatibility_id=${vehicle.compatibilityId ?? null}, battery_group_size=${vehicle.batteryGroupSize ?? null},
      product_id=NULL, install_type_id=NULL, battery_price_cents=NULL, install_type=NULL, install_fee_cents=NULL, sales_tax_cents=NULL, admin_fee_cents=NULL, total_cents=NULL
    RETURNING ${q.unsafe(SALES_COLUMNS)}`;
  return mapSaleRow(rows[0] as Record<string, unknown>);
}

async function audit(q: Awaited<ReturnType<typeof db>>, user: PhotoUser, job: { id: string; towbookJobId: string | null }, action: string, detail: Record<string, unknown>): Promise<void> {
  try {
    await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
      SELECT gen_random_uuid()::text, ${user.orgId}, ${user.id}, ${user.role}, ${action}, 'job', ${job.id},
        ${JSON.stringify({ ...detail, towbookJobId: job.towbookJobId })}::jsonb, 'battery-agent'`;
  } catch { /* best-effort audit — never mask the agent step */ }
}

/* --------------------------------- charge --------------------------------- */

export type BatteryChargeResult =
  | { ok: true; state: BatteryAgentState }
  | { ok: false; code: "not_found" | "unauthorized" | "invalid_state" | "square_not_configured" | "square_failed"; message: string; retryable?: boolean };

/** THE payment step — deterministic, never LLM-gated. The card NONCE was
 *  created CLIENT-SIDE by Square's Web Payments SDK in the customer-present
 *  hand-off form; it is charged HERE with the OWNER's Bearer token (exactly one
 *  idempotent POST /v2/payments, idempotency key squareIdempotencyKey("battery-",
 *  sale.id, attempt) — hashed ≤45 chars (the raw `battery-<uuid>-<attempt>` was
 *  46–47 chars and Square rejects idempotency_key > 45 with HTTP 400
 *  VALUE_TOO_LONG, the same 2026-08-13 incident that broke every club charge). On
 *  success the sale flips to 'paid' and the "Battery installation" job is
 *  auto-created for the SAME contractor. Injectable fetchImpl + squareStableDir
 *  for hermetic tests. */
export async function chargeBatterySaleCore(
  user: PhotoUser,
  data: unknown,
  opts: { fetchImpl?: typeof fetch; squareStableDir?: string } = {},
): Promise<BatteryChargeResult> {
  const v = z.object({
    saleId: z.string().min(1).max(128),
    token: z.string().min(8).max(4096), // Square Web Payments card nonce
    attempt: z.number().int().min(1).max(50).default(1),
  }).safeParse(data);
  if (!v.success) return { ok: false, code: "invalid_state", message: "Invalid payment request." };
  let config;
  try {
    config = await loadSquareConfig(process.env, { stableDir: opts.squareStableDir });
  } catch (err) {
    return { ok: false, code: "square_not_configured", message: err instanceof Error ? err.message : "Payments aren't connected yet." };
  }
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT ${q.unsafe(SALES_COLUMNS)} FROM battery_sales WHERE id=${v.data.saleId} AND org_id=${user.orgId} LIMIT 1`;
    if (!rows.length) return { ok: false, code: "not_found", message: "Sale not found." };
    const sale = mapSaleRow(rows[0] as Record<string, unknown>);
    const job = await resolveJob(user.orgId, sale.jobId);
    if (!job) return { ok: false, code: "not_found", message: "Job not found — refresh the queue." };
    const assigned = await isAssignedDriver(user.orgId, user.id, user.towbookDriverId, job);
    if (!assigned) return { ok: false, code: "unauthorized", message: "This job is not assigned to you." };
    if (sale.status === "paid") {
      // Idempotent replay (network retry after a successful charge) — return the
      // SAME paid state without re-charging.
      const rates = await batteryRatesCore(user.orgId);
      const facts = await loadJobFacts(q, user.orgId, job.id);
      const installJob = sale.installJobId ? await loadInstallJob(q, user.orgId, sale.installJobId) : null;
      return { ok: true, state: deriveAgentState(facts!, sale, rates, installJob) };
    }
    if (sale.status !== "approved" || sale.totalCents == null) {
      return { ok: false, code: "invalid_state", message: "The quote must be approved before payment." };
    }

    const driverNameRows = await q`SELECT name FROM users WHERE id=${user.id} LIMIT 1`;
    const driverName = driverNameRows.length && driverNameRows[0].name ? String(driverNameRows[0].name) : `Driver ${user.towbookDriverId}`;
    // SQUARE KEY LENGTH FIX (2026-08-13 incident): `battery-<saleId>-<attempt>`
    // with a gen_random_uuid() sale id is 46–47 chars — Square's
    // idempotency_key limit is 45 (HTTP 400 VALUE_TOO_LONG on every charge).
    // The hashed key is deterministic per (sale, attempt): a replayed attempt
    // carries the SAME key (Square returns the same payment — no double
    // charge), a bumped attempt gets a fresh key, and the key always fits.
    const idempotencyKey = squareIdempotencyKey("battery-", sale.id, v.data.attempt);
    const note = `Battery sale — ${sale.vehicleYear} ${sale.vehicleMake} ${sale.vehicleModel} — ${driverName}`;

    await q`UPDATE battery_sales SET charge_attempt=${v.data.attempt} WHERE id=${sale.id}`;
    let payment;
    try {
      payment = await createCardPayment({
        config,
        idempotencyKey,
        sourceId: v.data.token,
        amountCents: sale.totalCents,
        currency: sale.currency,
        note,
        fetchImpl: opts.fetchImpl,
      });
    } catch (err) {
      await audit(q, user, job, "battery_charge_failed", { saleId: sale.id, attempt: v.data.attempt, error: (err instanceof Error ? err.message : "payment failed").slice(0, 400) });
      return { ok: false, code: "square_failed", message: err instanceof Error ? err.message : "The card couldn't be charged — try again.", retryable: true };
    }
    const terminal = payment.status === "FAILED" || payment.status === "CANCELED";
    if (terminal) {
      await audit(q, user, job, "battery_charge_failed", { saleId: sale.id, attempt: v.data.attempt, squarePaymentId: payment.paymentId, error: `Square declined (${payment.status})` });
      return { ok: false, code: "square_failed", message: `The card was declined (${payment.status}). Ask the customer for another card or try again.`, retryable: true };
    }

    // Success — flip the sale and auto-create the install job in one go.
    const installJobId = await createInstallJob(q, user, job, sale, driverName);
    await q`UPDATE battery_sales SET status='paid', square_charge_id=${payment.paymentId}, install_job_id=${installJobId}, paid_at=NOW()
      WHERE id=${sale.id} AND org_id=${user.orgId}`;
    await audit(q, user, job, "battery_paid", { saleId: sale.id, paymentId: payment.paymentId, totalCents: sale.totalCents, installJobId });
    const rates = await batteryRatesCore(user.orgId);
    const facts = await loadJobFacts(q, user.orgId, job.id);
    const updatedSale = await loadSale(q, user.orgId, job.id);
    const installJob = await loadInstallJob(q, user.orgId, installJobId);
    return { ok: true, state: deriveAgentState(facts!, updatedSale!, rates, installJob) };
  } catch (err) {
    return { ok: false, code: "square_failed", message: err instanceof Error ? err.message : "Couldn't charge the card — try again.", retryable: true };
  }
}

/** Auto-create the "Battery installation" job (service_type battery_install),
 *  assigned to the SAME contractor, linked to the sale (battery price, install
 *  fee, vehicle, VIN in the note + raw_json) — follows the platform job-creation
 *  pattern (dispatch_jobs + status_events + audit_log). Returns the new job id. */
async function createInstallJob(
  q: Awaited<ReturnType<typeof db>>,
  user: PhotoUser,
  sourceJob: { id: string; towbookJobId: string | null },
  sale: BatterySaleRowInternal,
  driverName: string,
): Promise<string> {
  const src = await q`SELECT customer_name, phone, lat, lng, area, pickup, pickup_lat, pickup_lng, assigned_driver_towbook_id, assigned_driver_name, note
    FROM dispatch_jobs WHERE id=${sourceJob.id} AND org_id=${user.orgId} LIMIT 1`;
  const s = (src[0] ?? {}) as Record<string, unknown>;
  const jobId = `install-${sale.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}`;
  const assignedTowbookId = s.assigned_driver_towbook_id != null ? String(s.assigned_driver_towbook_id) : user.towbookDriverId || null;
  const vehicle = `${sale.vehicleYear} ${sale.vehicleMake} ${sale.vehicleModel}`;
  const note = `Battery installation — ${vehicle} · battery $${(sale.batteryPriceCents ?? 0) / 100} · install fee $${(sale.installFeeCents ?? 0) / 100} · paid`;
  const area = String(s.area ?? s.pickup ?? "Unknown");
  await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note,
      towbook_job_id, customer_phone, vehicle_desc, pickup, dropoff, towbook_status, raw_json, pickup_lat, pickup_lng,
      assigned_driver_towbook_id, assigned_driver_name, battery_test_result, battery_tested_at)
    VALUES(${jobId}, ${user.orgId}, ${String(s.customer_name ?? "Battery installation")}, ${String(s.phone ?? "")}, ${Number(s.lat ?? 0)}, ${Number(s.lng ?? 0)},
      ${area}, 'battery_install', 'offered', NOW(), ${note}, NULL, ${String(s.phone ?? "")}, ${vehicle}, ${String(s.pickup ?? area)},
      ${String(s.dropoff ?? "")}, '1', ${JSON.stringify({ batterySaleId: sale.id, vehicle, batteryPriceCents: sale.batteryPriceCents, installFeeCents: sale.installFeeCents, sourceJobId: sourceJob.id })}::jsonb,
      ${s.pickup_lat != null ? Number(s.pickup_lat) : null}, ${s.pickup_lng != null ? Number(s.pickup_lng) : null},
      ${assignedTowbookId}, ${String(s.assigned_driver_name ?? driverName)}, NULL, NULL)
    ON CONFLICT (id) DO NOTHING`;
  await q`INSERT INTO status_events(id, org_id, job_id, from_status, to_status, actor_user_id, actor_role, note)
    SELECT gen_random_uuid()::text, ${user.orgId}, ${jobId}, 'new', 'offered', ${user.id}, ${user.role}, 'auto-created battery installation job from paid battery sale'`;
  await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
    SELECT gen_random_uuid()::text, ${user.orgId}, ${user.id}, ${user.role}, 'battery_install_job_created', 'job', ${jobId},
      ${JSON.stringify({ batterySaleId: sale.id, sourceJobId: sourceJob.id, towbookJobId: null })}::jsonb, 'battery-agent'`;
  return jobId;
}

/* ------------------------------- owner views ------------------------------- */

export type BatterySaleRow = Omit<BatterySaleRowInternal, "vin">;

export type BatterySaleOwnerRow = BatterySaleRow & {
  contractorName: string;
  jobLabel: string;
};

/** Owner/admin read — every battery sale for the org, newest first, with the
 *  contractor name + job label. Read-only list (the charge happens on the
 *  contractor's phone, customer-present). */
export async function listBatterySalesCore(orgId: string): Promise<BatterySaleOwnerRow[]> {
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT bs.id, bs.job_id, bs.contractor_user_id, bs.vin, bs.vehicle_make, bs.vehicle_model, bs.vehicle_year, bs.vehicle_manual, bs.vehicle_confirmed,
        bs.battery_price_cents, bs.install_type, bs.install_fee_cents, bs.sales_tax_cents, bs.admin_fee_cents, bs.total_cents, bs.currency,
        bs.status, bs.square_charge_id, bs.declined_reason, bs.install_job_id, bs.paid_at,
        u.name AS contractor_name, dj.customer_name AS job_label
      FROM battery_sales bs
      LEFT JOIN users u ON u.id = bs.contractor_user_id
      LEFT JOIN dispatch_jobs dj ON dj.id = bs.job_id
      WHERE bs.org_id=${orgId}
      ORDER BY bs.created_at DESC LIMIT 500`;
    return (rows as Record<string, unknown>[]).map((r) => {
      const { vin: _vin, ...safeSale } = mapSaleRow(r);
      return { ...safeSale,
        contractorName: r.contractor_name != null ? String(r.contractor_name) : "Contractor",
        jobLabel: r.job_label != null ? String(r.job_label) : String(r.job_id),
      };
    });
  } catch {
    return [];
  }
}

/* -------------------------------- handlers -------------------------------- */

export async function batteryAgentStateHandler(data: unknown) {
  if (!configured()) return { ok: false as const, code: "not_found" as const, message: "The battery flow requires database mode." };
  const u = await resolveBatteryUser();
  if (!u) return { ok: false as const, code: "unauthorized" as const, message: "Sign in as a driver first." };
  return batteryAgentStateCore(u, data);
}
export async function recordBatteryTestHandler(data: unknown) {
  if (!configured()) return { ok: false as const, code: "invalid_state" as const, message: "The battery flow requires database mode." };
  const u = await resolveBatteryUser();
  if (!u) return { ok: false as const, code: "unauthorized" as const, message: "Sign in as a driver first." };
  return recordBatteryTestCore(u, data);
}
export async function batteryAgentStepHandler(data: unknown, opts?: { fetchImpl?: typeof fetch }) {
  if (!configured()) return { ok: false as const, code: "invalid_state" as const, message: "The battery flow requires database mode." };
  const u = await resolveBatteryUser();
  if (!u) return { ok: false as const, code: "unauthorized" as const, message: "Sign in as a driver first." };
  return batteryAgentStepCore(u, data, opts);
}
export async function chargeBatterySaleHandler(data: unknown, opts?: { fetchImpl?: typeof fetch; squareStableDir?: string }) {
  if (!configured()) return { ok: false as const, code: "square_not_configured" as const, message: "Payments require database mode." };
  const u = await resolveBatteryUser();
  if (!u) return { ok: false as const, code: "unauthorized" as const, message: "Sign in as a driver first." };
  return chargeBatterySaleCore(u, data, opts);
}
export async function listBatterySalesHandler() {
  if (!configured()) return [] as BatterySaleOwnerRow[];
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u || (u.role !== "owner" && u.role !== "admin" && u.role !== "dispatcher")) return [] as BatterySaleOwnerRow[];
  return listBatterySalesCore(u.orgId);
}
export async function getBatteryRatesHandler() {
  if (!configured()) return { ok: false as const, code: "invalid_state" as const, message: "Requires database mode." };
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, code: "unauthorized" as const, message: "Sign in first." };
  return { ok: true as const, rates: await batteryRatesCore(u.orgId) };
}
export async function updateBatteryRatesHandler(data: unknown) {
  if (!configured()) return { ok: false as const, code: "invalid_state" as const, message: "Requires database mode." };
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, code: "unauthorized" as const, message: "Sign in first." };
  return updateBatteryRatesCore({ orgId: u.orgId, role: u.role }, data);
}
