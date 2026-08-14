/**
 * Push subscriptions — CLIENT-SAFE FACADE (assigned-offer push notification,
 * owner top priority 2026-08-12). The ONLY piece of the push feature imported
 * by client code (driver portal push setup). Defines the createServerFn server
 * functions; their handlers dynamic-import the SERVER-ONLY core (./push-core)
 * so the client bundle never pulls in db/auth-server code (client-graph rule).
 *
 * Role gate (fix 2026-08-13, owner-hit al0101): the actor is resolved through
 * the EFFECTIVE-DRIVER path (core.resolvePushActor) — role 'contractor' users
 * save/list/delete their own subscription, and so does any org member with a
 * valid driver identity (owner-in-driver-view: the owner↔contractor toggle).
 * Owner/admin/dispatcher without a driver identity, or unauthenticated →
 * refused. The client treats every refusal as silent (the in-app banner +
 * WebAudio strike are the primary path anyway).
 */
import { createServerFn } from "@tanstack/react-start";
import type { PushSelfTestResult, PushSubscriptionRow } from "./push-core";
export type { PushSelfTestResult, PushSubscriptionRow } from "./push-core";

const passthrough = (x: unknown) => x;

export type PushCommandResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Upsert the contractor's own subscription (account-scoped (org,user,endpoint)
 *  uniqueness — migration 46; a different user's save can never steal the row). */
export const savePushSubscription = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<PushCommandResult<PushSubscriptionRow>> => {
  const core = await import("./push-core");
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, error: "Sign in required." };
  const actor = await core.resolvePushActor(u);
  const res = await core.savePushSubscriptionCore(actor, data);
  return res.ok ? { ok: true as const, data: res.subscription } : { ok: false as const, error: res.error };
});

/** The contractor's own subscriptions (usually one). */
export const listPushSubscriptions = createServerFn({ method: "GET" }).validator(passthrough).handler(async (): Promise<PushCommandResult<PushSubscriptionRow[]>> => {
  const core = await import("./push-core");
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, error: "Sign in required." };
  const actor = await core.resolvePushActor(u);
  const res = await core.listPushSubscriptionsCore(actor);
  return res.ok ? { ok: true as const, data: res.subscriptions } : { ok: false as const, error: res.error };
});

/** Delete one of the contractor's own subscriptions by endpoint. */
export const deletePushSubscription = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<PushCommandResult<{ deleted: boolean }>> => {
  const core = await import("./push-core");
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, error: "Sign in required." };
  const endpoint = (data as { endpoint?: unknown } | undefined)?.endpoint;
  const actor = await core.resolvePushActor(u);
  const res = await core.deletePushSubscriptionCore(actor, typeof endpoint === "string" ? endpoint : "");
  return res.ok ? { ok: true as const, data: { deleted: res.deleted } } : { ok: false as const, error: res.error };
});

/** The VAPID public key for PushManager.subscribe (applicationServerKey).
 *  Driver-identity gated like the subscription CRUD (an owner-in-driver-view
 *  needs the key to subscribe at all). The private key NEVER leaves the
 *  server. */
export const getPushVapidPublicKey = createServerFn({ method: "GET" }).validator(passthrough).handler(async (): Promise<PushCommandResult<string>> => {
  const core = await import("./push-core");
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, error: "Sign in required." };
  const actor = await core.resolvePushActor(u);
  if (actor.role !== "contractor") return { ok: false as const, error: "Only contractors can enable push." };
  try {
    const keys = await core.loadVapidKeys();
    return { ok: true as const, data: keys.publicKey };
  } catch {
    return { ok: false as const, error: "Unable to load the push key." };
  }
});

/** Send a test push to the CALLER'S OWN device(s) — the "Send test
 *  notification" button on the driver's Notifications card (owner-directed
 *  2026-08-13). The actor is resolved from the SESSION through the same
 *  effective-driver path as the subscription CRUD (never from the client), so
 *  the self-test is self-scoped: it can only reach the caller's own
 *  subscription rows. Returns { attempted, sent, failed, reason } and never
 *  throws. */
export const sendPushSelfTest = createServerFn({ method: "POST" }).validator(passthrough).handler(async (): Promise<PushCommandResult<PushSelfTestResult>> => {
  const core = await import("./push-core");
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false as const, error: "Sign in required." };
  const actor = await core.resolvePushActor(u);
  const res = await core.sendPushSelfTestCore(actor);
  return { ok: true as const, data: res };
});
