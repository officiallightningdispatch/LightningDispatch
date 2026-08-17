/**
 * Payout methods — CLIENT-SAFE FACADE (driver-portal feature batch 8,
 * owner-directed 2026-08-12). This module is the ONLY piece of the payout
 * feature imported by client code (driver payout screen, profile row, owner
 * contractor detail). It defines the createServerFn server functions; their
 * handlers dynamic-import the SERVER-ONLY core (./payouts-core.ts) so the
 * client bundle never pulls in db/auth-server code. No other exports — the
 * core owns all logic (see the client-graph rule that has broken the build
 * before).
 */
import { createServerFn } from "@tanstack/react-start";
import type { MyPayoutMethod, OwnerPayoutMethod, PayPeriodDetail, PayPeriodList, PayoutResult, PayoutRail, MoneyOverview } from "./payouts-core";
export type { MyPayoutMethod, OwnerPayoutMethod, PayPeriodDetail, PayPeriodList, PayoutRecord, PayoutRail, PayoutStatus, MoneyOverview, PayPeriod } from "./payouts-core";

/** UI labels for the payout rails — kept HERE (client-safe facade), never
 *  re-exported from the server-only core: a value re-export of the core pulls
 *  its exported *Core functions (which dynamic-import auth-server/db) into the
 *  client bundle (client-graph rule — broke the build once already). */
export const PAYOUT_RAIL_LABELS: Record<PayoutRail, string> = {
  cash_app: "Cash App",
  venmo: "Venmo",
  zelle: "Zelle",
  bank: "Bank account",
};

/** Format a pay-period boundary as a calendar date in Eastern Time, regardless
 * of the viewer's local timezone. Invalid instants are shown as an ellipsis. */
export function fmtEtShortDate(isoStr: string): string {
  const d = new Date(isoStr);
  return Number.isNaN(d.getTime()) ? "…" : new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", month: "short", day: "numeric",
  }).format(d);
}

const passthrough = (x: unknown) => x;

/** The acting contractor's payout method (masked). null = no method on file. */
export const getMyPayoutMethod = createServerFn({ method: "GET" }).handler(async (): Promise<PayoutResult<MyPayoutMethod | null>> => {
  const core = await import("./payouts-core");
  const { currentUser, effectiveDriverIdentity } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, code: "unauthorized", message: "Sign in as a driver first." };
  const identity = await effectiveDriverIdentity(u);
  if (!identity || identity.deactivated) return { ok: false as const, code: "unauthorized", message: "Sign in as a driver first." };
  return core.getMyPayoutMethodCore({ orgId: u.orgId, id: identity.userRowId });
});

/** Save (upsert) the contractor's payout method — driver-facing, session-
 *  scoped to the EFFECTIVE driver (owner in driver view included). */
export const setMyPayoutMethod = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<PayoutResult<MyPayoutMethod>> => {
  const core = await import("./payouts-core");
  const { currentUser, effectiveDriverIdentity } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, code: "unauthorized", message: "Sign in as a driver first." };
  const identity = await effectiveDriverIdentity(u);
  if (!identity || identity.deactivated) return { ok: false as const, code: "unauthorized", message: "Sign in as a driver first." };
  return core.setMyPayoutMethodCore(
    { orgId: u.orgId, id: identity.userRowId, actorUserId: u.id, actorRole: u.role },
    data,
  );
});

/** Remove the contractor's payout method (row deleted = NOT_SET). */
export const removeMyPayoutMethod = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data: _data }): Promise<PayoutResult<{ removed: boolean }>> => {
  const core = await import("./payouts-core");
  const { currentUser, effectiveDriverIdentity } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, code: "unauthorized", message: "Sign in as a driver first." };
  const identity = await effectiveDriverIdentity(u);
  if (!identity || identity.deactivated) return { ok: false as const, code: "unauthorized", message: "Sign in as a driver first." };
  return core.removeMyPayoutMethodCore({ orgId: u.orgId, id: identity.userRowId, actorUserId: u.id, actorRole: u.role });
});

/** Owner/admin read of every contractor's payout method — FULL handles. */
export const listPayoutMethods = createServerFn({ method: "GET" }).handler(async (): Promise<PayoutResult<OwnerPayoutMethod[]>> => {
  const core = await import("./payouts-core");
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, code: "unauthorized", message: "Sign in first." };
  return core.listPayoutMethodsCore({ orgId: u.orgId, id: u.id, role: u.role });
});

/** Owner/admin read of ONE contractor's payout method — FULL handle. */
export const getContractorPayoutMethod = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<PayoutResult<OwnerPayoutMethod | null>> => {
  const core = await import("./payouts-core");
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, code: "unauthorized", message: "Sign in first." };
  const v = data as { contractorId?: unknown };
  const contractorId = typeof v?.contractorId === "string" ? v.contractorId : "";
  return core.getContractorPayoutMethodCore({ orgId: u.orgId, id: u.id, role: u.role }, contractorId);
});

/* ------------------------------ PAYDAY (owner) ------------------------------ */

/** Owner/admin: pay periods (newest first) + the default (just-closed) id. */
export const listPayPeriods = createServerFn({ method: "GET" }).handler(async (): Promise<PayoutResult<PayPeriodList>> => {
  const core = await import("./payouts-core");
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, code: "unauthorized", message: "Sign in first." };
  return core.listPayPeriodsCore({ orgId: u.orgId, id: u.id, role: u.role });
});

