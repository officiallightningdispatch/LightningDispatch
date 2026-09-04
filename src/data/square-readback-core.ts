/**
 * "Square as source of truth" READ-BACK + reconciliation core (owner-directed
 * 2026-09-04, Slice 1) — SERVER-ONLY.
 *
 * Read-only: this module NEVER takes a payment, never mutates payment behavior,
 * and never touches dispatch / auth. It reads the org's locally-settled tip /
 * tire-plug / battery rows and reconciles each one against Square's own record
 * (GetPayment), emitting a per-driver + per-kind report plus a summary. Square's
 * record is authoritative: a local "paid" row that Square says FAILED/CANCELED,
 * was REFUNDED, is MISSING (404), or has a DIFFERENT total_money is flagged.
 *
 * Read endpoints used (Square API base https://connect.squareup.com/v2,
 * Authorization: Bearer <accessToken>, Square-Version: 2025-01-23):
 *   GET  /v2/payments?limit=&cursor=&location_id=     (ListPayments)
 *   GET  /v2/payments/{payment_id}                    (GetPayment)
 *   POST /v2/orders/search  {location_ids,cursor}     (SearchOrders — Slice 2+)
 * Pagination: a `cursor` field on the response; loop until absent.
 *
 * Fail-closed: any loadSquareConfig throw → square_not_configured; any non-2xx
 * read → square_read_error (never a fake success, never partial data presented
 * as complete). GetPayment failures during reconcile are recorded per-row as
 * square_read_error and the sweep CONTINUES (one bad payment can't hide the
 * rest).
 *
 * Imported ONLY by the client-safe facade (./square-readback.ts, whose
 * createServerFn handlers dynamic-import this module) and by hermetic tests.
 * Static server imports are fine here — this module never enters the client
 * bundle graph (the facade only `import type`s from it).
 */
import { sql } from "~/db";
import { loadSquareConfig } from "./square-client";
import type { SquareConfig } from "./square-client";

export type SquareReadbackActor = { orgId: string; id: string; role: string };

/* --------------------------- Square read shapes --------------------------- */
export type SquarePaymentSummary = {
  id: string;
  status: string;
  totalAmountCents: number | null;
  tipAmountCents: number | null;
  refunded: boolean;
  refundedAmountCents: number | null;
};

export type SquareOrderSummary = {
  id: string;
  state: string;
  totalMoneyCents: number | null;
};

export type SquareReadbackErrorCode =
  | "unauthorized"
  | "database_error"
  | "square_not_configured"
  | "square_read_error";

export type SquareListPaymentsResult =
  | { ok: true; payments: SquarePaymentSummary[]; cursor: string | null }
  | { ok: false; code: SquareReadbackErrorCode; status: number | null; message: string };

export type SquareGetPaymentResult =
  | { ok: true; payment: SquarePaymentSummary }
  | { ok: false; code: "square_missing" | "square_read_error"; status: number | null; message: string };

export type SquareSearchOrdersResult =
  | { ok: true; orders: SquareOrderSummary[]; cursor: string | null }
  | { ok: false; code: SquareReadbackErrorCode; status: number | null; message: string };

/* ----------------------------- reconciliation ----------------------------- */
export type ReconcileVerdict =
  | "ok"
  | "square_missing"
  | "square_refunded"
  | "square_failed"
  | "square_amount_mismatch"
  | "square_read_error";

export type ReconcileKind = "tip" | "tire_plug" | "battery";

export type ReconcileRow = {
  kind: ReconcileKind;
  localRowId: string;
  jobId: string;
  driverId: string;
  localStatus: string;
  localAmountCents: number;
  squarePaymentId: string;
  squareStatus: string | null;
  squareTotalAmountCents: number | null;
  squareTipAmountCents: number | null;
  squareRefunded: boolean;
  squareRefundedAmountCents: number | null;
  match: ReconcileVerdict;
  message: string | null;
};

export type ReconcileDriverSummary = {
  driverId: string;
  localCount: number;
  squareConfirmedCount: number;
  localAmountCents: number;
  squareConfirmedAmountCents: number;
  refundedCount: number;
  failedCount: number;
  missingCount: number;
  readErrorCount: number;
  mismatchCount: number;
};

