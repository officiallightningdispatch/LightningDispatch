/**
 * Payout methods — SERVER-ONLY CORE (driver-portal feature batch 8,
 * owner-directed 2026-08-12). The driver selects a payout rail (Cash App /
 * Venmo / Zelle / bank) and enters their handle; verification is
 * OWNER-CONFIRMED OUTSIDE THE APP (the owner sends from their own app and
 * marks verified — no provider API can prove a cashtag; Plaid cannot verify
 * handles), so the driver UI only captures and stores the choice with a
 * "pending owner verification" state. "No method" = no row (derived at read).
 *
 * PII rule: handles are PII. Drivers ALWAYS see masked forms (maskHandle);
 * the FULL handle is owner-only (listPayoutMethodsCore /
 * getContractorPayoutMethodCore are owner/admin-gated). Audit rows store the
 * masked form only.
 *
 * Data model (migration 28): payout_methods — ONE row per (org, contractor),
 * unique index payout_methods_org_contractor_uidx. Changing rail/handle
 * re-triggers verification (status → connected_unverified). Removing the row
 * = NOT_SET.
 *
 * Testability (same split as contractor-admin-core): every handler is a thin
 * auth wrapper over a `*Core` function that takes an explicit user context —
 * hermetic tests call the cores directly with real Neon QA orgs.
 *
 * Imported ONLY by the client-safe facade (src/data/payouts.ts, whose
 * createServerFn handlers dynamic-import this module) and by hermetic tests.
 * Static server imports are fine here — this module never enters the client
 * bundle graph.
 */
import { z } from "zod";
import {
  callWorkflowWindowForPeriod,
  fetchCallWorkflow,
  loadTowbookSnapshot,
  reconcileCallWorkflow,
  saveTowbookSnapshot,
  type ReconciliationResult,
  type CallWorkflowRow,
} from "./towbook-reports-core";

/* --------------------------------- helpers --------------------------------- */
const configured = () => Boolean(process.env.DATABASE_URL);
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

/** The actor context every core takes (mirrors the AuthUser subset we need). */
export type PayoutActor = { orgId: string; id: string; role: string };
const OWNER_ROLES = ["owner", "admin"];
const canManage = (a: PayoutActor) => OWNER_ROLES.includes(a.role);

export type PayoutErrorCode = "unauthorized" | "invalid_input" | "not_found" | "database_error";
export type PayoutResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: PayoutErrorCode; message: string };
const err = (code: PayoutErrorCode, message: string) => ({ ok: false as const, code, message });
const ok = <T>(data: T): PayoutResult<T> => ({ ok: true, data });

/* ----------------------------------- domain ----------------------------------- */
export const PAYOUT_RAILS = ["cash_app", "venmo", "zelle", "bank"] as const;
export type PayoutRail = (typeof PAYOUT_RAILS)[number];
export const PAYOUT_STATUSES = ["connected_unverified", "verified", "rejected"] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];
const isRail = (s: string): s is PayoutRail => (PAYOUT_RAILS as readonly string[]).includes(s);

/** The row as a contractor sees it — masked handle, never the full one.
 *  Seroval-safe: every field null-or-value, never undefined. */
export type MyPayoutMethod = {
  id: string;
  rail: PayoutRail;
  /** Masked handle for display ("$jo••••", "@ja••••", "jo••••@ex.com",
   *  "Chase ••4321"). Full handle NEVER crosses to the contractor client. */
  handleMasked: string;
  bankInstitutionName: string | null;
  bankLast4: string | null;
  /** TRUE when the owner has recorded a test deposit for the bank rail and
   *  the driver should confirm it. The deposit AMOUNT never crosses to the
   *  contractor client. */
  bankDepositSent: boolean;
  status: PayoutStatus;
  rejectNote: string | null;
  isDefault: boolean;
  updatedAt: string;
};

/** Owner-side row — FULL handle (owner-only surface). Seroval-safe. */
export type OwnerPayoutMethod = {
  id: string;
  orgId: string;
  contractorId: string;
  contractorName: string;
  rail: PayoutRail;
  handleFull: string | null;
  handleMasked: string;
  bankInstitutionName: string | null;
  bankLast4: string | null;
  bankRoutingNumberFull: string | null;
  bankAccountNumberFull: string | null;
  bankDepositCents: number | null;
  bankDepositSentAt: string | null;
  status: PayoutStatus;
  rejectNote: string | null;
  isDefault: boolean;
  updatedAt: string;
};

/* --------------------------------- masking --------------------------------- */
const maskPhone = (raw: string): string => {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 4) return `${raw.slice(0, 2)}••••`;
  return `(•••) •••-${digits.slice(-4)}`;
};
/** Mask a handle for contractor-facing display. Server-side only — the full
 *  handle never reaches the contractor client bundle. */
export function maskHandle(rail: PayoutRail, handle: string | null, bankInstitutionName: string | null, bankLast4: string | null): string {
  if (rail === "bank") {
    const inst = (bankInstitutionName ?? "").trim();
    const last4 = (bankLast4 ?? "").trim();
    return inst ? `${inst} ••${last4}` : last4 ? `Bank ••${last4}` : "Bank account";
  }
  const h = (handle ?? "").trim();
  if (!h) return "Not set";
  const local = h.startsWith("$") || h.startsWith("@") ? h.slice(1) : h;
  const prefix = h.startsWith("$") ? "$" : h.startsWith("@") ? "@" : "";
  if (/^\+?[\d\s().-]+$/.test(local) && local.replace(/\D/g, "").length >= 7) return maskPhone(local);
  const head = local.slice(0, 2);
  return `${prefix}${head}••••`;
}

/* --------------------------------- validation --------------------------------- */
const US_PHONE = /^\+?1?[\s().-]*\d{3}[\s().-]*\d{3}[\s().-]*\d{4}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CASHTAG = /^\$[a-zA-Z0-9]{2,20}$/;
const VENMO_HANDLE = /^@[a-zA-Z0-9._-]{2,30}$/;

const SET_SCHEMA = z.object({
  rail: z.string().min(1).max(20),
  handle: z.string().max(120).nullable().optional(),
  bankInstitutionName: z.string().max(40).nullable().optional(),
  bankLast4: z.string().max(4).nullable().optional(),
  bankRoutingNumber: z.string().max(10).nullable().optional(),
  bankAccountNumber: z.string().max(20).nullable().optional(),
});

/** Rail-specific handle validation. Returns a {ok:true} result or a
 *  {ok:false} result carrying the driver-facing validation message. */
export function validatePayoutInput(d: {
  rail: string;
  handle: string | null;
  bankInstitutionName: string | null;
  bankLast4: string | null;
  bankRoutingNumber?: string | null;
  bankAccountNumber?: string | null;
}): PayoutResult<{ rail: PayoutRail; handle: string | null; bankInstitutionName: string | null; bankLast4: string | null; bankRoutingNumber: string | null; bankAccountNumber: string | null }> {
  if (!isRail(d.rail)) return err("invalid_input", "Choose a payout method.");
  if (d.rail === "bank") {
    const inst = (d.bankInstitutionName ?? "").trim();
    const last4 = (d.bankLast4 ?? "").trim();
    const routing = (d.bankRoutingNumber ?? "").trim();
    const account = (d.bankAccountNumber ?? "").trim();
    if (!inst || inst.length > 40) return err("invalid_input", "Enter the bank name (up to 40 characters).");
    if (!/^\d{4}$/.test(last4)) return err("invalid_input", "Enter the last 4 digits of the account number.");
    if (!/^\d{9}$/.test(routing)) return err("invalid_input", "Routing numbers are 9 digits — check the number on your checks or bank statement.");
    if (!/^\d{4,17}$/.test(account)) return err("invalid_input", "Enter the full account number (4–17 digits). It's stored encrypted — only the owner can see it.");
    return ok({ rail: d.rail, handle: null, bankInstitutionName: inst, bankLast4: last4, bankRoutingNumber: routing, bankAccountNumber: account });
  }
  const handle = (d.handle ?? "").trim();
  if (!handle) return err("invalid_input", "Enter your handle.");
  if (d.rail === "cash_app") {
    if (!CASHTAG.test(handle)) return err("invalid_input", "Cashtags start with $ and use letters/numbers — e.g. $joe.");
    return ok({ rail: d.rail, handle, bankInstitutionName: null, bankLast4: null, bankRoutingNumber: null, bankAccountNumber: null });
  }
  if (d.rail === "venmo") {
    if (VENMO_HANDLE.test(handle) || US_PHONE.test(handle)) return ok({ rail: d.rail, handle, bankInstitutionName: null, bankLast4: null, bankRoutingNumber: null, bankAccountNumber: null });
    return err("invalid_input", "Enter a Venmo handle (@name) or a US phone number.");
  }
  // zelle
  const lower = handle.toLowerCase();
  if (EMAIL.test(lower) || US_PHONE.test(handle)) return ok({ rail: d.rail, handle: EMAIL.test(lower) ? lower : handle, bankInstitutionName: null, bankLast4: null, bankRoutingNumber: null, bankAccountNumber: null });
  return err("invalid_input", "Enter an email address or a US phone number.");
}

/* ---------------------------------- cores ---------------------------------- */

