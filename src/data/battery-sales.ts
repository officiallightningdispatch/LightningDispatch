/**
 * AI Battery Sales Agent (owner-directed 2026-08-13, Phase 1) — CLIENT-SAFE
 * FACADE.
 *
 * This module is the ONLY piece of the battery-sales feature imported by client
 * code (the driver agent UI + the owner Money tab + owner Settings). It defines
 * the createServerFn server functions; their handlers dynamic-import the
 * SERVER-ONLY core (./battery-sales-core.ts) so the client bundle never pulls
 * in square-client / db / auth-server code. No other exports — the core owns
 * all logic (client-graph rule).
 */
import { createServerFn } from "@tanstack/react-start";
import type { BatteryAgentState, BatteryRates, BatterySaleOwnerRow, BatteryStepResult, BatteryChargeResult } from "./battery-sales-core";
export type { BatteryAgentState, BatteryRates, BatterySaleOwnerRow, BatterySaleRow, BatteryQuote, BatteryInstallTypeRow } from "./battery-sales-core";

const passthrough = (x: unknown) => x;

/** Read the agent's current state for one job (assigned driver only). */
export const getBatteryAgentState = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<{ ok: true; state: BatteryAgentState } | { ok: false; code: "not_found" | "unauthorized"; message: string }> => {
  const core = await import("./battery-sales-core");
  return core.batteryAgentStateHandler(data);
});

/** Record the REQUIRED battery test result (ok / faulty) on a jumpstart job. */
export const recordBatteryTest = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<BatteryStepResult> => {
  const core = await import("./battery-sales-core");
  return core.recordBatteryTestHandler(data);
});

/** ONE agent step (vin / vehicle_manual / price / install / approve / decline) —
 *  server-validated against the derived machine state. */
export const batteryAgentStep = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<BatteryStepResult> => {
  const core = await import("./battery-sales-core");
  return core.batteryAgentStepHandler(data);
});

/** Charge the customer's card (Web Payments NONCE — customer-present hand-off)
 *  on the OWNER's Square account; flips the sale to paid + creates the install
 *  job. Exactly one idempotent POST /v2/payments per attempt. */
export const chargeBatterySale = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<BatteryChargeResult> => {
  const core = await import("./battery-sales-core");
  return core.chargeBatterySaleHandler(data);
});

/** Owner/admin: every battery sale for the org (read-only list). */
export const listBatterySales = createServerFn({ method: "GET" }).handler(async (): Promise<BatterySaleOwnerRow[]> => {
  const core = await import("./battery-sales-core");
  return core.listBatterySalesHandler();
});

/** Read the org's battery rates (any signed-in user — the driver agent needs
 *  them to render the quote; the owner Settings tab to edit). */
export const getBatteryRates = createServerFn({ method: "GET" }).handler(async (): Promise<{ ok: true; rates: BatteryRates } | { ok: false; code: "unauthorized" | "invalid_state"; message: string }> => {
  const core = await import("./battery-sales-core");
  return core.getBatteryRatesHandler();
});

/** Owner/admin: update the battery sale rates (tax, admin fee, install fees,
 *  warehouse address). */
export const updateBatteryRates = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<{ ok: true; rates: BatteryRates } | { ok: false; code: "unauthorized" | "invalid_state"; message: string }> => {
  const core = await import("./battery-sales-core");
  return core.updateBatteryRatesHandler(data);
});

export const listBatteryInstallTypes = createServerFn({ method: "GET" }).handler(async () => { const core = await import("./battery-sales-core"); return core.listBatteryInstallTypesHandler(); });
