/**
 * Push subscriptions — CLIENT-SAFE FACADE (assigned-offer push notification,
 * owner top priority 2026-08-12). The ONLY piece of the push feature imported
 * by client code (driver portal push setup). Defines the createServerFn server
 * functions; their handlers dynamic-import the SERVER-ONLY core (./push-core)
 * so the client bundle never pulls in db/auth-server code (client-graph rule).
 *
 * Role gate (task contract + spec A0): ONLY contractors (role 'contractor')
 * can save/list/delete their own subscription; owner/admin/dispatcher or
 * unauthenticated → refused. The client treats every refusal as silent (the
 * in-app banner + WebAudio strike are the primary path anyway).
 */
import { createServerFn } from "@tanstack/react-start";
import type { PushSubscriptionRow } from "./push-core";
export type { PushSubscriptionRow } from "./push-core";

const passthrough = (x: unknown) => x;

export type PushCommandResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Upsert the contractor's own subscription (endpoint UNIQUE → replace). */
export const savePushSubscription = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<PushCommandResult<PushSubscriptionRow>> => {
  const core = await import("./push-core");
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, error: "Sign in required." };
  const res = await core.savePushSubscriptionCore({ id: u.id, orgId: u.orgId, role: u.role }, data);
  return res.ok ? { ok: true as const, data: res.subscription } : { ok: false as const, error: res.error };
});

/** The contractor's own subscriptions (usually one). */
export const listPushSubscriptions = createServerFn({ method: "GET" }).validator(passthrough).handler(async (): Promise<PushCommandResult<PushSubscriptionRow[]>> => {
  const core = await import("./push-core");
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, error: "Sign in required." };
  const res = await core.listPushSubscriptionsCore({ id: u.id, orgId: u.orgId, role: u.role });
  return res.ok ? { ok: true as const, data: res.subscriptions } : { ok: false as const, error: res.error };
});

/** Delete one of the contractor's own subscriptions by endpoint. */
export const deletePushSubscription = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<PushCommandResult<{ deleted: boolean }>> => {
  const core = await import("./push-core");
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, error: "Sign in required." };
  const endpoint = (data as { endpoint?: unknown } | undefined)?.endpoint;
  const res = await core.deletePushSubscriptionCore({ id: u.id, orgId: u.orgId, role: u.role }, typeof endpoint === "string" ? endpoint : "");
  return res.ok ? { ok: true as const, data: { deleted: res.deleted } } : { ok: false as const, error: res.error };
});

/** The VAPID public key for PushManager.subscribe (applicationServerKey).
 *  Contractors only — mirrors the subscription role gate. The private key
 *  NEVER leaves the server. */
export const getPushVapidPublicKey = createServerFn({ method: "GET" }).validator(passthrough).handler(async (): Promise<PushCommandResult<string>> => {
  const core = await import("./push-core");
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, error: "Sign in required." };
  if (u.role !== "contractor") return { ok: false as const, error: "Only contractors can enable push." };
  try {
    const keys = await core.loadVapidKeys();
    return { ok: true as const, data: keys.publicKey };
  } catch {
    return { ok: false as const, error: "Unable to load the push key." };
  }
});