/** The acting contractor's payout method (masked). null = no method on file. */
export async function getMyPayoutMethodCore(user: { orgId: string; id: string }): Promise<PayoutResult<MyPayoutMethod | null>> {
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT id, rail, handle, bank_institution_name, bank_last4, status, reject_note, is_default, updated_at, bank_deposit_sent_at
      FROM payout_methods WHERE org_id=${user.orgId} AND contractor_id=${user.id} LIMIT 1`;
    if (!rows.length) return ok(null);
    const r = rows[0] as Record<string, unknown>;
    const rail = String(r.rail ?? "cash_app") as PayoutRail;
    return ok({
      id: String(r.id),
      rail,
      handleMasked: maskHandle(rail, r.handle != null ? String(r.handle) : null, r.bank_institution_name != null ? String(r.bank_institution_name) : null, r.bank_last4 != null ? String(r.bank_last4) : null),
      bankInstitutionName: r.bank_institution_name != null ? String(r.bank_institution_name) : null,
      bankLast4: r.bank_last4 != null ? String(r.bank_last4) : null,
      bankDepositSent: r.bank_deposit_sent_at != null,
      status: String(r.status ?? "connected_unverified") as PayoutStatus,
      rejectNote: r.reject_note != null ? String(r.reject_note) : null,
      isDefault: r.is_default != null ? Boolean(r.is_default) : true,
      updatedAt: r.updated_at != null ? new Date(String(r.updated_at)).toISOString() : new Date(0).toISOString(),
    });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to load your payout method.");
  }
}

/** Save (upsert) the contractor's payout method. Changing rail or handle
 *  re-triggers verification (status → connected_unverified); a re-save of the
 *  SAME values keeps the current status (idempotent). Audited with the masked
 *  handle only (PII never lands in audit detail). */
export async function setMyPayoutMethodCore(user: { orgId: string; id: string; actorUserId: string; actorRole: string }, data: unknown): Promise<PayoutResult<MyPayoutMethod>> {
  const v = SET_SCHEMA.safeParse(data);
  if (!v.success) return err("invalid_input", v.error.issues[0]?.message ?? "Invalid payout method.");
  const validated = validatePayoutInput({
    rail: v.data.rail,
    handle: v.data.handle ?? null,
    bankInstitutionName: v.data.bankInstitutionName ?? null,
    bankLast4: v.data.bankLast4 ?? null,
    bankRoutingNumber: v.data.bankRoutingNumber ?? null,
    bankAccountNumber: v.data.bankAccountNumber ?? null,
  });
  if (!validated.ok) return validated;
  const d = validated.data;
  try {
    await ensure();
    const q = await db();
    const before = await q`SELECT id, rail, handle, status, bank_institution_name, bank_last4, bank_routing_encrypted, bank_account_encrypted, bank_deposit_cents FROM payout_methods
      WHERE org_id=${user.orgId} AND contractor_id=${user.id} LIMIT 1`;
    const existing = before.length ? before[0] as Record<string, unknown> : null;
    // Encrypt bank routing/account numbers — full numbers are NEVER stored or
    // logged in plaintext (dedicated bank.key, AES-256-GCM envelope).
    let routingEnc: string | null = null;
    let accountEnc: string | null = null;
    if (d.rail === "bank") {
      const { encryptBankValue } = await import("./bank-key");
      routingEnc = await encryptBankValue(d.bankRoutingNumber!);
      accountEnc = await encryptBankValue(d.bankAccountNumber!);
    }
    let prevRouting = "";
    let prevAccount = "";
    if (existing && d.rail === "bank") {
      try {
        const { decryptBankValue } = await import("./bank-key");
        prevRouting = existing.bank_routing_encrypted != null ? await decryptBankValue(String(existing.bank_routing_encrypted)) : "";
        prevAccount = existing.bank_account_encrypted != null ? await decryptBankValue(String(existing.bank_account_encrypted)) : "";
      } catch { /* decrypt failure → treated as different values */ }
    }
    const sameValues =
      existing &&
      String(existing.rail) === d.rail &&
      (d.rail === "bank"
        ? String(existing.bank_institution_name ?? "") === d.bankInstitutionName && String(existing.bank_last4 ?? "") === d.bankLast4 && prevRouting === d.bankRoutingNumber && prevAccount === d.bankAccountNumber
        : String(existing.handle ?? "") === d.handle);
    const status: PayoutStatus = sameValues ? (String(existing!.status) as PayoutStatus) : "connected_unverified";
    const methodId = existing ? String(existing.id) : `pm-${Math.random().toString(36).slice(2, 12)}`;
    await q`INSERT INTO payout_methods(id, org_id, contractor_id, rail, handle, bank_institution_name, bank_last4, bank_routing_encrypted, bank_account_encrypted, status, reject_note, is_default, updated_at)
      VALUES(${methodId}, ${user.orgId}, ${user.id}, ${d.rail}, ${d.handle}, ${d.bankInstitutionName}, ${d.bankLast4}, ${routingEnc}, ${accountEnc}, ${status}, NULL, TRUE, NOW())
      ON CONFLICT (org_id, contractor_id) DO UPDATE SET
        rail=EXCLUDED.rail, handle=EXCLUDED.handle,
        bank_institution_name=EXCLUDED.bank_institution_name, bank_last4=EXCLUDED.bank_last4,
        bank_routing_encrypted=EXCLUDED.bank_routing_encrypted, bank_account_encrypted=EXCLUDED.bank_account_encrypted,
        status=EXCLUDED.status, reject_note=NULL, is_default=TRUE, updated_at=NOW()`;
    if (!sameValues) {
      try {
        const masked = maskHandle(d.rail, d.handle, d.bankInstitutionName, d.bankLast4);
        await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
          SELECT gen_random_uuid()::text, ${user.orgId}, ${user.actorUserId}, ${user.actorRole}, 'payout_method_connected', 'contractor', ${user.id},
            jsonb_build_object('rail', ${d.rail}::text, 'handleMasked', ${masked}::text, 'status', ${status}::text), 'driver-portal'`;
      } catch { /* best-effort audit */ }
    }
    return ok({
      id: methodId,
      rail: d.rail,
      handleMasked: maskHandle(d.rail, d.handle, d.bankInstitutionName, d.bankLast4),
      bankInstitutionName: d.bankInstitutionName,
      bankLast4: d.bankLast4,
      bankDepositSent: false,
      status,
      rejectNote: null,
      isDefault: true,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to save your payout method.");
  }
}

