/**
 * Immediate tip cash-out — CLIENT-SAFE FACADE (owner-directed 2026-08-12).
 * This module is the ONLY piece of the tip cash-out feature imported by client
 * code (driver earnings card, post-completion CTA, owner Money tab). It
 * defines the createServerFn server functions; their handlers dynamic-import
 * the SERVER-ONLY core (./tip-cashout-core.ts) so the client bundle never
 * pulls in db/auth-server code. No other exports — the core owns all logic
 * (see the client-graph rule that has broken the build before).
 */
import { createServerFn } from "@tanstack/react-start";
import type { TipCashoutRequest, TipCashoutList, DriverTipCashoutState, TipCashoutResult } from "./tip-cashout-core";
export type { DriverTipCashoutState, TipCashoutRequest, TipCashoutList } from "./tip-cashout-core";

const passthrough = (x: unknown) => x;

/** Driver: current cash-out state (available tips, method, open request) —
 *  never the full handle or a bank account number. */
export const getMyTipCashoutState = createServerFn({ method: "GET" }).handler(async (): Promise<TipCashoutResult<DriverTipCashoutState>> => {
  const core = await import("./tip-cashout-core");
  const { currentUser, effectiveDriverIdentity } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, code: "unauthorized", message: "Sign in as a driver first." };
  const identity = await effectiveDriverIdentity(u);
  if (!identity || identity.deactivated) return { ok: false as const, code: "unauthorized", message: "Sign in as a driver first." };
  return core.getMyTipCashoutStateCore({ orgId: u.orgId, id: identity.userRowId });
});

/** Driver: ONE TAP — request a cash-out of the FULL available tips balance.
 *  Server-computed amount; verified rail required; one open request per
 *  contractor (double-submit backstop). */
export const submitTipCashout = createServerFn({ method: "POST" }).handler(async (): Promise<TipCashoutResult<TipCashoutRequest>> => {
  const core = await import("./tip-cashout-core");
  const { currentUser, effectiveDriverIdentity } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, code: "unauthorized", message: "Sign in as a driver first." };
  const identity = await effectiveDriverIdentity(u);
  if (!identity || identity.deactivated) return { ok: false as const, code: "unauthorized", message: "Sign in as a driver first." };
  return core.submitTipCashoutCore({ orgId: u.orgId, id: identity.userRowId, actorUserId: u.id, actorRole: u.role });
});

/** Owner/admin: the Money-tab list of tip cash-out requests — open first,
 *  then recently paid. Masked handles only. */
export const listTipCashoutRequests = createServerFn({ method: "GET" }).handler(async (): Promise<TipCashoutResult<TipCashoutList>> => {
  const core = await import("./tip-cashout-core");
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, code: "unauthorized", message: "Sign in first." };
  return core.listTipCashoutRequestsCore({ orgId: u.orgId, id: u.id, role: u.role });
});

/** Owner/admin: mark a cash-out request PAID (owner already sent from their
 *  own app). Idempotent — a paid request refuses a second mark. */
export const markTipCashoutPaid = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<TipCashoutResult<TipCashoutRequest>> => {
  const core = await import("./tip-cashout-core");
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, code: "unauthorized", message: "Sign in first." };
  return core.markTipCashoutPaidCore({ orgId: u.orgId, id: u.id, role: u.role }, data);
});
