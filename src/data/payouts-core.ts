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
export const PAYOUT_RAIL_LABELS: Record<PayoutRail, string> = {
  cash_app: "Cash App",
  venmo: "Venmo",
  zelle: "Zelle",
  bank: "Bank account",
};
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
});

/** Rail-specific handle validation. Returns a {ok:true} result or a
 *  {ok:false} result carrying the driver-facing validation message. */
export function validatePayoutInput(d: {
  rail: string;
  handle: string | null;
  bankInstitutionName: string | null;
  bankLast4: string | null;
}): PayoutResult<{ rail: PayoutRail; handle: string | null; bankInstitutionName: string | null; bankLast4: string | null }> {
  if (!isRail(d.rail)) return err("invalid_input", "Choose a payout method.");
  if (d.rail === "bank") {
    const inst = (d.bankInstitutionName ?? "").trim();
    const last4 = (d.bankLast4 ?? "").trim();
    if (!inst || inst.length > 40) return err("invalid_input", "Enter the bank name (up to 40 characters).");
    if (!/^\d{4}$/.test(last4)) return err("invalid_input", "Enter the last 4 digits of the account number.");
    return ok({ rail: d.rail, handle: null, bankInstitutionName: inst, bankLast4 });
  }
  const handle = (d.handle ?? "").trim();
  if (!handle) return err("invalid_input", "Enter your handle.");
  if (d.rail === "cash_app") {
    if (!CASHTAG.test(handle)) return err("invalid_input", "Cashtags start with $ and use letters/numbers — e.g. $joe.");
    return ok({ rail: d.rail, handle, bankInstitutionName: null, bankLast4: null });
  }
  if (d.rail === "venmo") {
    if (VENMO_HANDLE.test(handle) || US_PHONE.test(handle)) return ok({ rail: d.rail, handle, bankInstitutionName: null, bankLast4: null });
    return err("invalid_input", "Enter a Venmo handle (@name) or a US phone number.");
  }
  // zelle
  const lower = handle.toLowerCase();
  if (EMAIL.test(lower) || US_PHONE.test(handle)) return ok({ rail: d.rail, handle: EMAIL.test(lower) ? lower : handle, bankInstitutionName: null, bankLast4: null });
  return err("invalid_input", "Enter an email address or a US phone number.");
}

/* ---------------------------------- cores ---------------------------------- */

/** The acting contractor's payout method (masked). null = no method on file. */
export async function getMyPayoutMethodCore(user: { orgId: string; id: string }): Promise<PayoutResult<MyPayoutMethod | null>> {
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT id, rail, handle, bank_institution_name, bank_last4, status, reject_note, is_default, updated_at
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
  const validated = validatePayoutInput(v.data);
  if (!validated.ok) return validated;
  const d = validated.data;
  try {
    await ensure();
    const q = await db();
    const before = await q`SELECT id, rail, handle, status FROM payout_methods
      WHERE org_id=${user.orgId} AND contractor_id=${user.id} LIMIT 1`;
    const existing = before.length ? before[0] as Record<string, unknown> : null;
    const sameValues =
      existing &&
      String(existing.rail) === d.rail &&
      (d.rail === "bank"
        ? String(existing.bank_institution_name ?? "") === d.bankInstitutionName && String(existing.bank_last4 ?? "") === d.bankLast4
        : String(existing.handle ?? "") === d.handle);
    const status: PayoutStatus = sameValues ? (String(existing!.status) as PayoutStatus) : "connected_unverified";
    const methodId = existing ? String(existing.id) : `pm-${Math.random().toString(36).slice(2, 12)}`;
    await q`INSERT INTO payout_methods(id, org_id, contractor_id, rail, handle, bank_institution_name, bank_last4, status, reject_note, is_default, updated_at)
      VALUES(${methodId}, ${user.orgId}, ${user.id}, ${d.rail}, ${d.handle}, ${d.bankInstitutionName}, ${d.bankLast4}, ${status}, NULL, TRUE, NOW())
      ON CONFLICT (org_id, contractor_id) DO UPDATE SET
        rail=EXCLUDED.rail, handle=EXCLUDED.handle,
        bank_institution_name=EXCLUDED.bank_institution_name, bank_last4=EXCLUDED.bank_last4,
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
             p.bank_institution_name, p.bank_last4, p.status, p.reject_note, p.is_default, p.updated_at
      FROM payout_methods p
      JOIN users u ON u.id = p.contractor_id
      WHERE p.org_id=${actor.orgId}
      ORDER BY u.name ASC`;
    return ok((rows as Record<string, unknown>[]).map((r) => {
      const rail = String(r.rail ?? "cash_app") as PayoutRail;
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
        status: String(r.status ?? "connected_unverified") as PayoutStatus,
        rejectNote: r.reject_note != null ? String(r.reject_note) : null,
        isDefault: r.is_default != null ? Boolean(r.is_default) : true,
        updatedAt: r.updated_at != null ? new Date(String(r.updated_at)).toISOString() : new Date(0).toISOString(),
      };
    }));
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to load payout methods.");
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
             p.bank_institution_name, p.bank_last4, p.status, p.reject_note, p.is_default, p.updated_at
      FROM payout_methods p
      JOIN users u ON u.id = p.contractor_id
      WHERE p.org_id=${actor.orgId} AND p.contractor_id=${contractorId}
      LIMIT 1`;
    if (!rows.length) return ok(null);
    const r = rows[0] as Record<string, unknown>;
    const rail = String(r.rail ?? "cash_app") as PayoutRail;
    return ok({
      id: String(r.id),
      orgId: String(r.org_id),
      contractorId: String(r.contractor_id),
      contractorName: String(r.contractor_name ?? ""),
      rail,
      handleFull: r.handle != null ? String(r.handle) : null,
      handleMasked: maskHandle(rail, r.handle != null ? String(r.handle) : null, r.bank_institution_name != null ? String(r.bank_institution_name) : null, r.bank_last4 != null ? String(r.bank_last4) : null),
      bankInstitutionName: r.bank_institution_name != null ? String(r.bank_institution_name) : null,
      bankLast4: r.bank_last4 != null ? String(r.bank_last4) : null,
      status: String(r.status ?? "connected_unverified") as PayoutStatus,
      rejectNote: r.reject_note != null ? String(r.reject_note) : null,
      isDefault: r.is_default != null ? Boolean(r.is_default) : true,
      updatedAt: r.updated_at != null ? new Date(String(r.updated_at)).toISOString() : new Date(0).toISOString(),
    });
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to load the payout method.");
  }
}
