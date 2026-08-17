/**
 * Payment engine (owner spec 2026-08-11, PER-PO CARD rework 2026-08-12) —
 * CLIENT-SAFE FACADE.
 *
 * This module is the ONLY piece of the payment engine imported by client code
 * (the payment tab UI). It defines the createServerFn server functions; their
 * handlers dynamic-import the SERVER-ONLY core (./payment-engine-core.ts) so
 * the client bundle never pulls in square-client / club-mail / imapflow / db /
 * auth-server code. No other exports — the core owns all logic (client-graph
 * rule).
 *
 * PER-PO CARD MODEL: each staged row carries ITS OWN card metadata from its PO
 * email; the owner charges a row by entering that PO's card into Square's
 * secure Web Payments form (nonce → POST /v2/payments) or by charging in their
 * own Square dashboard and marking it paid. There is no per-club card on file.
 */
import { createServerFn } from "@tanstack/react-start";
import type { ScanClubMailResult, StageClubChargeResult, ListStagedChargesResult, ChargeStagedResult, MarkChargedOutsideResult, MirrorTipResult, ListTipsResult, BackfillTipsResult, SquarePublicConfigResult } from "./payment-engine-core";
export type { PaymentTxnRow, ScanClubMailResult, StageClubChargeResult, ListStagedChargesResult, ChargeStagedResult, MarkChargedOutsideResult, MirrorTipResult, TipLedgerRow, ListTipsResult, BackfillTipsResult, SquarePublicConfigResult, ScanItem } from "./payment-engine-core";

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

/** Charge ONE staged club charge via the owner's Square account (owner/admin).
 *  Requires the Web Payments NONCE collected from the owner entering the card
 *  shown in the PO email (per-PO card model — there is no per-club card on
 *  file). Exactly one idempotent POST /v2/payments. */
export const chargeStaged = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<ChargeStagedResult> => {
  const core = await import("./payment-engine-core");
  return core.chargeStagedHandler(data);
});

/** Record that the owner already charged this row in their own Square
 *  dashboard (owner/admin) — "Mark charged (paid outside)". Sets
 *  status='charged', charge_path='outside'. */
export const markChargedOutside = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<MarkChargedOutsideResult> => {
  const core = await import("./payment-engine-core");
  return core.markChargedOutsideHandler(data);
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

/** Tips ledger read with driver attribution (owner/admin). */
export const listTips = createServerFn({ method: "GET" }).handler(async (): Promise<ListTipsResult> => {
  const core = await import("./payment-engine-core");
  return core.listTipsHandler();
});

/** Additive repair: create missing tip mirrors without touching payouts/cash-outs. */
export const backfillTipMirrors = createServerFn({ method: "POST" }).handler(async (): Promise<BackfillTipsResult> => {
  const core = await import("./payment-engine-core");
  const actor = await core.resolveManageActorForBackfill();
  return actor ? core.backfillTipMirrorsCore(actor) : { ok: false, code: "unauthorized", message: "Sign in as the owner or an admin first." };
});

/** PUBLIC Square Web Payments config (application id + location id only) for
 *  the payment tab's card form — owner/admin gated. */
export const getPaymentSquareConfig = createServerFn({ method: "GET" }).handler(async (): Promise<SquarePublicConfigResult> => {
  const core = await import("./payment-engine-core");
  return core.getPaymentSquareConfigHandler();
});
