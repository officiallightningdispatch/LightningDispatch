/**
 * Customer completion capture (milestone "completion flow") — CLIENT-SAFE
 * FACADE.
 *
 * This module is the ONLY piece of the completion feature imported by client
 * code (driver portal, ops queue cards). It defines the createServerFn server
 * functions; their handlers dynamic-import the SERVER-ONLY core
 * (./completion-core.ts) so the client bundle never pulls in b2-client /
 * square-client / node:crypto / db / auth-server code. No other exports — the
 * core owns all logic (see the client-graph rule that has broken the build
 * before).
 */
import { createServerFn } from "@tanstack/react-start";
import type { CompletionCaptureStatus } from "./completion-core";
export type { CompletionCaptureStatus, CompletionTip, TipStatus } from "./completion-core";

const passthrough = (x: unknown) => x;

/** Store the customer's signature (PNG → B2) + survey for the job (upsert). */
export const captureCompletion = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }) => {
  const core = await import("./completion-core");
  return core.captureCompletionHandler(data);
});

/** Create a Square-hosted payment link for the optional tip (driver-attributed). */
export const createTipLink = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }) => {
  const core = await import("./completion-core");
  return core.createTipLinkHandler(data);
});

/** Charge the customer's card (Web Payments token) for the optional tip —
 *  attribution row recorded server-side (completion_tips). */
export const chargeTip = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }) => {
  const core = await import("./completion-core");
  return core.chargeTipHandler(data);
});

/** Record that the customer declined the tip (completion proceeds regardless). */
export const declineTip = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }) => {
  const core = await import("./completion-core");
  return core.declineTipHandler(data);
});

/** PUBLIC Square Web Payments config (application id + location id only — the
 *  access token never leaves the server). */
export const getSquareWebPaymentsConfig = createServerFn({ method: "GET" }).handler(async () => {
  const core = await import("./completion-core");
  return core.getSquareWebPaymentsConfigHandler();
});

/** One job's completion capture (driver: own jobs only; owner/admin/dispatcher: org). */
export const getCompletionCapture = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }) => {
  const core = await import("./completion-core");
  return core.getCompletionCaptureHandler(data);
});

/** Every job's completion capture for the owner/ops queue cards. */
export const getAllCompletionCaptures = createServerFn({ method: "GET" }).handler(async (): Promise<CompletionCaptureStatus[]> => {
  const core = await import("./completion-core");
  return core.allCompletionCapturesHandler();
});

/** Is the owner's Square account wired? Drives whether the tip block renders. */
export const isSquareConfigured = createServerFn({ method: "GET" }).handler(async (): Promise<{ configured: boolean }> => {
  const core = await import("./completion-core");
  return core.isSquareConfiguredHandler();
});