/** Remove the contractor's payout method (row deleted = NOT_SET). Audited. */
export async function removeMyPayoutMethodCore(user: { orgId: string; id: string; actorUserId: string; actorRole: string }): Promise<PayoutResult<{ removed: boolean }>> {
  try {
    await ensure();
    const q = await db();
    const before = await q`SELECT rail, handle, status FROM payout_methods
      WHERE org_id=${user.orgId} AND contractor_id=${user.id} LIMIT 1`;
    if (!before.length) return ok({ removed: false });
    const r = before[0] as Record<string, unknown>;
    await q`DELETE FROM payout_methods WHERE org_id=${user.orgId} AND contractor_id=${user.id}`;
    try {
      const rail = String(r.rail ?? "cash_app") as PayoutRail;
      const masked = maskHandle(rail, r.handle != null ? String(r.handle) : null, null, null);
      await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
        SELECT gen_random_uuid()::text, ${user.orgId}, ${user.actorUserId}, ${user.actorRole}, 'payout_method_removed', 'contractor', ${user.id},
          jsonb_build_object('rail', ${rail}::text, 'handleMasked', ${masked}::text), 'driver-portal'`;
    } catch { /* best-effort audit */ }
    return ok({ removed: true });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to remove your payout method.");
  }
}

/** Owner/admin read of every contractor's payout method — FULL handles
 *  (owner-only surface). Sorted by contractor name. */
export async function listPayoutMethodsCore(actor: PayoutActor): Promise<PayoutResult<OwnerPayoutMethod[]>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  try {
    await ensure();
    const q = await db();
    const rows = await q`
      SELECT p.id, p.org_id, p.contractor_id, u.name AS contractor_name, p.rail, p.handle,
             p.bank_institution_name, p.bank_last4, p.bank_routing_encrypted, p.bank_account_encrypted,
             p.bank_deposit_cents, p.bank_deposit_sent_at, p.status, p.reject_note, p.is_default, p.updated_at
      FROM payout_methods p
      JOIN users u ON u.id = p.contractor_id
      WHERE p.org_id=${actor.orgId}
      ORDER BY u.name ASC`;
    const out: OwnerPayoutMethod[] = [];
    for (const r of rows as Record<string, unknown>[]) out.push(await toOwnerPayoutMethod(r));
    return ok(out);
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to load payout methods.");
  }
}

/** Owner-side mapper — decrypts the FULL bank routing/account numbers ONLY
 *  here (owner-only surface). The plaintext never touches audit/log text and
 *  never crosses to any contractor-facing read. */
async function toOwnerPayoutMethod(r: Record<string, unknown>): Promise<OwnerPayoutMethod> {
  const rail = String(r.rail ?? "cash_app") as PayoutRail;
  let routingFull: string | null = null;
  let accountFull: string | null = null;
  if (rail === "bank" && (r.bank_routing_encrypted != null || r.bank_account_encrypted != null)) {
    try {
      const { decryptBankValue } = await import("./bank-key");
      routingFull = r.bank_routing_encrypted != null ? await decryptBankValue(String(r.bank_routing_encrypted)) : null;
      accountFull = r.bank_account_encrypted != null ? await decryptBankValue(String(r.bank_account_encrypted)) : null;
    } catch { /* undecryptable (rotated key) → owner sees nulls, not a crash */ }
  }
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    contractorId: String(r.contractor_id),
    contractorName: String(r.contractor_name ?? ""),
    rail,
    handleFull: r.handle != null ? String(r.handle) : null,
    handleMasked: maskHandle(rail, r.handle != null ? String(r.handle) : null, r.bank_institution_name != null ? String(r.bank_institution_name) : null, r.bank_last4 != null ? String(r.bank_last4) : null),
    bankInstitutionName: r.bank_institution_name != null ? String(r.bank_institution_name) : null,
    bankLast4: r.bank_last4 != null ? String(r.bank_last4) : null,
    bankRoutingNumberFull: routingFull,
    bankAccountNumberFull: accountFull,
    bankDepositCents: r.bank_deposit_cents != null ? Number(r.bank_deposit_cents) : null,
    bankDepositSentAt: r.bank_deposit_sent_at != null ? new Date(String(r.bank_deposit_sent_at)).toISOString() : null,
    status: String(r.status ?? "connected_unverified") as PayoutStatus,
    rejectNote: r.reject_note != null ? String(r.reject_note) : null,
    isDefault: r.is_default != null ? Boolean(r.is_default) : true,
    updatedAt: r.updated_at != null ? new Date(String(r.updated_at)).toISOString() : new Date(0).toISOString(),
  };
}

/* ================================ PAYDAY ================================ */

/** Weekly pay period (owner direction 2026-08-11): Monday 00:00 → Sunday
 *  23:59:59.999 America/New_York, payout due the Wednesday AFTER the close. */
export type PayPeriodStatus = "open" | "computed" | "paid";
export type PayPeriod = {
  id: string;
  orgId: string;
  startsAt: string; // ISO (Monday 00:00 ET)
  endsAt: string; // ISO (Sunday 23:59:59.999 ET)
  payoutDueOn: string; // YYYY-MM-DD (ET calendar date)
  status: PayPeriodStatus;
  computedAt: string | null;
  paidAt: string | null;
  isCurrent: boolean; // contains NOW (the open period)
};
export type PayoutRecordStatus = "computed" | "paid" | "blocked";
export type PayoutMethodStatusOfRecord = "verified" | "connected_unverified" | "rejected" | "none";

/** One manifest row — owner-only view (handle_full is PII; masked form is what
 *  audit/ledger rows carry). Seroval-safe: every field null-or-value. */
export type PayoutRecord = {
  id: string;
  orgId: string;
  periodId: string;
  contractorId: string;
  contractorName: string;
  /** Roster status is display-only; payday records remain earnings-only. */
  contractorActive?: boolean;
  /** Synthetic owner-roster row; never persisted to payout_records. */
  noActivityThisPeriod?: boolean;
  methodId: string | null; // payout_methods row snapshot (owner verify/reject)
  rail: PayoutRail | null; // NULL when no method row at all (blocked)
  handleFull: string | null; // OWNER-ONLY (PII)
  handleMasked: string;
  jobCount: number;
  goaJobCount: number;
  payrateCents: number | null; // snapshot at compute; NULL = rate not set
  grossCents: number;
  tipsCents: number;
  tirePlugCents: number;
  batteryPayoutCents: number;
  /** Busy-time bonus (owner-locked 2026-08-13): +$1 per job completed in a
   *  busy hour (3+ assigned calls in one clock hour) — derived from
   *  dispatch_jobs at compute time, snapshot here (part of the paid amount). */
  busyBonusCents: number;
  busyBonusJobs: number;
  /** Per busy-hour breakdown (ET clock-hour starts) for manifest line items. */
  busyBonusHours: { startsAtIso: string; completedJobs: number }[] | null;
  totalCents: number;
  methodStatus: PayoutMethodStatusOfRecord;
  status: PayoutRecordStatus;
  paidAt: string | null;
  payNote: string | null;
  createdAt: string;
};
export type PayPeriodDetail = {
  period: PayPeriod;
  records: PayoutRecord[];
  totals: {
    grossCents: number;
    tipsCents: number;
    tirePlugCents: number;
    batteryPayoutCents: number;
    busyBonusCents: number;
    totalCents: number;
    contractorCount: number;
    jobCount: number;
    dueCount: number; // status 'computed'
    paidCount: number;
    blockedCount: number;
    rails: { rail: PayoutRail; count: number; totalCents: number }[];
  };
  /** Authoritative CallWorkflow membership and reconciliation diagnostics.
   * `jobCount` remains the itemized payable population; reportCount preserves
   * the complete report headline so an unmatched report row can never vanish. */
  diagnostics?: {
    unknownCompletionTimeRows: number;
    reportCount?: number;
    matchedCount?: number;
    matchedPayableCount?: number;
    reassignedCount?: number;
    unmatchedCount?: number;
    unitemizedCount?: number;
    reconciliationWarning?: string | null;
  };
};
export type PayPeriodList = {
  periods: PayPeriod[]; // newest first
  currentPeriodId: string;
  defaultPeriodId: string; // the just-closed period (manifest default)
};
export type WeeklyTipByDriver = { driverId: string; driverName: string; tipsCents: number; tipCount: number };
export type MoneyOverview = {
  revenueCents: number;
  revenueChargedCount: number;
  revenueStagedCount: number;
  tipsCents: number;
  tipsCount: number;
  weeklyTipsCents: number;
  weeklyTipCount: number;
  weeklyTipsByDriver: WeeklyTipByDriver[];
  payoutsDueCents: number;
  payoutsDueCount: number;
  payoutsDueOn: string | null; // payout_due_on of the default period
  hasRealMoney: boolean; // false → UI keeps the demo chip
};

/* ------------------------- period window math (ET) ------------------------ */
const ET_TZ = "America/New_York";
function etDateParts(d: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: ET_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")) };
}
/** Absolute instant of 00:00:00 America/New_York on the given ET calendar
 *  date. Tries EST then EDT and verifies by round-tripping the ET wall clock
 *  (midnight is unambiguous on both transition days). The DATE check alone is
 *  not enough: on an EDT date the EST guess maps to 01:00 ET on the same
 *  calendar day, which would stretch a spring-forward week one hour into
 *  Monday — so the ET hour must also read 00:00. */
function etMidnight(year: number, month: number, day: number): Date {
  const hourInET = (d: Date): number => {
    const h = new Intl.DateTimeFormat("en-US", { timeZone: ET_TZ, hour: "2-digit", hour12: false }).format(d);
    return Number(h === "24" ? "0" : h);
  };
  for (const offsetHours of [-5, -4]) {
    const candidate = new Date(Date.UTC(year, month - 1, day, -offsetHours));
    const p = etDateParts(candidate);
    if (p.year === year && p.month === month && p.day === day && hourInET(candidate) === 0) return candidate;
  }
  return new Date(Date.UTC(year, month - 1, day, 4)); // fallback: EDT
}
export type PeriodBoundaries = { startsAt: Date; endsAt: Date; payoutDueOn: string };
/** One server-authoritative driver payday card. `endsAt` is exclusive. */
export type DriverPayPeriodCard = {
  startsAt: string;
  endsAt: string;
  jobCount: number;
  goaJobCount: number;
  payrateCents: number;
  grossCents: number;
  tipsCents: number;
  tirePlugCents: number;
  batteryPayoutCents: number;
  busyBonusCents: number;
  totalCents: number;
};
export type DriverPayPeriodSummary = {
  current: DriverPayPeriodCard;
  previous: DriverPayPeriodCard;
  diagnostics: { unknownCompletionTimeRows: number };
};
/** Monday 00:00 ET → next Monday 00:00 ET (exclusive), containing `now`,
 *  plus the Wednesday-after payout date (ET calendar). Pure — hermetic-test friendly. */
export function periodBoundariesFor(now: Date): PeriodBoundaries {
  const p = etDateParts(now);
  const dowUtc = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  const weekDay = (dowUtc + 6) % 7; // Monday = 0
  const monday = etMidnight(p.year, p.month, p.day - weekDay);
  const nextMonday = etMidnight(p.year, p.month, p.day - weekDay + 7);
  const endsAt = nextMonday;
  const due = etDateParts(new Date(monday.getTime() + 9 * 86_400_000)); // Mon + 9 = next Wed
  const payoutDueOn = `${due.year}-${String(due.month).padStart(2, "0")}-${String(due.day).padStart(2, "0")}`;
  return { startsAt: monday, endsAt, payoutDueOn };
}
const iso = (d: Date) => d.toISOString();
/** DB timestamptz → ISO string (neon returns Date OBJECTS — String() on a
 *  Date drops milliseconds and mangles formatting; handle both shapes). */
const toIso = (v: unknown): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
/** DB date → "YYYY-MM-DD" (neon returns Date objects at UTC midnight). */
const toYmd = (v: unknown): string => {
  if (v == null) return "";
  let d: Date;
  if (v instanceof Date) d = v;
  else {
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    d = new Date(s);
  }
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};
const toPeriod = (r: Record<string, unknown>, currentPeriodId: string): PayPeriod => ({
  id: String(r.id),
  orgId: String(r.org_id),
  startsAt: toIso(r.starts_at) ?? iso(new Date(0)),
  endsAt: toIso(r.ends_at) ?? iso(new Date(0)),
  payoutDueOn: toYmd(r.payout_due_on),
  status: String(r.status ?? "open") as PayPeriodStatus,
  computedAt: toIso(r.computed_at),
  paidAt: toIso(r.paid_at),
  isCurrent: String(r.id) === currentPeriodId,
});

/** Ensure the pay_period row for the given boundaries exists (lazy create).
 *  ON CONFLICT (org_id, starts_at, ends_at) DO NOTHING → idempotent; the
 *  follow-up read is BY BOUNDARIES, never by our generated id, so a row that
 *  already exists under any id is found. */
async function ensurePeriodCore(orgId: string, b: PeriodBoundaries, q: Awaited<ReturnType<typeof db>>): Promise<Record<string, unknown>> {
  const startIso = iso(b.startsAt);
  const endIso = iso(b.endsAt);
  const existing = await q`SELECT id FROM pay_periods WHERE org_id=${orgId} AND starts_at=${startIso} ORDER BY ends_at DESC LIMIT 1`;
  if (existing.length) {
    await q`UPDATE pay_periods SET ends_at=${endIso}, payout_due_on=${b.payoutDueOn}, updated_at=NOW()
      WHERE org_id=${orgId} AND id=${String((existing[0] as Record<string, unknown>).id)}`;
  } else {
    const id = `pay-${orgId}-${startIso.slice(0, 10)}`;
    await q`INSERT INTO pay_periods(id, org_id, starts_at, ends_at, payout_due_on)
      VALUES(${id}, ${orgId}, ${startIso}, ${endIso}, ${b.payoutDueOn})
      ON CONFLICT DO NOTHING`;
  }
  const rows = await q`SELECT * FROM pay_periods WHERE org_id=${orgId} AND starts_at=${startIso} ORDER BY ends_at DESC LIMIT 1`;
  return (rows[0] ?? {}) as Record<string, unknown>;
}

function rawObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") { try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch { return null; } }
  return null;
}
function authoritativeCompletionMs(value: unknown): number | null {
  const raw = rawObject(value);
  const text = raw?.completionTime;
  if (typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}(T| )\d{2}:\d{2}:\d{2}/.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}
function hasPaydayReassignmentEvidence(value: unknown): boolean {
  const raw = rawObject(value);
  if (!raw) return false;
  return Object.entries(raw).some(([key, child]) => (/reassign/i.test(key) && child != null && child !== false && child !== "" && child !== 0) || hasPaydayReassignmentEvidence(child));
}
function isGoaInvoice(value: unknown): boolean {
  const raw = rawObject(value);
  const items = raw?.invoiceItems;
  return Array.isArray(items) && items.some((item) => /\bGOA\b/i.test(typeof item === "string" ? item : JSON.stringify(item ?? "")));
}

/** Driver-facing payday cards use the exact same Towbook completionTime,
 * final-status, reassignment, GOA, and ET-window rules as owner computation.
 * This is intentionally server-only: the client never derives payday totals. */
export async function getDriverPayPeriodSummaryCore(actor: PayoutActor, towbookDriverId: string): Promise<PayoutResult<DriverPayPeriodSummary>> {
  try {
    await ensure();
    const q = await db();
    const profileRows = await q`SELECT cp.payrate_cents FROM users u LEFT JOIN contractor_profiles cp ON cp.org_id=${actor.orgId} AND cp.user_id=u.id WHERE u.id=${actor.id} LIMIT 1`;
    const payrateCents = profileRows.length && profileRows[0].payrate_cents != null ? Number(profileRows[0].payrate_cents) : 0;
    const currentB = periodBoundariesFor(new Date());
    const previousB = periodBoundariesFor(new Date(currentB.startsAt.getTime() - 86_400_000));
    const allRows = await q`SELECT id, status, assigned_at, completed_at, created_at, raw_json, manually_reassigned_at
      FROM dispatch_jobs WHERE org_id=${actor.orgId} AND assigned_driver_towbook_id=${towbookDriverId}`;
    const tipRows = await q`SELECT created_at, amount_cents FROM completion_tips WHERE org_id=${actor.orgId} AND driver_id=${actor.id} AND driver_towbook_id=${towbookDriverId} AND status='paid'`;
    const tireRows = await q`SELECT amount_cents, paid_at FROM tire_plug_transactions WHERE org_id=${actor.orgId} AND contractor_user_id=${actor.id} AND status='paid'`;
    const batteryRows = await q`SELECT amount_cents, earned_at FROM battery_payouts WHERE org_id=${actor.orgId} AND contractor_user_id=${actor.id} AND earned_at IS NOT NULL`;
    const { computeBusyBonus, jobAssignmentMs, jobCompletedMs, BUSY_BONUS_PER_JOB_CENTS } = await import("./busy-bonus-core");
    const makeCard = (b: PeriodBoundaries): DriverPayPeriodCard => {
      const start = b.startsAt.getTime(), end = b.endsAt.getTime();
      let jobCount = 0, goaCount = 0, unknown = 0;
      const assignments: Array<number | null> = [], completions: Array<number | null> = [];
      for (const row of allRows as Record<string, unknown>[]) {
        if (String(row.status) !== "completed") continue;
        const raw = rawObject(row.raw_json);
        const completionMs = authoritativeCompletionMs(row.raw_json);
        if (completionMs == null) { unknown++; continue; }
        if (row.manually_reassigned_at != null || hasPaydayReassignmentEvidence(row.raw_json)) continue;
        if (String(raw?.statusId ?? raw?.status ?? "") === "255" || /cancel+ed/i.test(String(raw?.status ?? ""))) continue;
        if (completionMs >= start && completionMs < end) { jobCount++; if (isGoaInvoice(row.raw_json)) goaCount++; }
        const a = jobAssignmentMs(row); if (a != null && a >= start && a < end) assignments.push(a);
        const c = jobCompletedMs(row); if (c != null && c >= start && c < end) completions.push(c);
      }
      const busy = computeBusyBonus(assignments, completions);
      const tipsCents = (tipRows as Record<string, unknown>[]).reduce((sum, row) => { const t = new Date(String(row.created_at)).getTime(); return t >= start && t < end ? sum + Number(row.amount_cents ?? 0) : sum; }, 0);
      const tirePlugCents = (tireRows as Record<string, unknown>[]).reduce((sum, row) => { const t = new Date(String(row.paid_at)).getTime(); return t >= start && t < end ? sum + Number(row.amount_cents ?? 0) : sum; }, 0);
      const batteryPayoutCents = (batteryRows as Record<string, unknown>[]).reduce((sum, row) => { const t = new Date(String(row.earned_at)).getTime(); return t >= start && t < end ? sum + Number(row.amount_cents ?? 0) : sum; }, 0);
      const grossCents = goaCount * 1000 + Math.max(0, jobCount - goaCount) * payrateCents;
      const busyBonusCents = busy.bonusJobs * BUSY_BONUS_PER_JOB_CENTS;
      return { startsAt: iso(b.startsAt), endsAt: iso(b.endsAt), jobCount, goaJobCount: goaCount, payrateCents, grossCents, tipsCents, tirePlugCents, batteryPayoutCents, busyBonusCents, totalCents: grossCents + tipsCents + tirePlugCents + batteryPayoutCents + busyBonusCents };
    };
    const current = makeCard(currentB), previous = makeCard(previousB);
    // Closed/computed manifests are the owner's authoritative snapshots. Use
    // them for the contractor view too; open periods fall back to the same
    // server-side formula above until a manifest is computed.
    const manifestRows = await q`SELECT pp.starts_at, pr.job_count, pr.goa_job_count, pr.payrate_cents, pr.gross_cents, pr.tips_cents, pr.tire_plug_cents, pr.battery_payout_cents, pr.busy_bonus_cents, pr.total_cents
      FROM payout_records pr JOIN pay_periods pp ON pp.org_id=pr.org_id AND pp.id=pr.period_id
      WHERE pr.org_id=${actor.orgId} AND pr.contractor_id=${actor.id}
        AND pp.starts_at IN (${iso(currentB.startsAt)}, ${iso(previousB.startsAt)})`;
    for (const r of manifestRows as Record<string, unknown>[]) {
      const target = new Date(String(r.starts_at)).getTime() === currentB.startsAt.getTime() ? current : previous;
      target.jobCount = Number(r.job_count ?? target.jobCount);
      target.goaJobCount = Number(r.goa_job_count ?? target.goaJobCount);
      target.payrateCents = r.payrate_cents != null ? Number(r.payrate_cents) : 0;
      target.grossCents = Number(r.gross_cents ?? target.grossCents);
      target.tipsCents = Number(r.tips_cents ?? target.tipsCents);
      target.tirePlugCents = Number(r.tire_plug_cents ?? target.tirePlugCents);
      target.batteryPayoutCents = Number(r.battery_payout_cents ?? target.batteryPayoutCents);
      target.busyBonusCents = Number(r.busy_bonus_cents ?? target.busyBonusCents);
      target.totalCents = Number(r.total_cents ?? target.totalCents);
    }
    const diagnostics = { unknownCompletionTimeRows: Number((allRows as Record<string, unknown>[]).filter((r) => String(r.status) === "completed" && authoritativeCompletionMs(r.raw_json) == null).length) };
    return ok({ current, previous, diagnostics });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to load authoritative payday totals.");
  }
}

/** Owner/admin: list pay periods (ensures the current open + just-closed
 *  periods exist), newest first. defaultPeriodId = just-closed (the manifest
 *  default); falls back to the current period when nothing has closed yet. */
export async function listPayPeriodsCore(actor: PayoutActor): Promise<PayoutResult<PayPeriodList>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  try {
    await ensure();
    const q = await db();
    const now = new Date();
    const currentB = periodBoundariesFor(now);
    const prevB = periodBoundariesFor(new Date(currentB.startsAt.getTime() - 86_400_000)); // any time last week
    const cur = await ensurePeriodCore(actor.orgId, currentB, q);
    const prev = await ensurePeriodCore(actor.orgId, prevB, q);
    const curId = String(cur.id ?? "");
    const defaultId = String(prev.id ?? curId);
    const rows = await q`SELECT * FROM pay_periods WHERE org_id=${actor.orgId} ORDER BY starts_at DESC LIMIT 12`;
    return ok({
      periods: (rows as Record<string, unknown>[]).map((r) => toPeriod(r, curId)),
      currentPeriodId: curId,
      defaultPeriodId: defaultId,
    });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to load pay periods.");
  }
}

/** Owner/admin: one period + its manifest records + grouped totals. */
export async function getPayPeriodDetailCore(actor: PayoutActor, periodId: string): Promise<PayoutResult<PayPeriodDetail | null>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  try {
    await ensure();
    const q = await db();
    const list = await listPayPeriodsCore(actor);
    if (!list.ok) return list;
    const curId = list.data.currentPeriodId;
    const periods = await q`SELECT * FROM pay_periods WHERE org_id=${actor.orgId} AND id=${periodId} LIMIT 1`;
    if (!periods.length) return ok(null);
    const period = toPeriod(periods[0] as Record<string, unknown>, curId);
    const records = await q`
      SELECT pr.*, u.name AS contractor_name
      FROM payout_records pr JOIN users u ON u.id = pr.contractor_id
      WHERE pr.org_id=${actor.orgId} AND pr.period_id=${periodId}
      ORDER BY u.name ASC`;
    const rows: PayoutRecord[] = (records as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      orgId: String(r.org_id),
      periodId: String(r.period_id),
      contractorId: String(r.contractor_id),
      contractorName: String(r.contractor_name ?? ""),
      methodId: r.method_id != null ? String(r.method_id) : null,
      rail: r.rail != null ? (String(r.rail) as PayoutRail) : null,
      handleFull: r.handle_full != null ? String(r.handle_full) : null,
      handleMasked: String(r.handle_masked ?? ""),
      jobCount: r.job_count != null ? Number(r.job_count) : 0,
      goaJobCount: r.goa_job_count != null ? Number(r.goa_job_count) : 0,
      payrateCents: r.payrate_cents != null ? Number(r.payrate_cents) : null,
      grossCents: r.gross_cents != null ? Number(r.gross_cents) : 0,
      tipsCents: r.tips_cents != null ? Number(r.tips_cents) : 0,
      tirePlugCents: r.tire_plug_cents != null ? Number(r.tire_plug_cents) : 0,
      batteryPayoutCents: r.battery_payout_cents != null ? Number(r.battery_payout_cents) : 0,
      busyBonusCents: r.busy_bonus_cents != null ? Number(r.busy_bonus_cents) : 0,
      busyBonusJobs: r.busy_bonus_jobs != null ? Number(r.busy_bonus_jobs) : 0,
      busyBonusHours: Array.isArray(r.busy_bonus_hours)
        ? (r.busy_bonus_hours as { startsAtIso?: unknown; completedJobs?: unknown }[]).map((h) => ({ startsAtIso: String(h.startsAtIso ?? ""), completedJobs: Number(h.completedJobs ?? 0) }))
        : null,
      totalCents: r.total_cents != null ? Number(r.total_cents) : 0,
      methodStatus: String(r.method_status ?? "none") as PayoutMethodStatusOfRecord,
      status: String(r.status ?? "computed") as PayoutRecordStatus,
      paidAt: toIso(r.paid_at),
      payNote: r.pay_note != null ? String(r.pay_note) : null,
      createdAt: toIso(r.created_at) ?? iso(new Date(0)),
    }));
    // The payday manifest is intentionally earnings-only: computePaydayCore
    // never writes a payout_records row for a contractor with no period
    // components. The owner display, however, is a complete organization
    // roster. Add synthetic zero-activity rows here, after reading the
    // persisted manifest, so they cannot affect payout computation or rails.
    const roster = await q`
      SELECT u.id AS user_id, u.name, u.deactivated_at, cp.payrate_cents,
        pm.id AS method_id, pm.rail, pm.handle, pm.bank_institution_name, pm.bank_last4, pm.status AS method_status
      FROM users u
      JOIN organization_memberships m ON m.user_id=u.id AND m.org_id=${actor.orgId}
      LEFT JOIN contractor_profiles cp ON cp.org_id=${actor.orgId} AND cp.user_id=u.id
      LEFT JOIN payout_methods pm ON pm.org_id=${actor.orgId} AND pm.contractor_id=u.id
      WHERE m.role='contractor' OR u.towbook_driver_id IS NOT NULL
      ORDER BY LOWER(u.name), u.id`;
    const rosterById = new Map<string, Record<string, unknown>>();
    for (const r of roster as Record<string, unknown>[]) rosterById.set(String(r.user_id), r);
    for (const rec of rows) {
      const member = rosterById.get(rec.contractorId);
      if (member) rec.contractorActive = member.deactivated_at == null;
    }
    const displayedIds = new Set(rows.map((rec) => rec.contractorId));
    for (const member of rosterById.values()) {
      const contractorId = String(member.user_id);
      if (displayedIds.has(contractorId)) continue;
      const rail = member.rail != null ? String(member.rail) as PayoutRail : null;
      const methodStatus = member.method_status != null
        ? String(member.method_status) as PayoutMethodStatusOfRecord
        : "none";
      const handleFull = member.method_id == null
        ? null
        : rail === "bank"
          ? `${String(member.bank_institution_name ?? "").trim() || "Bank"} ••${String(member.bank_last4 ?? "").trim()}`.trim()
          : String(member.handle ?? "").trim() || null;
      const handleMasked = member.method_id == null
        ? ""
        : maskHandle(
            rail!,
            member.handle != null ? String(member.handle) : null,
            member.bank_institution_name != null ? String(member.bank_institution_name) : null,
            member.bank_last4 != null ? String(member.bank_last4) : null,
          );
      rows.push({
        id: `roster-${periodId}-${contractorId}`,
        orgId: actor.orgId,
        periodId,
        contractorId,
        contractorName: String(member.name ?? ""),
        contractorActive: member.deactivated_at == null,
        noActivityThisPeriod: true,
        methodId: member.method_id != null ? String(member.method_id) : null,
        rail,
        handleFull,
        handleMasked,
        jobCount: 0,
        goaJobCount: 0,
        payrateCents: member.payrate_cents != null ? Number(member.payrate_cents) : null,
        grossCents: 0,
        tipsCents: 0,
        tirePlugCents: 0,
        batteryPayoutCents: 0,
        busyBonusCents: 0,
        busyBonusJobs: 0,
        busyBonusHours: null,
        totalCents: 0,
        methodStatus,
        status: "computed",
        paidAt: null,
        payNote: null,
        createdAt: iso(new Date(0)),
      });
    }
    rows.sort((a, b) => a.contractorName.localeCompare(b.contractorName));

    const railsMap = new Map<PayoutRail, { count: number; totalCents: number }>();
    for (const rec of rows) {
      if (rec.noActivityThisPeriod || rec.status !== "computed" || !rec.rail) continue;
      const g = railsMap.get(rec.rail) ?? { count: 0, totalCents: 0 };
      g.count += 1;
      g.totalCents += rec.totalCents;
      railsMap.set(rec.rail, g);
    }
    const totals = {
      grossCents: rows.reduce((s, r) => s + r.grossCents, 0),
      tipsCents: rows.reduce((s, r) => s + r.tipsCents, 0),
      tirePlugCents: rows.reduce((s, r) => s + r.tirePlugCents, 0),
      batteryPayoutCents: rows.reduce((s, r) => s + r.batteryPayoutCents, 0),
      busyBonusCents: rows.reduce((s, r) => s + r.busyBonusCents, 0),
      totalCents: rows.reduce((s, r) => s + r.totalCents, 0),
      unknownTimestampCount: 0,
      contractorCount: rows.length,
      jobCount: rows.reduce((s, r) => s + r.jobCount, 0),
      dueCount: rows.filter((r) => !r.noActivityThisPeriod && r.status === "computed").length,
      paidCount: rows.filter((r) => !r.noActivityThisPeriod && r.status === "paid").length,
      blockedCount: rows.filter((r) => !r.noActivityThisPeriod && r.status === "blocked").length,
      rails: [...railsMap.entries()]
        .map(([rail, g]) => ({ rail, count: g.count, totalCents: g.totalCents }))
        .sort((a, b) => b.totalCents - a.totalCents),
    };
    return ok({ period, records: rows, totals });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to load the payday manifest.");
  }
}

/** Owner/admin: compute (or recompute) a closed period's payday. Counts
 *  completed jobs (status='completed', completed_at in window) joined to LD
 *  users via towbook_driver_id (same join driverEarnings uses), multiplies by
 *  the contractor_profiles payrate snapshot (NULL rate → gross 0, flagged),
 *  adds paid completion_tips on a separate line, and writes one payout_record
 *  per contractor with earnings. Contractors without a VERIFIED payout method
 *  → rail/handle recorded if a method row exists, status 'blocked' (amount
 *  still recorded — nothing silently dropped). Idempotent: recompute replaces
 *  the period's non-paid records; PAID rows are immutable and never touched.
 *  Payout amounts are mirrored into payment_transactions (kind 'payout',
 *  status 'staged', idempotency key payout-<recordId>) when the ledger table
 *  exists. */
export async function computePaydayCore(actor: PayoutActor, periodId: string): Promise<PayoutResult<PayPeriodDetail | null>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  try {
    await ensure();
    const q = await db();
    const periods = await q`SELECT * FROM pay_periods WHERE org_id=${actor.orgId} AND id=${periodId} LIMIT 1`;
    if (!periods.length) return err("not_found", "Period not found.");
    const periodRow = periods[0] as Record<string, unknown>;
    const startsAt = new Date(String(periodRow.starts_at));
    const endsAt = new Date(String(periodRow.ends_at));
    const now = new Date();
    if (startsAt.getTime() >= now.getTime()) return err("invalid_input", "This period hasn't opened yet.");
    if (endsAt.getTime() > now.getTime()) return err("invalid_input", "This period is still open — it closes Sunday 11:59 PM ET.");
    const wasPaid = String(periodRow.status) === "paid";
    const wasComputed = String(periodRow.status) === "computed";

    // Towbook's completionTime is the authoritative payday instant. The report
    // request defines membership; once rows return, do not apply this period's
    // local SQL half-open window to them. The local query remains a diagnostic
    // only and is the safe fallback when a QA/local environment has no report
    // credentials or exact-period snapshot.
    const unknownCompletionRows = await q`
      SELECT COUNT(*)::int AS count
      FROM dispatch_jobs dj
      WHERE dj.org_id=${actor.orgId} AND dj.status='completed'
        AND dj.assigned_driver_towbook_id IS NOT NULL
        AND (dj.raw_json->>'completionTime' IS NULL OR NOT (dj.raw_json->>'completionTime' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(T| )[0-9]{2}:[0-9]{2}:[0-9]{2}'))`;
    const unknownCompletionTimeRows = Number((unknownCompletionRows[0] as Record<string, unknown> | undefined)?.count ?? 0);
    const reportWindow = callWorkflowWindowForPeriod(startsAt, endsAt);
    let authoritativeReport: ReconciliationResult | null = null;
    let authoritativeRows: CallWorkflowRow[] = [];
    let reportWarning: string | null = null;
    const qaOrg = /^(qa-|test-)/i.test(actor.orgId);
    if (!qaOrg) {
      try {
        const fetched = await fetchCallWorkflow(reportWindow);
        authoritativeRows = fetched.rows;
        try { await saveTowbookSnapshot(actor.orgId, reportWindow, fetched.raw); } catch { reportWarning = "CallWorkflow ran, but the report snapshot could not be saved; the current computation still used its rows."; }
      } catch (reportError) {
        try {
          const snapshot = await loadTowbookSnapshot(actor.orgId, reportWindow);
          if (snapshot) {
            authoritativeRows = snapshot.rows;
            reportWarning = `Towbook report rerun unavailable; using the latest exact-period snapshot (${reportError instanceof Error ? reportError.message : "report unavailable"}).`;
          }
        } catch { /* fall through to the local-only QA fallback */ }
      }
    }
    if (authoritativeRows.length > 0 || !qaOrg) authoritativeReport = reconcileCallWorkflow(authoritativeRows, []);

    const hasReassignmentEvidence = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return false;
      if (Array.isArray(value)) return value.some(hasReassignmentEvidence);
      return Object.entries(value as Record<string, unknown>).some(([key, child]) =>
        /reassign/i.test(key) && (child != null && child !== false && child !== "" && child !== 0) || hasReassignmentEvidence(child));
    };
    let jobRows: Array<{ tb_id: string; job_count: number; goa_count: number }>;
    if (authoritativeReport) {
      // Reconcile against every dispatch row (not only locally completed rows),
      // joining dispatchEntryId → towbook_job_id, then id/callNumber fallbacks.
      // A report completion therefore itemizes even when raw_json completionTime
      // is absent or outside the local ET boundary.
      const allDispatchRows = await q`
        SELECT dj.id, dj.towbook_job_id, dj.assigned_driver_towbook_id, dj.raw_json, dj.manually_reassigned_at
        FROM dispatch_jobs dj
        WHERE dj.org_id=${actor.orgId}`;
      const reconciliation = reconcileCallWorkflow(authoritativeRows, allDispatchRows as Array<Record<string, unknown>>);
      authoritativeReport = reconciliation;
      const jobsById = new Map<string, Record<string, unknown>>();
      for (const row of allDispatchRows as Record<string, unknown>[]) jobsById.set(String(row.id), row);
      const paidBatteryJobs = await q`
        SELECT install_job_id FROM battery_sales
        WHERE org_id=${actor.orgId} AND status='paid' AND completed_at IS NOT NULL`;
      const paidBatteryIds = new Set((paidBatteryJobs as Record<string, unknown>[]).map((row) => String(row.install_job_id)));
      const grouped = new Map<string, { tb_id: string; job_count: number; goa_count: number }>();
      for (const row of reconciliation.rows) {
        if (row.classification !== "completed" && row.classification !== "goa") continue;
        if (!row.jobId || paidBatteryIds.has(row.jobId)) continue;
        const job = jobsById.get(row.jobId);
        const tb = row.towbookDriverId ?? String(job?.assigned_driver_towbook_id ?? "");
        if (!tb) continue;
        const groupedRow = grouped.get(tb) ?? { tb_id: tb, job_count: 0, goa_count: 0 };
        groupedRow.job_count += 1;
        if (row.classification === "goa") groupedRow.goa_count += 1;
        grouped.set(tb, groupedRow);
      }
      jobRows = [...grouped.values()];
      if (reconciliation.unmatchedCount > 0) {
        reportWarning = reportWarning ?? `CallWorkflow has ${reconciliation.unmatchedCount} unmatched/unitemized report rows; the authoritative report total is preserved in diagnostics and only matched rows are payable.`;
      }
    } else {
      // Safe local fallback for hermetic QA environments without Towbook
      // credentials. Production computes from the report path above whenever a
      // report or exact-period snapshot is available.
      const candidateJobRows = await q`
        SELECT dj.assigned_driver_towbook_id AS tb_id, dj.status, dj.raw_json, dj.manually_reassigned_at
        FROM dispatch_jobs dj
        WHERE dj.org_id=${actor.orgId} AND dj.status='completed'
          AND (COALESCE(dj.raw_json->>'statusId', dj.raw_json->>'status') IS NULL
            OR COALESCE(dj.raw_json->>'statusId', dj.raw_json->>'status') NOT IN ('255','cancelled','canceled'))
          AND CASE WHEN dj.raw_json->>'completionTime' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(T| )[0-9]{2}:[0-9]{2}:[0-9]{2}' THEN (dj.raw_json->>'completionTime')::timestamptz END >= ${iso(startsAt)}
          AND CASE WHEN dj.raw_json->>'completionTime' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(T| )[0-9]{2}:[0-9]{2}:[0-9]{2}' THEN (dj.raw_json->>'completionTime')::timestamptz END < ${iso(endsAt)}
          AND dj.assigned_driver_towbook_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM battery_sales bs
            WHERE bs.org_id=dj.org_id AND bs.install_job_id=dj.id
              AND bs.status='paid' AND bs.completed_at IS NOT NULL
          )`;
      const payableJobs = (candidateJobRows as Record<string, unknown>[]).filter((r) => {
        if (r.manually_reassigned_at != null) return false;
        let raw: unknown = r.raw_json;
        if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { return false; } }
        return !hasReassignmentEvidence(raw);
      });
      jobRows = [...payableJobs.reduce((m, r) => {
        const tb = String(r.tb_id);
        const row = m.get(tb) ?? { tb_id: tb, job_count: 0, goa_count: 0 };
        row.job_count += 1;
        let raw: unknown = r.raw_json;
        if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { raw = null; } }
        const items = raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).invoiceItems)
          ? (raw as Record<string, unknown>).invoiceItems as unknown[] : [];
        if (items.some((item) => item && typeof item === "object" && /goa/i.test(String((item as Record<string, unknown>).name ?? "")))) row.goa_count += 1;
        m.set(tb, row); return m;
      }, new Map<string, { tb_id: string; job_count: number; goa_count: number }>()).values()];
    }
    // BUSY-TIME BONUS (owner-locked 2026-08-13): 3+ ASSIGNED calls per
    // contractor within one clock hour = busy hour; +$1 per job COMPLETED in
    // that busy hour. Derived here (pure busy-bonus-core math) from every
    // driver-attributed dispatch_jobs row — the assignment instant is
    // COALESCE(assigned_at, raw dispatchTime, created_at), the completion
    // instant COALESCE(completed_at, raw completionTime); both must fall
    // inside the period window (same out-of-window exclusion payday applies).
    // Recompute-stable: same rows in → same bonus out.
    const { computeBusyBonus, jobAssignmentMs, jobCompletedMs } = await import("./busy-bonus-core");
    const busyJobRows = await q`
      SELECT dj.assigned_driver_towbook_id AS tb_id, dj.status,
        dj.assigned_at, dj.completed_at, dj.created_at, dj.raw_json, dj.manually_reassigned_at
      FROM dispatch_jobs dj
      WHERE dj.org_id=${actor.orgId} AND dj.assigned_driver_towbook_id IS NOT NULL
        AND (COALESCE(dj.raw_json->>'statusId', dj.raw_json->>'status') IS NULL
          OR COALESCE(dj.raw_json->>'statusId', dj.raw_json->>'status') NOT IN ('255','cancelled','canceled'))`;
    const assignByTb = new Map<string, Array<number | null>>();
    const completeByTb = new Map<string, Array<number | null>>();
    for (const r of busyJobRows as Record<string, unknown>[]) {
      if (r.manually_reassigned_at != null) continue;
      let raw: unknown = r.raw_json;
      if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { continue; } }
      if (hasReassignmentEvidence(raw)) continue;
      const tb = String(r.tb_id);
      if (!tb) continue;
      const aMs = jobAssignmentMs(r);
      if (aMs != null && aMs >= startsAt.getTime() && aMs < endsAt.getTime()) {
        if (!assignByTb.has(tb)) assignByTb.set(tb, []);
        assignByTb.get(tb)!.push(aMs);
      }
      if (String(r.status) === "completed") {
        const cMs = jobCompletedMs(r);
        if (cMs != null && cMs >= startsAt.getTime() && cMs < endsAt.getTime()) {
          if (!completeByTb.has(tb)) completeByTb.set(tb, []);
          completeByTb.get(tb)!.push(cMs);
        }
      }
    }
    // TIP CASH-OUT EXCLUSION (owner-directed 2026-08-12): any tip row covered
    // by a PAID cash-out was already paid outside payday — it must NEVER appear
    // in a manifest again (covered_tip_ids is recorded at request time, so
    // every later compute/recompute excludes it, in every period).
    const coveredPaid = await q`SELECT DISTINCT tid AS id
      FROM tip_cashouts tc, jsonb_array_elements_text(tc.covered_tip_ids) tid
      WHERE tc.org_id=${actor.orgId} AND tc.status='paid'`;
    const coveredTipIds = (coveredPaid as Record<string, unknown>[]).map((r) => String(r.id));
    const tipRows = coveredTipIds.length
      ? await q`
          SELECT driver_id, COALESCE(SUM(amount_cents), 0)::int AS tip_cents
          FROM completion_tips
          WHERE org_id=${actor.orgId} AND status='paid'
            AND created_at >= ${iso(startsAt)} AND created_at < ${iso(endsAt)}
            AND NOT (id = ANY(${coveredTipIds}))
          GROUP BY driver_id`
      : await q`
          SELECT driver_id, COALESCE(SUM(amount_cents), 0)::int AS tip_cents
          FROM completion_tips
          WHERE org_id=${actor.orgId} AND status='paid'
            AND created_at >= ${iso(startsAt)} AND created_at < ${iso(endsAt)}
          GROUP BY driver_id`;
    const coveredTire = await q`SELECT DISTINCT tid AS id FROM tip_cashouts tc, jsonb_array_elements_text(tc.covered_tire_plug_ids) tid WHERE tc.org_id=${actor.orgId} AND tc.status='paid'`;
    const coveredTireIds = (coveredTire as Record<string, unknown>[]).map((r) => String(r.id));
    const tireRows = coveredTireIds.length ? await q`
      SELECT contractor_user_id, COALESCE(SUM(amount_cents),0)::int AS cents FROM tire_plug_transactions
      WHERE org_id=${actor.orgId} AND status='paid' AND paid_at >= ${iso(startsAt)} AND paid_at < ${iso(endsAt)} AND NOT (id = ANY(${coveredTireIds})) GROUP BY contractor_user_id`
      : await q`
      SELECT contractor_user_id, COALESCE(SUM(amount_cents),0)::int AS cents FROM tire_plug_transactions
      WHERE org_id=${actor.orgId} AND status='paid' AND paid_at >= ${iso(startsAt)} AND paid_at < ${iso(endsAt)} GROUP BY contractor_user_id`;
    const tireCentsByUser = new Map<string, number>();
    for (const r of tireRows as Record<string, unknown>[]) tireCentsByUser.set(String(r.contractor_user_id), Number(r.cents ?? 0));
    // Battery payouts are earned only by a completed, non-voided sale. The
    // completion hook records one immutable row per sale; aggregating that
    // ledger is replay-stable and keeps reassigned work on the completing
    // driver's identity captured at completion.
    const batteryRows = await q`
      SELECT bp.contractor_user_id, COALESCE(SUM(bp.amount_cents), 0)::int AS cents
      FROM battery_payouts bp
      JOIN battery_sales bs ON bs.org_id=bp.org_id AND bs.id=bp.sale_id
      WHERE bp.org_id=${actor.orgId} AND bp.earned_at >= ${iso(startsAt)} AND bp.earned_at < ${iso(endsAt)}
        AND bs.status='paid' AND bs.completed_at IS NOT NULL
      GROUP BY bp.contractor_user_id`;
    const batteryCentsByUser = new Map<string, number>();
    for (const r of batteryRows as Record<string, unknown>[]) batteryCentsByUser.set(String(r.contractor_user_id), Number(r.cents ?? 0));
    const userRows = await q`
      SELECT u.id AS user_id, u.name, u.towbook_driver_id, cp.payrate_cents
      FROM users u
      JOIN organization_memberships m ON m.user_id=u.id AND m.org_id=${actor.orgId}
      LEFT JOIN contractor_profiles cp ON cp.org_id=${actor.orgId} AND cp.user_id=u.id
      WHERE u.towbook_driver_id IS NOT NULL`;
    const methodRows = await q`
      SELECT id, contractor_id, rail, handle, bank_institution_name, bank_last4, status
      FROM payout_methods WHERE org_id=${actor.orgId}`;

    const userByTb = new Map<string, { userId: string; name: string; payrateCents: number | null }>();
    for (const r of userRows as Record<string, unknown>[]) userByTb.set(String(r.towbook_driver_id), { userId: String(r.user_id), name: String(r.name ?? ""), payrateCents: r.payrate_cents != null ? Number(r.payrate_cents) : null });
    const methodByUser = new Map<string, Record<string, unknown>>();
    for (const r of methodRows as Record<string, unknown>[]) methodByUser.set(String(r.contractor_id), r);
    const tipCentsByUser = new Map<string, number>();
    for (const r of tipRows as Record<string, unknown>[]) tipCentsByUser.set(String(r.driver_id), Number(r.tip_cents ?? 0));

    // contractor → all payout components keyed by user id. Battery installs are
    // separate from generic job count so one install can never double-pay.
    const earnByUser = new Map<string, { jobCount: number; goaJobCount: number; payrateCents: number | null; tipsCents: number; tirePlugCents: number; batteryPayoutCents: number }>();
    // Seed users from the authoritative matched report population before adding
    // job-level components. This prevents a matched report row with a missing
    // local timestamp from disappearing simply because the old dispatch-only
    // candidate query returned no row.
    if (authoritativeReport) {
      for (const row of authoritativeReport.rows) {
        if (row.classification !== "completed" && row.classification !== "goa") continue;
        const u = row.towbookDriverId ? userByTb.get(row.towbookDriverId) : undefined;
        if (!u || earnByUser.has(u.userId)) continue;
        earnByUser.set(u.userId, { jobCount: 0, goaJobCount: 0, payrateCents: u.payrateCents, tipsCents: 0, tirePlugCents: 0, batteryPayoutCents: 0 });
      }
    }
    for (const [uid, cents] of tireCentsByUser) {
      const u = [...userByTb.values()].find((v) => v.userId === uid);
      if (!u) continue;
      const e = { jobCount: 0, goaJobCount: 0, payrateCents: u.payrateCents, tipsCents: 0, tirePlugCents: cents, batteryPayoutCents: 0 };
      earnByUser.set(uid, e);
    }
    for (const r of jobRows as Record<string, unknown>[]) {
      const tb = String(r.tb_id);
      const u = userByTb.get(tb);
      if (!u) continue; // no LD user for this Towbook driver → cannot attribute pay
      const e = earnByUser.get(u.userId) ?? { jobCount: 0, goaJobCount: 0, payrateCents: u.payrateCents, tipsCents: 0, tirePlugCents: 0, batteryPayoutCents: 0 };
      e.jobCount += Number(r.job_count ?? 0);
      e.goaJobCount += Number(r.goa_count ?? 0);
      earnByUser.set(u.userId, e);
    }
    for (const [uid, cents] of batteryCentsByUser) {
      const existing = earnByUser.get(uid);
      if (existing) existing.batteryPayoutCents = cents;
      else {
        const u = [...userByTb.values()].find((v) => v.userId === uid);
        earnByUser.set(uid, { jobCount: 0, goaJobCount: 0, payrateCents: u?.payrateCents ?? null, tipsCents: 0, tirePlugCents: 0, batteryPayoutCents: cents });
      }
    }
    for (const [uid, cents] of tipCentsByUser) {
      if (!earnByUser.has(uid)) {
        const u = userByTb.get([...userByTb.entries()].find(([, v]) => v.userId === uid)?.[0] ?? "");
        earnByUser.set(uid, { jobCount: 0, goaJobCount: 0, payrateCents: u?.payrateCents ?? null, tipsCents: cents, tirePlugCents: 0, batteryPayoutCents: 0 });
      } else {
        earnByUser.get(uid)!.tipsCents = cents;
      }
    }
    // busy bonus per LD user (tb id → user id, mirroring the jobRows join)
    const busyByUser = new Map<string, { bonusCents: number; bonusJobs: number; hours: { startsAtIso: string; completedJobs: number }[] }>();
    for (const [tb, user] of userByTb) {
      const bonus = computeBusyBonus(assignByTb.get(tb) ?? [], completeByTb.get(tb) ?? []);
      if (bonus.bonusJobs === 0) continue;
      busyByUser.set(user.userId, {
        bonusCents: bonus.bonusCents,
        bonusJobs: bonus.bonusJobs,
        hours: bonus.hours.map((h) => ({ startsAtIso: iso(new Date(h.startsAtMs)), completedJobs: h.completedJobs })),
      });
    }

    // wipe non-paid records → recompute replaces; paid rows stay (immutable)
    await q`DELETE FROM payout_records WHERE org_id=${actor.orgId} AND period_id=${periodId} AND status <> 'paid'`;

    const records: PayoutRecord[] = [];
    for (const [uid, e] of earnByUser) {
      const method = methodByUser.get(uid);
      const methodStatus: PayoutMethodStatusOfRecord = method ? (String(method.status) as PayoutMethodStatusOfRecord) : "none";
      const verified = methodStatus === "verified";
      const rail = method ? (String(method.rail) as PayoutRail) : null;
      const handleFull = method ? (rail === "bank"
        ? `${String(method.bank_institution_name ?? "").trim() || "Bank"} ••${String(method.bank_last4 ?? "").trim()}`.trim()
        : String(method.handle ?? "").trim() || null) : null;
      const handleMasked = method ? maskHandle(rail!, method.handle != null ? String(method.handle) : null, method.bank_institution_name != null ? String(method.bank_institution_name) : null, method.bank_last4 != null ? String(method.bank_last4) : null) : "";
      // GOA rows pay the flat $10 amount; every other payable row uses the
      // contractor's configured rate. GOA was counted from invoiceItems only.
      const goaCount = (jobRows as Record<string, unknown>[]).filter((r) => String(r.tb_id) === [...userByTb.entries()].find(([, v]) => v.userId === uid)?.[0]).reduce((s, r) => s + Number(r.goa_count ?? 0), 0);
      const normalJobCount = Math.max(0, e.jobCount - goaCount);
      const grossCents = (goaCount * 1000) + (e.payrateCents != null ? e.payrateCents * normalJobCount : 0);
      const tipsCents = e.tipsCents;
      const tirePlugCents = e.tirePlugCents;
      const batteryPayoutCents = e.batteryPayoutCents;
      const busy = busyByUser.get(uid) ?? { bonusCents: 0, bonusJobs: 0, hours: null as { startsAtIso: string; completedJobs: number }[] | null };
      const busyHoursJson = busy.hours && busy.hours.length ? busy.hours : null;
      const totalCents = grossCents + tipsCents + tirePlugCents + batteryPayoutCents + busy.bonusCents;
      const recordId = `pr-${periodId}-${uid}`;
      const inserted = await q`INSERT INTO payout_records(id, org_id, period_id, contractor_id, method_id, rail, handle_full, handle_masked,
          job_count, goa_job_count, payrate_cents, gross_cents, tips_cents, tire_plug_cents, battery_payout_cents, busy_bonus_cents, busy_bonus_jobs, busy_bonus_hours, total_cents, method_status, status, updated_at)
        VALUES(${recordId}, ${actor.orgId}, ${periodId}, ${uid}, ${method ? String(method.id) : null}, ${rail}, ${handleFull}, ${handleMasked},
          ${e.jobCount}, ${goaCount}, ${e.payrateCents}, ${grossCents}, ${tipsCents}, ${tirePlugCents}, ${batteryPayoutCents}, ${busy.bonusCents}, ${busy.bonusJobs}, ${busyHoursJson ? JSON.stringify(busyHoursJson) : null}, ${totalCents}, ${methodStatus}, ${verified ? "computed" : "blocked"}, NOW())
        ON CONFLICT (org_id, period_id, contractor_id) DO NOTHING
        RETURNING id`;
      const recordInserted = Array.isArray(inserted) && inserted.length > 0;
      // mirror into the payment_transactions ledger (kind 'payout') — exists;
      // guarded so a ledger hiccup never fails the manifest write. Only the
      // rows WE just wrote are mirrored (a paid-row conflict never re-mirrors),
      // and a recompute refreshes the staged amount.
      if (recordInserted) {
        try {
          await q`INSERT INTO payment_transactions(id, org_id, kind, amount_cents, currency, status, idempotency_key, attempt)
            VALUES(${`pt-${recordId}`}, ${actor.orgId}, 'payout', ${totalCents}, 'USD', 'staged', ${`payout-${recordId}`}, 0)
            ON CONFLICT (idempotency_key) DO UPDATE SET amount_cents=EXCLUDED.amount_cents, updated_at=NOW()`;
        } catch { /* ledger mirror is best-effort */ }
      }
      records.push({
        id: recordId,
        orgId: actor.orgId,
        periodId,
        contractorId: uid,
        contractorName: userByTb.get([...userByTb.entries()].find(([, v]) => v.userId === uid)?.[0] ?? "")?.name ?? "",
        methodId: method ? String(method.id) : null,
        rail,
        handleFull,
        handleMasked,
        jobCount: e.jobCount,
        goaJobCount: goaCount,
        payrateCents: e.payrateCents,
        grossCents,
        tipsCents,
        tirePlugCents,
        batteryPayoutCents,
        busyBonusCents: busy.bonusCents,
        busyBonusJobs: busy.bonusJobs,
        busyBonusHours: busyHoursJson,
        totalCents,
        methodStatus,
        status: verified ? "computed" : "blocked",
        paidAt: null,
        payNote: null,
        createdAt: iso(new Date()),
      });
    }

    if (!wasPaid) {
      await q`UPDATE pay_periods SET status='computed', computed_at=NOW(), updated_at=NOW() WHERE org_id=${actor.orgId} AND id=${periodId}`;
    }
    try {
      const masked = records.length ? `${records.length} contractors · ${(records.reduce((s, r) => s + r.totalCents, 0) / 100).toFixed(2)}` : "0 contractors";
      await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
        SELECT gen_random_uuid()::text, ${actor.orgId}, ${actor.id}, ${actor.role}, ${wasComputed ? "payout_period_recomputed" : "payday_computed"}, 'pay_period', ${periodId},
          jsonb_build_object('window', ${`${iso(startsAt)}..${iso(endsAt)}`}::text, 'summary', ${masked}::text), 'owner-money'`;
    } catch { /* best-effort audit */ }

    const reconciliationDiagnostics = authoritativeReport ? {
      reportCount: authoritativeReport.reportCount,
      matchedCount: authoritativeReport.matchedCount,
      matchedPayableCount: authoritativeReport.matchedPayableCount,
      reassignedCount: authoritativeReport.reassignedCount,
      unmatchedCount: authoritativeReport.unmatchedCount,
      unitemizedCount: authoritativeReport.unitemizedCount,
      reconciliationWarning: reportWarning,
    } : {
      reconciliationWarning: "No authoritative CallWorkflow report or exact-period snapshot was available; this computation used the local QA fallback.",
    };
    const diagnostics = { unknownCompletionTimeRows, ...reconciliationDiagnostics };
    const detail = await getPayPeriodDetailCore(actor, periodId);
    if (detail.ok && detail.data) {
      detail.data.diagnostics = diagnostics;
      return detail;
    }
    const fallback = await buildDetailFallback(actor, periodId, records);
    fallback.diagnostics = diagnostics;
    return ok(fallback);
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to compute payday.");
  }
}

/** Fallback detail when the post-compute read fails (never leaves the caller
 *  empty-handed) — mirrors the rows we just wrote. */
async function buildDetailFallback(actor: PayoutActor, periodId: string, records: PayoutRecord[]): Promise<PayPeriodDetail> {
  const list = await listPayPeriodsCore(actor);
  const curId = list.ok ? list.data.currentPeriodId : "";
  const q = await db();
  const periods = await q`SELECT * FROM pay_periods WHERE org_id=${actor.orgId} AND id=${periodId} LIMIT 1`;
  const period = toPeriod((periods[0] ?? {}) as Record<string, unknown>, curId);
  const totals = {
    grossCents: records.reduce((s, r) => s + r.grossCents, 0),
    tipsCents: records.reduce((s, r) => s + r.tipsCents, 0),
    busyBonusCents: records.reduce((s, r) => s + r.busyBonusCents, 0),
    tirePlugCents: records.reduce((s, r) => s + r.tirePlugCents, 0),
    batteryPayoutCents: records.reduce((s, r) => s + r.batteryPayoutCents, 0),
    totalCents: records.reduce((s, r) => s + r.totalCents, 0),
    unknownTimestampCount: 0,
    contractorCount: records.length,
    jobCount: records.reduce((s, r) => s + r.jobCount, 0),
    dueCount: records.filter((r) => r.status === "computed").length,
    paidCount: records.filter((r) => r.status === "paid").length,
    blockedCount: records.filter((r) => r.status === "blocked").length,
    rails: [],
  };
  return { period, records, totals };
}

/** Owner/admin: mark ONE payout record paid (owner confirmed the send in
 *  their own app — the confirm sheet is the gate, nothing is optimistic).
 *  Flips the period to 'paid' when no 'computed' rows remain. */
export async function markPayoutPaidCore(actor: PayoutActor, data: unknown): Promise<PayoutResult<PayPeriodDetail | null>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  const v = z.object({ recordId: z.string().min(1), note: z.string().max(300).nullable().optional() }).safeParse(data);
  if (!v.success) return err("invalid_input", "Record id required.");
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT pr.*, pr.period_id AS pid FROM payout_records pr
      WHERE pr.org_id=${actor.orgId} AND pr.id=${v.data.recordId} LIMIT 1`;
    if (!rows.length) return err("not_found", "Payout record not found.");
    const r = rows[0] as Record<string, unknown>;
    if (String(r.status) !== "computed") return err("invalid_input", String(r.status) === "paid" ? "This payout is already marked paid." : "Blocked payouts can't be marked paid — verify the contractor's payout method first.");
    const periodId = String(r.pid);
    await q`UPDATE payout_records SET status='paid', paid_at=NOW(), paid_by_user_id=${actor.id}, pay_note=${v.data.note ?? null}, updated_at=NOW()
      WHERE org_id=${actor.orgId} AND id=${v.data.recordId}`;
    try {
      await q`UPDATE payment_transactions SET status='charged', updated_at=NOW() WHERE idempotency_key=${`payout-${v.data.recordId}`}`;
    } catch { /* best-effort mirror */ }
    try {
      await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
        SELECT gen_random_uuid()::text, ${actor.orgId}, ${actor.id}, ${actor.role}, 'payout_marked_paid', 'payout_record', ${v.data.recordId},
          jsonb_build_object('contractorId', ${String(r.contractor_id)}::text, 'handleMasked', ${String(r.handle_masked ?? "")}::text,
            'totalCents', ${Number(r.total_cents ?? 0)}::int, 'note', ${v.data.note ?? null}::text), 'owner-money'`;
    } catch { /* best-effort audit */ }
    const remaining = await q`SELECT COUNT(*)::int AS c FROM payout_records WHERE org_id=${actor.orgId} AND period_id=${periodId} AND status IN ('computed','blocked')`;
    if (Number(remaining[0]?.c ?? 0) === 0) {
      await q`UPDATE pay_periods SET status='paid', paid_at=NOW(), updated_at=NOW() WHERE org_id=${actor.orgId} AND id=${periodId}`;
    }
    const detail = await getPayPeriodDetailCore(actor, periodId);
    return detail.ok && detail.data ? detail : err("database_error", "Paid, but the manifest reload failed.");
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to mark the payout paid.");
  }
}

/** Owner/admin: mark the WHOLE period paid (all 'computed' rows) — the
 *  period-level "paid out" action. Blocked rows stay blocked. */
export async function markPaydayPeriodPaidCore(actor: PayoutActor, periodId: string): Promise<PayoutResult<PayPeriodDetail | null>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  try {
    await ensure();
    const q = await db();
    const periods = await q`SELECT id FROM pay_periods WHERE org_id=${actor.orgId} AND id=${periodId} LIMIT 1`;
    if (!periods.length) return err("not_found", "Period not found.");
    const updated = await q`UPDATE payout_records SET status='paid', paid_at=NOW(), paid_by_user_id=${actor.id}, updated_at=NOW()
      WHERE org_id=${actor.orgId} AND period_id=${periodId} AND status='computed'
      RETURNING id`;
    try {
      await q`UPDATE payment_transactions SET status='charged', updated_at=NOW()
        WHERE org_id=${actor.orgId} AND idempotency_key LIKE ${`payout-pr-${periodId}-%`}`;
    } catch { /* best-effort mirror */ }
    const paidCount = Array.isArray(updated) ? updated.length : 0;
    await q`UPDATE pay_periods SET status='paid', paid_at=NOW(), updated_at=NOW() WHERE org_id=${actor.orgId} AND id=${periodId}`;
    try {
      await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
        SELECT gen_random_uuid()::text, ${actor.orgId}, ${actor.id}, ${actor.role}, 'payout_period_marked_paid', 'pay_period', ${periodId},
          jsonb_build_object('recordsPaid', ${paidCount}::int), 'owner-money'`;
    } catch { /* best-effort audit */ }
    const detail = await getPayPeriodDetailCore(actor, periodId);
    return detail.ok && detail.data ? detail : err("database_error", "Marked paid, but the manifest reload failed.");
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to mark the period paid.");
  }
}