/** Owner/admin: one period's manifest (records + grouped totals). */
export const getPayPeriodDetail = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<PayoutResult<PayPeriodDetail | null>> => {
  const core = await import("./payouts-core");
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, code: "unauthorized", message: "Sign in first." };
  const v = data as { periodId?: unknown };
  const periodId = typeof v?.periodId === "string" ? v.periodId : "";
  return core.getPayPeriodDetailCore({ orgId: u.orgId, id: u.id, role: u.role }, periodId);
});

/** Owner/admin: compute (or recompute) a closed period's payday. Idempotent —
 *  recompute replaces the period's non-paid records; paid rows never change. */
export const computePayday = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<PayoutResult<PayPeriodDetail | null>> => {
  const core = await import("./payouts-core");
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, code: "unauthorized", message: "Sign in first." };
  const v = data as { periodId?: unknown };
  const periodId = typeof v?.periodId === "string" ? v.periodId : "";
  return core.computePaydayCore({ orgId: u.orgId, id: u.id, role: u.role }, periodId);
});

/** Owner/admin: mark ONE payout record paid (owner confirmed the send in
 *  their own app). The period flips to paid when no computed rows remain. */
export const markPayoutPaid = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<PayoutResult<PayPeriodDetail | null>> => {
  const core = await import("./payouts-core");
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, code: "unauthorized", message: "Sign in first." };
  return core.markPayoutPaidCore({ orgId: u.orgId, id: u.id, role: u.role }, data);
});

/** Owner/admin: mark the WHOLE period paid (all computed rows at once). */
export const markPaydayPeriodPaid = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<PayoutResult<PayPeriodDetail | null>> => {
  const core = await import("./payouts-core");
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, code: "unauthorized", message: "Sign in first." };
  const v = data as { periodId?: unknown };
  const periodId = typeof v?.periodId === "string" ? v.periodId : "";
  return core.markPaydayPeriodPaidCore({ orgId: u.orgId, id: u.id, role: u.role }, periodId);
});

/** Owner/admin: verify a contractor's payout method (owner-confirmed — the
 *  owner sends a test payment from their own app before tapping Verify). */
export const verifyPayoutMethod = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<PayoutResult<OwnerPayoutMethod | null>> => {
  const core = await import("./payouts-core");
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, code: "unauthorized", message: "Sign in first." };
  const v = data as { methodId?: unknown };
  const methodId = typeof v?.methodId === "string" ? v.methodId : "";
  return core.verifyPayoutMethodCore({ orgId: u.orgId, id: u.id, role: u.role }, methodId);
});

/** Owner/admin: reject a contractor's payout method with a note (shown to the
 *  contractor; re-save resets to connected_unverified). */
export const rejectPayoutMethod = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<PayoutResult<OwnerPayoutMethod | null>> => {
  const core = await import("./payouts-core");
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, code: "unauthorized", message: "Sign in first." };
  return core.rejectPayoutMethodCore({ orgId: u.orgId, id: u.id, role: u.role }, data);
});

/** Owner/admin: EDIT a contractor's payout method (owner-directed 2026-08-13 —
 *  the owner corrects a typo'd handle before approving). Any change re-triggers
 *  verification (status → connected_unverified); same values are idempotent. */
export const editPayoutMethod = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<PayoutResult<OwnerPayoutMethod | null>> => {
  const core = await import("./payouts-core");
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, code: "unauthorized", message: "Sign in first." };
  return core.editPayoutMethodCore({ orgId: u.orgId, id: u.id, role: u.role }, data);
});

/** Contractor: confirm the micro-deposit amount the owner sent (bank rail
 *  verification). Match → the bank method becomes verified. The amount is
 *  compared server-side — it never crossed to the contractor client. */
export const confirmBankDeposit = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<PayoutResult<MyPayoutMethod | null>> => {
  const core = await import("./payouts-core");
  const { currentUser, effectiveDriverIdentity } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, code: "unauthorized", message: "Sign in as a driver first." };
  const identity = await effectiveDriverIdentity(u);
  if (!identity || identity.deactivated) return { ok: false as const, code: "unauthorized", message: "Sign in as a driver first." };
  return core.confirmBankDepositCore({ orgId: u.orgId, id: identity.userRowId, actorUserId: u.id, actorRole: u.role }, data);
});

/** Owner/admin: record the test deposit the owner sent from their own bank
 *  app (bank rail micro-deposit verification). Only unverified bank methods. */
export const setBankDeposit = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<PayoutResult<OwnerPayoutMethod | null>> => {
  const core = await import("./payouts-core");
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, code: "unauthorized", message: "Sign in first." };
  return core.setBankDepositCore({ orgId: u.orgId, id: u.id, role: u.role }, data);
});

/** Owner/admin: the three Money-tab cards (Revenue / Tips / Payouts). */
export const getMoneyOverview = createServerFn({ method: "GET" }).handler(async (): Promise<PayoutResult<MoneyOverview>> => {
  const core = await import("./payouts-core");
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, code: "unauthorized", message: "Sign in first." };
  return core.getMoneyOverviewCore({ orgId: u.orgId, id: u.id, role: u.role });
});

/** Period label helper (client-safe, pure): "Oct 6 – Oct 12 · pays Wed Oct 15".
 *  The open period renders "Open period — pays Wed Oct 15". */
export function payPeriodLabel(startsAtIso: string, endsAtIso: string, payoutDueOn: string, isCurrent: boolean): string {
  const fmt = fmtEtShortDate;
  const due = payoutDueOn ? new Date(`${payoutDueOn}T00:00:00`) : null;
  const dueLabel = due && !Number.isNaN(due.getTime()) ? due.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) : "";
  if (isCurrent) return `Open period — pays ${dueLabel}`;
  return `${fmt(startsAtIso)} – ${fmt(endsAtIso)} · pays ${dueLabel}`;
}
