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
  methodId: string | null; // payout_methods row snapshot (owner verify/reject)
  rail: PayoutRail | null; // NULL when no method row at all (blocked)
  handleFull: string | null; // OWNER-ONLY (PII)
  handleMasked: string;
  jobCount: number;
  payrateCents: number | null; // snapshot at compute; NULL = rate not set
  grossCents: number;
  tipsCents: number;
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
    busyBonusCents: number;
    totalCents: number;
    contractorCount: number;
    jobCount: number;
    dueCount: number; // status 'computed'
    paidCount: number;
    blockedCount: number;
    rails: { rail: PayoutRail; count: number; totalCents: number }[];
  };
};
export type PayPeriodList = {
  periods: PayPeriod[]; // newest first
  currentPeriodId: string;
  defaultPeriodId: string; // the just-closed period (manifest default)
};
export type MoneyOverview = {
  revenueCents: number;
  revenueChargedCount: number;
  revenueStagedCount: number;
  tipsCents: number;
  tipsCount: number;
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
/** Monday 00:00 ET → Sunday 23:59:59.999 ET containing `now`, plus the
 *  Wednesday-after payout date (ET calendar). Pure — hermetic-test friendly. */
export function periodBoundariesFor(now: Date): PeriodBoundaries {
  const p = etDateParts(now);
  const dowUtc = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  const weekDay = (dowUtc + 6) % 7; // Monday = 0
  const monday = etMidnight(p.year, p.month, p.day - weekDay);
  const nextMonday = etMidnight(p.year, p.month, p.day - weekDay + 7);
  const endsAt = new Date(nextMonday.getTime() - 1);
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
  const id = `pay-${orgId}-${iso(b.startsAt).slice(0, 10)}`;
  await q`INSERT INTO pay_periods(id, org_id, starts_at, ends_at, payout_due_on)
    VALUES(${id}, ${orgId}, ${iso(b.startsAt)}, ${iso(b.endsAt)}, ${b.payoutDueOn})
    ON CONFLICT (org_id, starts_at, ends_at) DO NOTHING`;
  const rows = await q`SELECT * FROM pay_periods WHERE org_id=${orgId} AND starts_at=${iso(b.startsAt)} AND ends_at=${iso(b.endsAt)} LIMIT 1`;
  return (rows[0] ?? {}) as Record<string, unknown>;
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
      payrateCents: r.payrate_cents != null ? Number(r.payrate_cents) : null,
      grossCents: r.gross_cents != null ? Number(r.gross_cents) : 0,
      tipsCents: r.tips_cents != null ? Number(r.tips_cents) : 0,
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
    const railsMap = new Map<PayoutRail, { count: number; totalCents: number }>();
    for (const rec of rows) {
      if (rec.status !== "computed" || !rec.rail) continue;
      const g = railsMap.get(rec.rail) ?? { count: 0, totalCents: 0 };
      g.count += 1;
      g.totalCents += rec.totalCents;
      railsMap.set(rec.rail, g);
    }
    const totals = {
      grossCents: rows.reduce((s, r) => s + r.grossCents, 0),
      tipsCents: rows.reduce((s, r) => s + r.tipsCents, 0),
      busyBonusCents: rows.reduce((s, r) => s + r.busyBonusCents, 0),
      totalCents: rows.reduce((s, r) => s + r.totalCents, 0),
      contractorCount: rows.length,
      jobCount: rows.reduce((s, r) => s + r.jobCount, 0),
      dueCount: rows.filter((r) => r.status === "computed").length,
      paidCount: rows.filter((r) => r.status === "paid").length,
      blockedCount: rows.filter((r) => r.status === "blocked").length,
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

    const jobRows = await q`
      SELECT dj.assigned_driver_towbook_id AS tb_id, COUNT(*)::int AS job_count
      FROM dispatch_jobs dj
      WHERE dj.org_id=${actor.orgId} AND dj.status='completed'
        AND dj.completed_at >= ${iso(startsAt)} AND dj.completed_at < ${iso(endsAt)}
        AND dj.assigned_driver_towbook_id IS NOT NULL
      GROUP BY dj.assigned_driver_towbook_id`;
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
        dj.assigned_at, dj.completed_at, dj.created_at, dj.raw_json
      FROM dispatch_jobs dj
      WHERE dj.org_id=${actor.orgId} AND dj.assigned_driver_towbook_id IS NOT NULL`;
    const assignByTb = new Map<string, Array<number | null>>();
    const completeByTb = new Map<string, Array<number | null>>();
    for (const r of busyJobRows as Record<string, unknown>[]) {
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

    // contractor → { jobCount, payrateCents, tipsCents } keyed by user id
    const earnByUser = new Map<string, { jobCount: number; payrateCents: number | null; tipsCents: number }>();
    for (const r of jobRows as Record<string, unknown>[]) {
      const tb = String(r.tb_id);
      const u = userByTb.get(tb);
      if (!u) continue; // no LD user for this Towbook driver → cannot attribute pay
      const e = earnByUser.get(u.userId) ?? { jobCount: 0, payrateCents: u.payrateCents, tipsCents: 0 };
      e.jobCount += Number(r.job_count ?? 0);
      earnByUser.set(u.userId, e);
    }
    for (const [uid, cents] of tipCentsByUser) {
      if (!earnByUser.has(uid)) {
        const u = userByTb.get([...userByTb.entries()].find(([, v]) => v.userId === uid)?.[0] ?? "");
        earnByUser.set(uid, { jobCount: 0, payrateCents: u?.payrateCents ?? null, tipsCents: cents });
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
      const grossCents = e.payrateCents != null ? e.payrateCents * e.jobCount : 0;
      const tipsCents = e.tipsCents;
      const busy = busyByUser.get(uid) ?? { bonusCents: 0, bonusJobs: 0, hours: null as { startsAtIso: string; completedJobs: number }[] | null };
      const busyHoursJson = busy.hours && busy.hours.length ? busy.hours : null;
      const totalCents = grossCents + tipsCents + busy.bonusCents;
      const recordId = `pr-${periodId}-${uid}`;
      const inserted = await q`INSERT INTO payout_records(id, org_id, period_id, contractor_id, method_id, rail, handle_full, handle_masked,
          job_count, payrate_cents, gross_cents, tips_cents, busy_bonus_cents, busy_bonus_jobs, busy_bonus_hours, total_cents, method_status, status, updated_at)
        VALUES(${recordId}, ${actor.orgId}, ${periodId}, ${uid}, ${method ? String(method.id) : null}, ${rail}, ${handleFull}, ${handleMasked},
          ${e.jobCount}, ${e.payrateCents}, ${grossCents}, ${tipsCents}, ${busy.bonusCents}, ${busy.bonusJobs}, ${busyHoursJson ? JSON.stringify(busyHoursJson) : null}, ${totalCents}, ${methodStatus}, ${verified ? "computed" : "blocked"}, NOW())
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
        payrateCents: e.payrateCents,
        grossCents,
        tipsCents,
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

    const detail = await getPayPeriodDetailCore(actor, periodId);
    return detail.ok && detail.data ? detail : ok(await buildDetailFallback(actor, periodId, records));
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
    totalCents: records.reduce((s, r) => s + r.totalCents, 0),
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