/** Owner/admin: verify a contractor's payout method (owner-confirmed — the
 *  owner sends a test payment from their own app first; the UI prompts it). */
export async function verifyPayoutMethodCore(actor: PayoutActor, methodId: string): Promise<PayoutResult<OwnerPayoutMethod | null>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT id, contractor_id FROM payout_methods WHERE org_id=${actor.orgId} AND id=${methodId} LIMIT 1`;
    if (!rows.length) return ok(null);
    await q`UPDATE payout_methods SET status='verified', reject_note=NULL, updated_at=NOW() WHERE org_id=${actor.orgId} AND id=${methodId}`;
    try {
      await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
        SELECT gen_random_uuid()::text, ${actor.orgId}, ${actor.id}, ${actor.role}, 'payout_method_verified', 'contractor', ${methodId},
          jsonb_build_object('methodId', ${methodId}::text), 'owner-money'`;
    } catch { /* best-effort audit */ }
    return getContractorPayoutMethodCore(actor, String((rows[0] as Record<string, unknown>).contractor_id ?? ""));
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to verify the payout method.");
  }
}

/** Owner/admin: reject a contractor's payout method with a note (shown to the
 *  contractor; re-save resets to connected_unverified). */
export async function rejectPayoutMethodCore(actor: PayoutActor, data: unknown): Promise<PayoutResult<OwnerPayoutMethod | null>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  const v = z.object({ methodId: z.string().min(1), note: z.string().max(300).optional() }).safeParse(data);
  if (!v.success) return err("invalid_input", "Method id required.");
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT id, contractor_id FROM payout_methods WHERE org_id=${actor.orgId} AND id=${v.data.methodId} LIMIT 1`;
    if (!rows.length) return ok(null);
    await q`UPDATE payout_methods SET status='rejected', reject_note=${v.data.note ?? null}, updated_at=NOW() WHERE org_id=${actor.orgId} AND id=${v.data.methodId}`;
    try {
      await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
        SELECT gen_random_uuid()::text, ${actor.orgId}, ${actor.id}, ${actor.role}, 'payout_method_rejected', 'contractor', ${v.data.methodId},
          jsonb_build_object('methodId', ${v.data.methodId}::text), 'owner-money'`;
    } catch { /* best-effort audit */ }
    return getContractorPayoutMethodCore(actor, String((rows[0] as Record<string, unknown>).contractor_id ?? ""));
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to reject the payout method.");
  }
}

