/**
 * Driver Help & Support + post-job feedback — CLIENT-SAFE FACADE (driver
 * portal R2, 2026-08-11). Client-reachable module: the createServerFn
 * handlers dynamic-import the SERVER-ONLY core (./driver-support-core.ts) so
 * the client bundle never pulls in db/auth-server code. No other exports.
 */
import { createServerFn } from "@tanstack/react-start";
import type { DriverIssueResult, DriverFeedbackResult } from "./driver-support-core";

const passthrough = (x: unknown) => x;

/** Driver "report a problem" (Help screen) + decline-intent ("Can't take it"
 *  on Offers): inserts a driver_issues row + audit_log. Contractor-only. */
export const submitDriverIssue = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<DriverIssueResult> => {
  const core = await import("./driver-support-core");
  return core.submitDriverIssueHandler(data);
});

/** Driver post-job rating (1-5 stars + optional note) → job_feedback + audit.
 *  SEPARATE from the customer survey in job_completions.survey. */
export const submitDriverFeedback = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<DriverFeedbackResult> => {
  const core = await import("./driver-support-core");
  return core.submitDriverFeedbackHandler(data);
});
