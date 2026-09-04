/**
 * "Square as source of truth" READ-BACK — CLIENT-SAFE FACADE.
 *
 * This module is the ONLY piece of the Square read-back feature imported by
 * client code (the owner money page). It defines the createServerFn server
 * functions; their handlers dynamic-import the SERVER-ONLY core
 * (./square-readback-core.ts) so the client bundle never pulls in db /
 * auth-server / square-client / node:crypto code. It also owns the pure
 * UI-facing presentation constants/helpers (labels + badge styling + failure
 * copy) — kept HERE rather than in the core so the client bundle stays clean
 * (client-graph rule).
 */
import { createServerFn } from "@tanstack/react-start";
import type {
  SquareListPaymentsResult,
  ReconcileResult,
  ReconcileKind,
  ReconcileVerdict,
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

/* ------------------------- UI-facing presentation data -------------------------
 * Kept HERE (client-safe facade) and NEVER re-exported from the server-only core:
 * a value re-export of the core would pull its *Core functions (which
 * dynamic-import db/auth-server/square-client) into the client bundle — the
 * client-graph rule that has broken the build before. These are pure constants /
 * pure functions with no imports, so they are safe for both client render and
 * server-side hermetic tests. */

/** Human labels for the three locally-settled kinds under reconciliation. */
export const RECONCILE_KIND_LABELS: Record<ReconcileKind, string> = {
  tip: "Tip",
  tire_plug: "Tire plug",
  battery: "Battery",
};

/** Verdict badge presentation: `cls` is the StatusBadge className, `dot` controls
 *  the leading dot. `ok` is green; problem verdicts are distinct and non-green so
 *  the owner can scan the table at a glance. */
export const RECONCILE_VERDICT_BADGE: Record<ReconcileVerdict, { cls: string; label: string; dot: boolean }> = {
  ok: { cls: "bg-success-100 text-success-700", label: "Confirmed", dot: false },
  square_refunded: { cls: "bg-accent-100 text-accent-700", label: "Refunded", dot: true },
  square_failed: { cls: "bg-danger-100 text-danger-700", label: "Failed", dot: true },
  square_missing: { cls: "bg-accent-100 text-accent-700", label: "Missing", dot: true },
  square_amount_mismatch: { cls: "bg-danger-100 text-danger-700", label: "Amount mismatch", dot: true },
  square_read_error: { cls: "bg-ink-100 text-ink-500", label: "Read error", dot: true },
};

/** Map a reconcile FAILURE code (the non-`ok` ReconcileResult shape) to a
 *  clear, owner-facing notice. Fail-visible, never a fake success. */
export function reconcileFailureMessage(code: string, message: string): string {
  switch (code) {
    case "square_not_configured":
      return "Square is not configured — add SQUARE_ACCESS_TOKEN / SQUARE_LOCATION_ID (and SQUARE_APPLICATION_ID for card entry) before running reconciliation.";
    case "unauthorized":
      return "Owner or admin access is required to run Square reconciliation.";
    case "database_error":
      return message || "Square reconciliation requires database mode.";
    default:
      return message || "Square reconciliation failed.";
  }
}
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
