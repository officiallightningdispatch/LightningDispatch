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
import type { MyPayoutMethod, OwnerPayoutMethod, PayoutRail, PayoutResult, PayoutStatus } from "./payouts-core";
export type { MyPayoutMethod, OwnerPayoutMethod, PayoutRail, PayoutStatus } from "./payouts-core";
export { PAYOUT_RAIL_LABELS } from "./payouts-core";

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
export const removeMyPayoutMethod = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<PayoutResult<{ removed: boolean }>> => {
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