export type ReconcileSummary = {
  totalLocalSettledCount: number;
  totalSquareConfirmed: number;
  totalRefunded: number;
  totalFailed: number;
  totalMissing: number;
  totalReadError: number;
  totalMismatch: number;
  totalLocalAmountCents: number;
  totalSquareConfirmedAmountCents: number;
  byDriver: ReconcileDriverSummary[];
};

export type ReconcileResult =
  | { ok: true; rows: ReconcileRow[]; summary: ReconcileSummary }
  | { ok: false; code: "unauthorized" | "database_error" | "square_not_configured"; message: string };

/* ------------------------------- helpers ------------------------------- */
const SQ_BASE = "https://connect.squareup.com/v2";
const SQ_VERSION = "2025-01-23";
const OWNER_ROLES = ["owner", "admin"] as const;

const configured = () => Boolean(process.env.DATABASE_URL);
let schemaInit: Promise<void> | undefined;
function ensure() {
  if (!configured()) return Promise.resolve();
  schemaInit ??= (async () => {
    const { ensureSchema } = await import("./migrations");
    await ensureSchema();
  })();
  return schemaInit;
}

const centsOf = (v: unknown): number | null => (v == null ? null : Math.round(Number(v)));
const moneyAmount = (m: unknown): number | null => centsOf((m as Record<string, unknown> | null | undefined)?.amount);

async function readJson<T = unknown>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number | null; body: T | null; error: string | null }> {
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (e) {
    return { ok: false, status: null, body: null, error: e instanceof Error ? e.message : "Square request failed." };
  }
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = null; }
  }
  return { ok: res.ok, status: res.status, body: body as T | null, error: null };
}

const authHeaders = (config: SquareConfig) => ({
  authorization: `Bearer ${config.accessToken}`,
  "square-version": SQ_VERSION,
});

function normalizePayment(raw: unknown): SquarePaymentSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const refunds = Array.isArray(p.refunds) ? (p.refunds as unknown[]) : [];
  const refundedMoney = (p.refunded_money as Record<string, unknown> | null)?.amount;
  const refundedAmount = centsOf(refundedMoney) ?? refunds.reduce<number | null>((acc, r) => {
    const rec = r as Record<string, unknown> | null | undefined;
    const a = moneyAmount(rec?.amount_money);
    return acc == null ? a : acc + (a ?? 0);
  }, null);
  const refunded = (refundedMoney != null && centsOf(refundedMoney)! > 0) || refunds.length > 0;
  return {
    id: String(p.id ?? ""),
    status: typeof p.status === "string" && p.status !== "" ? p.status : "UNKNOWN",
    totalAmountCents: moneyAmount(p.total_money),
    tipAmountCents: moneyAmount(p.tip_money),
    refunded,
    refundedAmountCents: refundedAmount,
  };
}

/* ------------------------------ read endpoints ------------------------------ */
/** ListPayments — paginated. locationId defaults to the configured location. */
export async function listSquarePaymentsCore(
  config: SquareConfig,
  opts: { locationId?: string; limit?: number; cursor?: string; fetchImpl?: typeof fetch } = {},
): Promise<SquareListPaymentsResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const params = new URLSearchParams();
  if (opts.limit != null) params.set("limit", String(opts.limit));
  if (opts.cursor) params.set("cursor", opts.cursor);
  params.set("location_id", opts.locationId ?? config.locationId);
  const r = await readJson<{ payments?: unknown[]; cursor?: string }>(
    fetchImpl,
    `${SQ_BASE}/payments?${params.toString()}`,
    { method: "GET", headers: authHeaders(config), signal: AbortSignal.timeout(20000) },
  );
  if (!r.ok) {
    return { ok: false, code: "square_read_error", status: r.status, message: r.error ?? `Square ListPayments failed (HTTP ${r.status ?? "error"}).` };
  }
  const payments = (Array.isArray(r.body?.payments) ? r.body!.payments : [])
    .map(normalizePayment)
    .filter((p): p is SquarePaymentSummary => p !== null);
  return { ok: true, payments, cursor: typeof r.body?.cursor === "string" ? r.body.cursor : null };
}

