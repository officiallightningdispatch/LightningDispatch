/**
 * "Square as source of truth" READ-BACK — CLIENT-SAFE FACADE.
 *
 * This module is the ONLY piece of the Square read-back feature imported by
 * client code (the money page arrives in the NEXT slice). It defines the
 * createServerFn server functions; their handlers dynamic-import the
 * SERVER-ONLY core (./square-readback-core.ts) so the client bundle never
 * pulls in db / auth-server / square-client / node:crypto code. No other
 * exports — the core owns all logic (client-graph rule).
 */
import { createServerFn } from "@tanstack/react-start";
import type {
  SquareListPaymentsResult,
  ReconcileResult,
} from "./square-readback-core";
export type {
  SquarePaymentSummary,
  SquareOrderSummary,
  SquareListPaymentsResult,
  SquareGetPaymentResult,
  SquareSearchOrdersResult,
  ReconcileRow,
  ReconcileSummary,
  ReconcileVerdict,
  ReconcileResult,
} from "./square-readback-core";
/** Owner/admin-only: paginated ListPayments read-back. */
export const listSquarePayments = createServerFn({ method: "GET" })
  .handler(async (): Promise<SquareListPaymentsResult> => {
    const core = await import("./square-readback-core");
    return core.listSquarePaymentsHandler();
  });
/** Owner/admin-only: reconcile locally-settled tips / tire plugs / battery
 *  sales against Square's own payment records (read-only). */
export const reconcileSquarePayments = createServerFn({ method: "POST" })
  .handler(async (): Promise<ReconcileResult> => {
    const core = await import("./square-readback-core");
    return core.reconcileSquarePaymentsHandler();
  });