/** Owner/admin: EDIT a contractor's payout method (owner-directed 2026-08-13
 *  — the owner may need to correct a typo'd handle before approving). Any
 *  change to rail/handle/bank details RE-TRIGGERS verification (status →
 *  connected_unverified, reject_note cleared — matching the contractor
 *  self-edit semantics); saving the SAME values keeps the current status
 *  (idempotent, no audit row). Bank routing/account are re-encrypted under the
 *  dedicated key; full numbers never land in audit/log text (masked only). */
export async function editPayoutMethodCore(actor: PayoutActor, data: unknown): Promise<PayoutResult<OwnerPayoutMethod | null>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  const v = z.object({ methodId: z.string().min(1) }).merge(SET_SCHEMA).safeParse(data);
  if (!v.success) return err("invalid_input", v.error.issues[0]?.message ?? "Invalid payout method.");
  const validated = validatePayoutInput({
    rail: v.data.rail,
    handle: v.data.handle ?? null,
    bankInstitutionName: v.data.bankInstitutionName ?? null,
    bankLast4: v.data.bankLast4 ?? null,
    bankRoutingNumber: v.data.bankRoutingNumber ?? null,
    bankAccountNumber: v.data.bankAccountNumber ?? null,
  });
  if (!validated.ok) return validated;
  const d = validated.data;
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT id, contractor_id, rail, handle, bank_institution_name, bank_last4,
        bank_routing_encrypted, bank_account_encrypted, status, reject_note
      FROM payout_methods WHERE org_id=${actor.orgId} AND id=${v.data.methodId} LIMIT 1`;
    if (!rows.length) return ok(null);
    const existing = rows[0] as Record<string, unknown>;
    const contractorId = String(existing.contractor_id ?? "");
    let routingEnc: string | null = null;
    let accountEnc: string | null = null;
    if (d.rail === "bank") {
      const { encryptBankValue } = await import("./bank-key");
      routingEnc = await encryptBankValue(d.bankRoutingNumber!);
      accountEnc = await encryptBankValue(d.bankAccountNumber!);
    }
    let prevRouting = "";
    let prevAccount = "";
    if (existing && d.rail === "bank") {
      try {
        const { decryptBankValue } = await import("./bank-key");
        prevRouting = existing.bank_routing_encrypted != null ? await decryptBankValue(String(existing.bank_routing_encrypted)) : "";
        prevAccount = existing.bank_account_encrypted != null ? await decryptBankValue(String(existing.bank_account_encrypted)) : "";
      } catch { /* decrypt failure → treated as different values */ }
    }
    const sameValues =
      String(existing.rail) === d.rail &&
      (d.rail === "bank"
        ? String(existing.bank_institution_name ?? "") === d.bankInstitutionName && String(existing.bank_last4 ?? "") === d.bankLast4 && prevRouting === d.bankRoutingNumber && prevAccount === d.bankAccountNumber
        : String(existing.handle ?? "") === d.handle);
    const prevStatus = String(existing.status ?? "connected_unverified") as PayoutStatus;
    const status: PayoutStatus = sameValues ? prevStatus : "connected_unverified";
    await q`UPDATE payout_methods SET
        rail=${d.rail}, handle=${d.handle}, bank_institution_name=${d.bankInstitutionName}, bank_last4=${d.bankLast4},
        bank_routing_encrypted=${routingEnc}, bank_account_encrypted=${accountEnc},
        status=${status}, reject_note=${sameValues ? existing.reject_note != null ? String(existing.reject_note) : null : null}, updated_at=NOW()
      WHERE org_id=${actor.orgId} AND id=${v.data.methodId}`;
    if (!sameValues) {
      try {
        const masked = maskHandle(d.rail, d.handle, d.bankInstitutionName, d.bankLast4);
        await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
          SELECT gen_random_uuid()::text, ${actor.orgId}, ${actor.id}, ${actor.role}, 'payout_method_edited', 'contractor', ${contractorId},
            jsonb_build_object('methodId', ${v.data.methodId}::text, 'handleMasked', ${masked}::text, 'statusBefore', ${prevStatus}::text, 'statusAfter', ${status}::text), 'owner-contractors'`;
      } catch { /* best-effort audit */ }
    }
    return getContractorPayoutMethodCore(actor, contractorId);
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to edit the payout method.");
  }
}