/** GetPayment — a single payment (status, total_money, tip_money, refunds). */
export async function getSquarePaymentCore(
  config: SquareConfig,
  paymentId: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<SquareGetPaymentResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const r = await readJson<{ payment?: unknown }>(
    fetchImpl,
    `${SQ_BASE}/payments/${encodeURIComponent(paymentId)}`,
    { method: "GET", headers: authHeaders(config), signal: AbortSignal.timeout(20000) },
  );
  if (r.status === 404) {
    return { ok: false, code: "square_missing", status: 404, message: "Square payment not found." };
  }
  if (!r.ok) {
    return { ok: false, code: "square_read_error", status: r.status, message: r.error ?? `Square GetPayment failed (HTTP ${r.status ?? "error"}).` };
  }
  const payment = normalizePayment(r.body?.payment);
  if (!payment) {
    return { ok: false, code: "square_read_error", status: r.status, message: "Square GetPayment returned no payment." };
  }
  return { ok: true, payment };
}

/** SearchOrders — paginated. Needed later for tire-plug / battery (charge via
 *  Orders + payment link). Implemented + hermetic-tested here; NOT wired into
 *  reconcile yet. */
export async function searchSquareOrdersCore(
  config: SquareConfig,
  opts: { locationId?: string; limit?: number; cursor?: string; fetchImpl?: typeof fetch } = {},
): Promise<SquareSearchOrdersResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const body: Record<string, unknown> = { location_ids: [opts.locationId ?? config.locationId] };
  if (opts.limit != null) body.limit = opts.limit;
  if (opts.cursor) body.cursor = opts.cursor;
  const r = await readJson<{ orders?: unknown[]; cursor?: string }>(
    fetchImpl,
    `${SQ_BASE}/orders/search`,
    {
      method: "POST",
      headers: { ...authHeaders(config), "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!r.ok) {
    return { ok: false, code: "square_read_error", status: r.status, message: r.error ?? `Square SearchOrders failed (HTTP ${r.status ?? "error"}).` };
  }
  const orders = (Array.isArray(r.body?.orders) ? r.body!.orders : []).map((o) => {
    const rec = (o ?? {}) as Record<string, unknown>;
    return {
      id: String(rec.id ?? ""),
      state: typeof rec.state === "string" ? rec.state : "UNKNOWN",
      totalMoneyCents: centsOf((rec.total_money as Record<string, unknown> | null)?.amount),
    } as SquareOrderSummary;
  });
  return { ok: true, orders, cursor: typeof r.body?.cursor === "string" ? r.body.cursor : null };
}

/* ------------------------------ reconciliation ------------------------------ */
type LocalSettledRow = {
  kind: ReconcileKind;
  localRowId: string;
  jobId: string;
  driverId: string;
  localStatus: string;
  localAmountCents: number;
  squarePaymentId: string;
};

function verdictFor(localAmountCents: number, p: SquarePaymentSummary): ReconcileVerdict {
  if (p.status === "FAILED" || p.status === "CANCELED") return "square_failed";
  if (p.refunded) return "square_refunded";
  if (p.totalAmountCents != null && p.totalAmountCents !== localAmountCents) return "square_amount_mismatch";
  return "ok";
}

/** Owner/admin-only reconcile: read every locally-settled tip / tire-plug /
 *  battery row for the org, pull each Square payment via GetPayment (deduped),
 *  and emit a per-driver + per-kind report. Fail-closed on not-configured /
 *  no-DB / non-owner; GetPayment errors are recorded per-row and the sweep
 *  continues. */
export async function reconcileSquarePaymentsCore(
  actor: SquareReadbackActor,
  opts: { fetchImpl?: typeof fetch; stableDir?: string } = {},
): Promise<ReconcileResult> {
  if (!OWNER_ROLES.includes(actor.role as (typeof OWNER_ROLES)[number])) {
    return { ok: false, code: "unauthorized", message: "Owner access required." };
  }
  if (!configured()) return { ok: false, code: "database_error", message: "Reconciliation requires database mode." };
  let config: SquareConfig;
  try {
    config = await loadSquareConfig(process.env, { stableDir: opts.stableDir });
  } catch (err) {
    return { ok: false, code: "square_not_configured", message: err instanceof Error ? err.message : "Square is not configured." };
  }
  await ensure();
  const q = sql();

  const localRows: LocalSettledRow[] = [];
  const tips = await q`SELECT id, job_id, driver_id, amount_cents, status, square_payment_id
    FROM completion_tips WHERE org_id = ${actor.orgId} AND status = 'paid' AND square_payment_id IS NOT NULL`;
  for (const r of tips as Record<string, unknown>[]) {
    localRows.push({
      kind: "tip",
      localRowId: String(r.id),
      jobId: String(r.job_id ?? ""),
      driverId: String(r.driver_id ?? ""),
      localStatus: String(r.status ?? "paid"),
      localAmountCents: Math.round(Number(r.amount_cents ?? 0)),
      squarePaymentId: String(r.square_payment_id),
    });
  }
  const plugs = await q`SELECT id, job_id, contractor_user_id, amount_cents, status, square_charge_id
    FROM tire_plug_transactions WHERE org_id = ${actor.orgId} AND status IN ('charged','paid') AND square_charge_id IS NOT NULL`;
  for (const r of plugs as Record<string, unknown>[]) {
    localRows.push({
      kind: "tire_plug",
      localRowId: String(r.id),
      jobId: String(r.job_id ?? ""),
      driverId: String(r.contractor_user_id ?? ""),
      localStatus: String(r.status ?? "paid"),
      localAmountCents: Math.round(Number(r.amount_cents ?? 0)),
      squarePaymentId: String(r.square_charge_id),
    });
  }
  const sales = await q`SELECT id, job_id, contractor_user_id, total_cents, status, square_charge_id
    FROM battery_sales WHERE org_id = ${actor.orgId} AND status = 'paid' AND square_charge_id IS NOT NULL`;
  for (const r of sales as Record<string, unknown>[]) {
    localRows.push({
      kind: "battery",
      localRowId: String(r.id),
      jobId: String(r.job_id ?? ""),
      driverId: String(r.contractor_user_id ?? ""),
      localStatus: String(r.status ?? "paid"),
      localAmountCents: Math.round(Number(r.total_cents ?? 0)),
      squarePaymentId: String(r.square_charge_id),
    });
  }

  // Dedupe payment ids (the same Square payment can appear on multiple local rows).
  const uniqueIds = [...new Set(localRows.map((r) => r.squarePaymentId).filter((x) => x))];
  const paymentsById = new Map<string, SquareGetPaymentResult>();
  for (const pid of uniqueIds) {
    let result: SquareGetPaymentResult;
    try {
      result = await getSquarePaymentCore(config, pid, { fetchImpl: opts.fetchImpl });
    } catch (e) {
      result = { ok: false, code: "square_read_error", status: null, message: e instanceof Error ? e.message : "Square read failed." };
    }
    paymentsById.set(pid, result);
  }

  const rows: ReconcileRow[] = localRows.map((lr) => {
    const pr = paymentsById.get(lr.squarePaymentId);
    let match: ReconcileVerdict = "square_read_error";
    let squareStatus: string | null = null;
    let squareTotal: number | null = null;
    let squareTip: number | null = null;
    let squareRefunded = false;
    let squareRefundedAmt: number | null = null;
    let message: string | null = null;
    if (!pr) {
      message = "No Square lookup result.";
    } else if (pr.ok) {
      const p = pr.payment;
      squareStatus = p.status;
      squareTotal = p.totalAmountCents;
      squareTip = p.tipAmountCents;
      squareRefunded = p.refunded;
      squareRefundedAmt = p.refundedAmountCents;
      match = verdictFor(lr.localAmountCents, p);
    } else if (pr.code === "square_missing") {
      match = "square_missing";
      message = pr.message;
    } else {
      match = "square_read_error";
      message = pr.message;
    }
    return {
      kind: lr.kind,
      localRowId: lr.localRowId,
      jobId: lr.jobId,
      driverId: lr.driverId,
      localStatus: lr.localStatus,
      localAmountCents: lr.localAmountCents,
      squarePaymentId: lr.squarePaymentId,
      squareStatus,
      squareTotalAmountCents: squareTotal,
      squareTipAmountCents: squareTip,
      squareRefunded,
      squareRefundedAmountCents: squareRefundedAmt,
      match,
      message,
    };
  });

  // Aggregate summary + per-driver.
  const driverMap = new Map<string, ReconcileDriverSummary>();
  const bump = (driverId: string, field: keyof ReconcileDriverSummary, by: number) => {
    const d = driverMap.get(driverId) ?? {
      driverId, localCount: 0, squareConfirmedCount: 0, localAmountCents: 0, squareConfirmedAmountCents: 0,
      refundedCount: 0, failedCount: 0, missingCount: 0, readErrorCount: 0, mismatchCount: 0,
    };
    (d as unknown as Record<string, unknown>)[field] = (Number((d as unknown as Record<string, unknown>)[field]) + by);
    driverMap.set(driverId, d);
  };
  const summary: ReconcileSummary = {
    totalLocalSettledCount: rows.length,
    totalSquareConfirmed: 0,
    totalRefunded: 0,
    totalFailed: 0,
    totalMissing: 0,
    totalReadError: 0,
    totalMismatch: 0,
    totalLocalAmountCents: 0,
    totalSquareConfirmedAmountCents: 0,
    byDriver: [],
  };
  for (const row of rows) {
    summary.totalLocalAmountCents += row.localAmountCents;
    bump(row.driverId, "localCount", 1);
    bump(row.driverId, "localAmountCents", row.localAmountCents);
    if (row.match === "ok") {
      summary.totalSquareConfirmed += 1;
      summary.totalSquareConfirmedAmountCents += row.squareTotalAmountCents ?? 0;
      bump(row.driverId, "squareConfirmedCount", 1);
      bump(row.driverId, "squareConfirmedAmountCents", row.squareTotalAmountCents ?? 0);
    } else if (row.match === "square_refunded") { summary.totalRefunded += 1; bump(row.driverId, "refundedCount", 1); }
    else if (row.match === "square_failed") { summary.totalFailed += 1; bump(row.driverId, "failedCount", 1); }
    else if (row.match === "square_missing") { summary.totalMissing += 1; bump(row.driverId, "missingCount", 1); }
    else if (row.match === "square_amount_mismatch") { summary.totalMismatch += 1; bump(row.driverId, "mismatchCount", 1); }
    else { summary.totalReadError += 1; bump(row.driverId, "readErrorCount", 1); }
  }
  summary.byDriver = [...driverMap.values()].sort((a, b) => a.driverId.localeCompare(b.driverId));

  return { ok: true, rows, summary };
}

/* ------------------------- session-resolving handlers ------------------------- */
/** Gated list wrapper for the facade: owner/admin only. */
export async function listSquarePaymentsGatedCore(
  actor: SquareReadbackActor,
  opts: { locationId?: string; limit?: number; cursor?: string; fetchImpl?: typeof fetch; stableDir?: string } = {},
): Promise<SquareListPaymentsResult> {
  if (!OWNER_ROLES.includes(actor.role as (typeof OWNER_ROLES)[number])) {
    return { ok: false, code: "unauthorized", status: null, message: "Owner access required." };
  }
  let config: SquareConfig;
  try {
    config = await loadSquareConfig(process.env, { stableDir: opts.stableDir });
  } catch (err) {
    return { ok: false, code: "square_not_configured", status: null, message: err instanceof Error ? err.message : "Square is not configured." };
  }
  return listSquarePaymentsCore(config, {
    locationId: opts.locationId,
    limit: opts.limit,
    cursor: opts.cursor,
    fetchImpl: opts.fetchImpl,
  });
}

async function resolveActor(): Promise<SquareReadbackActor | null> {
  if (!configured()) return null;
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return null;
  return { orgId: u.orgId, id: u.id, role: u.role };
}

export async function listSquarePaymentsHandler(): Promise<SquareListPaymentsResult> {
  const actor = await resolveActor();
  if (!actor) return { ok: false, code: "unauthorized", status: null, message: "Sign in first." };
  return listSquarePaymentsGatedCore(actor);
}

export async function reconcileSquarePaymentsHandler(): Promise<ReconcileResult> {
  const actor = await resolveActor();
  if (!actor) return { ok: false, code: "unauthorized", message: "Sign in first." };
  return reconcileSquarePaymentsCore(actor);
}
