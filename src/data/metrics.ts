/**
 * Metrics tab + Lightning Dispatch Academy — client-safe facade
 * (owner-directed 2026-08-12, metrics-academy-spec.md §6.2).
 *
 * CLIENT-GRAPH RULE (tanstack-client-graph-leak): this module is imported by
 * client routes, so every server-only dependency (metrics-core) is loaded via
 * dynamic import INSIDE the createServerFn handler bodies — never statically.
 * Type-only imports of core types are erased at compile time and are safe.
 */
import { createServerFn } from "@tanstack/react-start";
import type {
  AcademyRecommendationsResult,
  DriverMetricsDetailResult,
  LessonProgressResult,
  MarkLessonCompleteResult,
  MetricsPeriod,
  OrgMetricsResult,
} from "./metrics-core";

const passthrough = (x: unknown) => x;

export const getOrgMetrics = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<OrgMetricsResult> => {
  const core = await import("./metrics-core");
  return core.getOrgMetricsHandler((data as { period?: MetricsPeriod } | undefined)?.period);
});

export const getDriverMetrics = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<DriverMetricsDetailResult> => {
  const d = (data ?? {}) as { driverUserId?: string; period?: MetricsPeriod };
  const core = await import("./metrics-core");
  return core.getDriverMetricsHandler(d.driverUserId, d.period);
});

export const getMyMetrics = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<DriverMetricsDetailResult> => {
  const core = await import("./metrics-core");
  return core.getMyMetricsHandler((data as { period?: MetricsPeriod } | undefined)?.period);
});

export const getAcademyRecommendations = createServerFn({ method: "GET" }).handler(async (): Promise<AcademyRecommendationsResult> => {
  const core = await import("./metrics-core");
  return core.getAcademyRecommendationsHandler();
});

export const getLessonProgress = createServerFn({ method: "GET" }).handler(async (): Promise<LessonProgressResult> => {
  const core = await import("./metrics-core");
  return core.getLessonProgressHandler();
});

export const markLessonComplete = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<MarkLessonCompleteResult> => {
  const core = await import("./metrics-core");
  return core.markLessonCompleteHandler((data as { lessonId?: string } | undefined)?.lessonId);
});
