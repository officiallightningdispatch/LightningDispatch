/**
 * Photo workflow (milestone #4) — CLIENT-SAFE FACADE.
 *
 * This module is the ONLY piece of the photo feature imported by client code
 * (driver portal, ops queue cards). It defines the createServerFn server
 * functions; their handlers dynamic-import the SERVER-ONLY core
 * (./driver-photos-core.ts) so the client bundle never pulls in b2-client /
 * node:crypto / db / auth-server code. No other exports — the core owns all
 * logic (see the client-graph rule that has broken the build before).
 */
import { createServerFn } from "@tanstack/react-start";
import type { JobPhotoStatus } from "./driver-photos-core";
export type { JobPhotoStatus, PhotoPhase, PhotoSide } from "./driver-photos-core";

const passthrough = (x: unknown) => x;

/** Upload one photo for a phase+side slot (B2 + job_photos). */
export const uploadJobPhoto = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }) => {
  const core = await import("./driver-photos-core");
  return core.uploadJobPhotoHandler(data);
});

/** Driver's vehicle-match confirmation (pre_arrival, owner spec). */
export const setVehicleMatch = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }) => {
  const core = await import("./driver-photos-core");
  return core.setVehicleMatchHandler(data);
});

/** Soft complete (arrived → service) — gated on 4/4 pre-arrival + match. */
export const softCompleteJob = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }) => {
  const core = await import("./driver-photos-core");
  return core.softCompleteHandler(data);
});

/** Final complete (service → finalizing) — gated on 4/4 service photos. */
export const finalCompleteJob = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }) => {
  const core = await import("./driver-photos-core");
  return core.finalCompleteHandler(data);
});

/** Completion push: 12 photos → Towbook PO (driver session) → status 5 → platform. */
export const completeJobWithPhotos = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }) => {
  const core = await import("./driver-photos-core");
  return core.completeJobHandler(data);
});

/** One job's photo status (driver: own jobs only; owner/admin/dispatcher: org). */
export const getJobPhotoStatus = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }) => {
  const core = await import("./driver-photos-core");
  return core.getJobPhotoStatusHandler(data);
});

/** Every job's photo status for the owner/ops queue cards. */
export const getAllJobPhotoStatuses = createServerFn({ method: "GET" }).handler(async (): Promise<JobPhotoStatus[]> => {
  const core = await import("./driver-photos-core");
  return core.allJobPhotoStatusesHandler();
});