/** Owner/admin: the three Money-tab cards (Revenue / Tips / Payouts). Revenue
 *  = charged club_charge rows in the payment ledger; Tips = paid completion_tips
 *  (canonical, driver-attributed); Payouts = Σ records in the just-closed
 *  (default) period. hasRealMoney gates the demo chip — it flips off only
 *  once a real club charge has settled. */
export async function getMoneyOverviewCore(actor: PayoutActor): Promise<PayoutResult<MoneyOverview>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  try {
    await ensure();
    const q = await db();
    const rev = await q`SELECT COALESCE(SUM(amount_cents), 0)::int AS total, COUNT(*)::int AS cnt
      FROM payment_transactions WHERE org_id=${actor.orgId} AND kind='club_charge' AND status='charged'`;
    const staged = await q`SELECT COUNT(*)::int AS cnt FROM payment_transactions WHERE org_id=${actor.orgId} AND kind='club_charge' AND status='staged'`;
    const tips = await q`SELECT COALESCE(SUM(amount_cents), 0)::int AS total, COUNT(*)::int AS cnt
      FROM completion_tips WHERE org_id=${actor.orgId} AND status='paid'`;
    const weekly = periodBoundariesFor(new Date());
    const weeklyTips = await q`SELECT u.id AS driver_id, u.name AS driver_name,
        COALESCE(SUM(ct.amount_cents), 0)::int AS tips_cents, COUNT(ct.id)::int AS tip_count
      FROM users u JOIN organization_memberships m ON m.user_id=u.id AND m.org_id=${actor.orgId}
      LEFT JOIN completion_tips ct ON ct.org_id=${actor.orgId}
        AND (ct.driver_id=u.id OR (ct.driver_id IS NULL AND ct.driver_towbook_id=u.towbook_driver_id))
        AND ct.status='paid'
        AND ct.created_at >= ${iso(weekly.startsAt)} AND ct.created_at < ${iso(new Date(weekly.endsAt.getTime() + 1))}
      WHERE m.role='driver'
      GROUP BY u.id, u.name ORDER BY u.name ASC`;
    const list = await listPayPeriodsCore(actor);
    let payoutsDueCents = 0;
    let payoutsDueCount = 0;
    let payoutsDueOn: string | null = null;
    if (list.ok) {
      const defaultId = list.data.defaultPeriodId;
      const recs = await q`SELECT COALESCE(SUM(total_cents), 0)::int AS total, COUNT(*)::int AS cnt
        FROM payout_records WHERE org_id=${actor.orgId} AND period_id=${defaultId} AND status IN ('computed','blocked')`;
      payoutsDueCents = Number(recs[0]?.total ?? 0);
      payoutsDueCount = Number(recs[0]?.cnt ?? 0);
      const p = list.data.periods.find((x) => x.id === defaultId);
      payoutsDueOn = p?.payoutDueOn ?? null;
    }
    const revenueCents = Number(rev[0]?.total ?? 0);
    return ok({
      revenueCents,
      revenueChargedCount: Number(rev[0]?.cnt ?? 0),
      revenueStagedCount: Number(staged[0]?.cnt ?? 0),
      tipsCents: Number(tips[0]?.total ?? 0),
      tipsCount: Number(tips[0]?.cnt ?? 0),
      weeklyTipsCents: (weeklyTips as Record<string, unknown>[]).reduce((s, r) => s + Number(r.tips_cents ?? 0), 0),
      weeklyTipCount: (weeklyTips as Record<string, unknown>[]).reduce((s, r) => s + Number(r.tip_count ?? 0), 0),
      weeklyTipsByDriver: (weeklyTips as Record<string, unknown>[]).map((r) => ({ driverId: String(r.driver_id), driverName: String(r.driver_name ?? "Unknown driver"), tipsCents: Number(r.tips_cents ?? 0), tipCount: Number(r.tip_count ?? 0) })),
      payoutsDueCents,
      payoutsDueCount,
      payoutsDueOn,
      hasRealMoney: revenueCents > 0,
    });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to load the money overview.");
  }
}

