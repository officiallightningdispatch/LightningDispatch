/**
 * Payment engine (owner spec 2026-08-11, backlog #1 first slice) — CLIENT-SAFE
 * FACADE.
 *
 * This module is the ONLY piece of the payment engine imported by client code
 * (the payment tab UI lands in a later delegation). It defines the
 * createServerFn server functions; their handlers dynamic-import the
 * SERVER-ONLY core (./payment-engine-core.ts) so the client bundle never pulls
 * in square-client / club-mail / imapflow / db / auth-server code. No other
 * exports — the core owns all logic (client-graph rule).
 */
import { createServerFn } from "@tanstack/react-start";
import type { ScanClubMailResult, StageClubChargeResult, ListStagedChargesResult, ChargeStagedResult, MirrorTipResult } from "./payment-engine-core";
export type { PaymentTxnRow, ScanClubMailResult, StageClubChargeResult, ListStagedChargesResult, ChargeStagedResult, MirrorTipResult, ScanItem } from "./payment-engine-core";

const passthrough = (x: unknown) => x;

/** Stage a scanned/manual club-charge candidate (owner/admin). Nothing is ever
 *  auto-charged — staging is the review safety rail. */
export const stageClubCharge = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<StageClubChargeResult> => {
  const core = await import("./payment-engine-core");
  return core.stageClubChargeHandler(data);
});

/** Ledger read: staged + charged + failed rows, newest first (owner/admin). */
export const listStagedCharges = createServerFn({ method: "GET" }).handler(async (): Promise<ListStagedChargesResult> => {
  const core = await import("./payment-engine-core");
  return core.listStagedChargesHandler();
});

/** Charge ONE staged club charge via the owner's Square account (owner/admin). */
export const chargeStaged = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<ChargeStagedResult> => {
  const core = await import("./payment-engine-core");
  return core.chargeStagedHandler(data);
});

/** Scan the owner's Gmail for motor-club card-charge notifications and stage
 *  them (owner/admin). dryRun:true parses without writing. */
export const scanClubMail = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<ScanClubMailResult> => {
  const core = await import("./payment-engine-core");
  return core.scanClubMailHandler(data);
});

/** Mirror a paid tip (completion_tips) into the payment ledger (owner/admin).
 *  Called from NEW code paths when a tip is created — the existing
 *  completion-flow tip code is untouched. */
export const mirrorTip = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<MirrorTipResult> => {
  const core = await import("./payment-engine-core");
  return core.mirrorTipHandler(data);
});
