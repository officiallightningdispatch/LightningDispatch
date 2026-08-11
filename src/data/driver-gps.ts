/**
 * GPS tracking + geofence auto-arrive — CLIENT-SAFE FACADE (milestone #3).
 *
 * This module is the ONLY piece of the driver-gps feature imported by client
 * code (driver portal, live owner map, owner settings). It defines the four
 * createServerFn server functions; their handlers dynamic-import the
 * SERVER-ONLY core (./driver-gps-core.ts) so the client bundle never pulls in
 * db/auth-server/towbook code. No other exports — the core owns all logic.
 */
import { createServerFn } from "@tanstack/react-start";
import type { DriverLocationRow, GeofenceSettings, PingResult } from "./driver-gps-core";
export type { DriverLocationRow, GeofenceSettings, PingResult } from "./driver-gps-core";

const passthrough = (x: unknown) => x;

/** Driver portal location ping (every ~20s while en route/arrived): store +
 *  prune, best-effort Towbook checkin, geofence evaluation. */
export const pingDriverLocation = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<PingResult> => {
  const core = await import("./driver-gps-core");
  return core.pingHandler(data);
});

/** Latest ping per driver (last 60 min) for the owner/ops live map.
 *  Owner/admin/dispatcher only. */
export const getDriverLocations = createServerFn({ method: "GET" }).handler(async (): Promise<DriverLocationRow[]> => {
  const core = await import("./driver-gps-core");
  return core.getDriverLocationsHandler();
});

/** Geofence settings for the owner settings card (owner/admin read). */
export const getGeofenceSettingsFn = createServerFn({ method: "GET" }).handler(async (): Promise<GeofenceSettings | null> => {
  const core = await import("./driver-gps-core");
  return core.getGeofenceSettingsHandler();
});

/** Owner/admin update of the geofence radius + photos gate flag (audited). */
export const updateGeofenceSettings = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }) => {
  const core = await import("./driver-gps-core");
  return core.updateGeofenceSettingsHandler(data);
});
