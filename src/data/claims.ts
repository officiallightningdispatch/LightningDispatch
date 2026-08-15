/**
 * Damage-claims agent — CLIENT-SAFE FACADE (owner-directed 2026-08-12).
 *
 * The ONLY piece of the claims feature imported by client code (owner portal /
 * driver app). Handlers dynamic-import the SERVER-ONLY core (./claims-core.ts)
 * so the client bundle never pulls in smtp-client / club-mail / b2-client /
 * auth-server code (client-graph rule).
 */
import { createServerFn } from "@tanstack/react-start";
import type { ClaimResult, ClaimRow, ScanClaimsResult } from "./claims-core";
export type { ClaimResult, ClaimRow, ClaimStatus } from "./claims-core";
const passthrough = (x: unknown) => x;

/** Owner/admin: run the read-only Gmail scan → detect → upsert claim records. */
export const scanClaims = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(async ({ data }): Promise<ClaimResult<ScanClaimsResult>> => {
    const core = await import("./claims-core");
    return core.scanClaimsHandler(data, {});
  });

/** Owner/admin: research a claim (thread + app facts, resolved detection). */
export const researchClaim = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(async ({ data }) => {
    const core = await import("./claims-core");
    return core.researchClaimHandler(data);
  });

/** Owner/admin: prepare the claim form (researched → form_ready). */
export const prepareClaimForm = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(async ({ data }) => {
    const core = await import("./claims-core");
    return core.prepareClaimFormHandler(data);
  });

/** Assigned driver: sign the prepared form (canvas → B2 → pending_approval). */
export const signClaim = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(async ({ data }) => {
    const core = await import("./claims-core");
    return core.signClaimHandler(data, {});
  });

/** Owner/admin: APPROVE (the gate — nothing sends here). */
export const approveClaim = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(async ({ data }) => {
    const core = await import("./claims-core");
    return core.approveClaimHandler(data);
  });

/** Owner/admin: reject/close a claim (nothing sends). */
export const rejectClaim = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(async ({ data }) => {
    const core = await import("./claims-core");
    return core.rejectClaimHandler(data);
  });

/** Owner/admin: assign a driver to a claim without a linked job. */
export const assignClaimDriver = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(async ({ data }) => {
    const core = await import("./claims-core");
    return core.assignClaimDriverHandler(data);
  });

/** Owner/admin: the ONE audited send — refused without approval. */
export const sendClaim = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(async ({ data }) => {
    const core = await import("./claims-core");
    return core.sendClaimHandler(data, {});
  });

/** Owner/admin: all claims for the org. */
export const listClaims = createServerFn({ method: "GET" }).handler(async (): Promise<ClaimResult<ClaimRow[]>> => {
  const core = await import("./claims-core");
  return core.listClaimsHandler();
});

/** Assigned driver: urgent sign-requests feed (form_ready / pending_approval). */
export const listMyClaimSignRequests = createServerFn({ method: "GET" }).handler(async (): Promise<ClaimResult<ClaimRow[]>> => {
  const core = await import("./claims-core");
  return core.listMyClaimSignRequestsHandler();
});

/** Signed-form preview (owner + assigned driver). */
export const getClaimSignatureFile = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(async ({ data }) => {
    const core = await import("./claims-core");
    return core.getClaimSignatureFileHandler(data, {});
  });