/** Owner/admin read of ONE contractor's payout method (contractor detail
 *  screen) — FULL handle (owner-only surface). null = no method on file. */
export async function getContractorPayoutMethodCore(actor: PayoutActor, contractorId: string): Promise<PayoutResult<OwnerPayoutMethod | null>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  try {
    await ensure();
    const q = await db();
    const rows = await q`
      SELECT p.id, p.org_id, p.contractor_id, u.name AS contractor_name, p.rail, p.handle,
             p.bank_institution_name, p.bank_last4, p.bank_routing_encrypted, p.bank_account_encrypted,
             p.bank_deposit_cents, p.bank_deposit_sent_at, p.status, p.reject_note, p.is_default, p.updated_at
      FROM payout_methods p
      JOIN users u ON u.id = p.contractor_id
      WHERE p.org_id=${actor.orgId} AND p.contractor_id=${contractorId}
      LIMIT 1`;
    if (!rows.length) return ok(null);
    return ok(await toOwnerPayoutMethod(rows[0] as Record<string, unknown>));
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to load the payout method.");
  }
}

/* ============================ BANK MICRO-DEPOSIT ============================ */

/** Owner/admin: record the test deposit the owner sent from their own bank
 *  app (the amount is the verification secret — it is stored on the method
 *  row and NEVER returned to the contractor client; the contractor only sees
 *  "confirm the deposit amount" when bank_deposit_sent_at is set). Only bank
 *  rails in connected_unverified accept this. */
