/**
 * Job completion-time goals + live counter + owner goal-editing — CLIENT-SAFE
 * FACADE (owner-directed 2026-08-13, completion-goals-spec.md).
 *
 * CLIENT-GRAPH RULE (tanstack-client-graph-leak): this module is imported by
 * client routes (driver active trip sheet, owner Settings, owner metrics), so
 * every server-only dependency (service-time-core) is loaded via dynamic
 * import INSIDE the createServerFn handler bodies — never statically. Type-only
 * imports of core types are erased at compile time and are safe.
 */
import { createServerFn } from "@tanstack/react-start";
import type { AssignOnTimeResult, ServiceTimeGoalsResult } from "./service-time-core";
export type { ServiceTimeGoalRow } from "./service-time-core";
const passthrough = (x: unknown) => x;
/** Any signed-in user: the org's service-time goals (driver counter needs them
 *  for the live timer; the owner Settings card to edit). */
export const getServiceTimeGoals = createServerFn({ method: "GET" }).handler(async (): Promise<ServiceTimeGoalsResult> => {
  const core = await import("./service-time-core");
  return core.getServiceTimeGoalsHandler();
});
/** Owner/admin: update the goal table (owner Settings — Service time goals
 *  card). Changes apply to future jobs; recorded durations are untouched. */
export const updateServiceTimeGoals = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<ServiceTimeGoalsResult> => {
  const core = await import("./service-time-core");
  return core.updateServiceTimeGoalsHandler(data);
});
/** Owner/admin: manually assign the On-Time Service Standards course to a
 *  contractor (owner metrics detail → Assign course). */
export const assignOnTimeStandards = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<AssignOnTimeResult> => {
  const core = await import("./service-time-core");
  return core.assignOnTimeStandardsHandler((data as { driverUserId?: string } | undefined)?.driverUserId);
});
