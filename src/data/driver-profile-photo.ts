/**
 * Driver profile photo — CLIENT-SAFE FACADE (driver-portal feature batch 7,
 * owner-directed 2026-08-12). The ONLY piece of the profile-photo feature
 * imported by client code (driver profile screen, portal header avatar). The
 * createServerFn handlers dynamic-import the SERVER-ONLY core
 * (./driver-profile-photo-core.ts) so the client bundle never pulls in
 * b2-client / node:crypto / db / auth-server code (see the client-graph rule).
 */
import { createServerFn } from "@tanstack/react-start";
import type { ProfilePhotoResult } from "./driver-profile-photo-core";
export type { ProfilePhotoResult } from "./driver-profile-photo-core";

const passthrough = (x: unknown) => x;

/** Resolve the EFFECTIVE driver (owner/admin in driver view included) or null. */
async function resolveDriver(): Promise<{ orgId: string; userRowId: string; actorUserId: string; actorRole: string } | null> {
  const { currentUser, effectiveDriverIdentity } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return null;
  const identity = await effectiveDriverIdentity(u);
  if (!identity || identity.deactivated) return null;
  return { orgId: u.orgId, userRowId: identity.userRowId, actorUserId: u.id, actorRole: u.role };
}

/** Upload (or replace) the driver's profile photo (B2 + key row). */
export const uploadMyProfilePhoto = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<ProfilePhotoResult> => {
  const core = await import("./driver-profile-photo-core");
  const driver = await resolveDriver();
  if (!driver) return { ok: false as const, code: "unauthorized", message: "Sign in as a driver first." };
  return core.uploadProfilePhotoCore(
    { orgId: driver.orgId, id: driver.userRowId, role: "contractor", actorUserId: driver.actorUserId, actorRole: driver.actorRole, ownerInDriverView: driver.actorRole !== "contractor" },
    data,
  );
});

/** Read the driver's profile photo bytes back as a data URL (avatar). */
export const getMyProfilePhoto = createServerFn({ method: "GET" }).handler(async (): Promise<ProfilePhotoResult> => {
  const core = await import("./driver-profile-photo-core");
  const driver = await resolveDriver();
  if (!driver) return { ok: false as const, code: "unauthorized", message: "Sign in as a driver first." };
  return core.getProfilePhotoCore({ orgId: driver.orgId, id: driver.userRowId });
});