export async function setBankDepositCore(actor: PayoutActor, data: unknown): Promise<PayoutResult<OwnerPayoutMethod | null>> {
  if (!canManage(actor)) return err("unauthorized", "Owner access required.");
  const v = z.object({ methodId: z.string().min(1), amountCents: z.number().int().min(1).max(10000) }).safeParse(data);
  if (!v.success) return err("invalid_input", "Enter the test deposit amount in cents (1–10000).");
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT contractor_id FROM payout_methods
      WHERE org_id=${actor.orgId} AND id=${v.data.methodId} AND rail='bank' AND status='connected_unverified' LIMIT 1`;
    if (!rows.length) return err("invalid_input", "Only an unverified bank payout method can receive a test deposit.");
    await q`UPDATE payout_methods SET bank_deposit_cents=${v.data.amountCents}, bank_deposit_sent_at=NOW(), updated_at=NOW()
      WHERE org_id=${actor.orgId} AND id=${v.data.methodId}`;
    try {
      await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
        SELECT gen_random_uuid()::text, ${actor.orgId}, ${actor.id}, ${actor.role}, 'bank_deposit_sent', 'contractor', ${v.data.methodId},
          jsonb_build_object('methodId', ${v.data.methodId}::text), 'owner-money'`;
    } catch { /* best-effort audit — the AMOUNT is deliberately NOT in audit detail */ }
    return getContractorPayoutMethodCore(actor, String((rows[0] as Record<string, unknown>).contractor_id ?? ""));
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to record the test deposit.");
  }
}

/** Contractor: confirm the micro-deposit amount the owner sent (the amount
 *  the contractor enters must equal bank_deposit_cents — the owner's recorded
 *  test deposit). Match → status 'verified' + audit. The amount is compared
 *  server-side; it never crossed to the client. */
export async function confirmBankDepositCore(user: { orgId: string; id: string; actorUserId: string; actorRole: string }, data: unknown): Promise<PayoutResult<MyPayoutMethod | null>> {
  const v = z.object({ amountCents: z.number().int().min(1).max(10000) }).safeParse(data);
  if (!v.success) return err("invalid_input", "Enter the deposit amount you received.");
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT id, rail, handle, bank_institution_name, bank_last4, status, bank_deposit_cents
      FROM payout_methods WHERE org_id=${user.orgId} AND contractor_id=${user.id} AND rail='bank' LIMIT 1`;
    if (!rows.length) return err("invalid_input", "No bank payout method on file.");
    const m = rows[0] as Record<string, unknown>;
    if (String(m.status) === "verified") return err("invalid_input", "This bank account is already verified.");
    if (m.bank_deposit_cents == null) {
      return err("invalid_input", "The owner hasn't sent the test deposit yet — check back after they confirm.");
    }
    if (Number(m.bank_deposit_cents) !== v.data.amountCents) {
      return err("invalid_input", "That doesn't match the test deposit — check the amount in your bank account and try again.");
    }
    await q`UPDATE payout_methods SET status='verified', reject_note=NULL, updated_at=NOW()
      WHERE org_id=${user.orgId} AND contractor_id=${user.id}`;
    try {
      const rail = String(m.rail ?? "bank") as PayoutRail;
      const masked = maskHandle(rail, m.handle != null ? String(m.handle) : null, m.bank_institution_name != null ? String(m.bank_institution_name) : null, m.bank_last4 != null ? String(m.bank_last4) : null);
      await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
        SELECT gen_random_uuid()::text, ${user.orgId}, ${user.actorUserId}, ${user.actorRole}, 'bank_micro_deposit_confirmed', 'contractor', ${String(m.id)},
          jsonb_build_object('handleMasked', ${masked}::text), 'driver-portal'`;
    } catch { /* best-effort audit */ }
    return getMyPayoutMethodCore({ orgId: user.orgId, id: user.id });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to confirm the test deposit.");
  }
}
