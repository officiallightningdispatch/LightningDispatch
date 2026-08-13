/**
 * Push-subscription store + assigned-offer push sender (owner top priority
 * 2026-08-12). SERVER-ONLY module — reached from createServerFn handler bodies
 * (server.ts) and the AI-dispatcher engine via dynamic import inside private
 * functions, so it never leaks into the client bundle (client-graph rule).
 *
 * Tables: push_subscriptions (migration 35) — one row per browser endpoint,
 * UNIQUE on endpoint so a re-subscribe (endpoint changed) REPLACES the old row
 * (upsert). Scoped to (org_id, user_id); role 'contractor' users may
 * save/list/delete their own — and so may any OTHER org member who has a valid
 * driver identity (owner-in-driver-view, al0101 fix 2026-08-13: owner
 * membership + Towbook driver link). Everyone else refused (owner/admin without
 * a driver identity, dispatcher, unauthenticated — owner-directed, task
 * contract).
 *
 * sendAssignmentPush loads the contractor's subscriptions, encrypts the
 * notification payload (webpush.ts, RFC 8188/8291/8292 — no provider account),
 * POSTs each endpoint, removes stale 404/410 subscriptions, and ALWAYS writes
 * an audit row (`assignment_push` with status sent/failed/stale/no_subscriptions
 * + per-attempt evidence). A total failure ALSO records an
 * escalated_contractor_push_failure decision row (the ai_dispatcher_decisions
 * pattern) so the owner's "Needs attention" banner surfaces it. REPAIR
 * 2026-08-13 (phase 2): an ASSIGNED driver with ZERO subscriptions used to be
 * silently skipped (audit only — the banner never fired); it now records the
 * SAME deduplicated escalation (dedupe push-<callId>), so ops sees the delivery
 * gap. NEVER throws — push problems can never fail or slow the assignment.
 *
 * VAPID key resolution mirrors the existing secrets convention (towbook-key /
 * b2-client): env vars → <site-parent>/.secrets/*.key (stable, publish-proof)
 * → <site-root>/dist/.secrets/*.key (embedded by prepare-secrets.sh for the
 * live host) → <site-root>/.secrets/*.key → auto-provision at the stable path.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import { findSiteRoot } from "./towbook-key";
import type { AuthUser } from "./auth-server";

export type PushActor = { id: string; orgId: string; role: string };
export type PushSubscriptionRow = {
  id: string;
  orgId: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string | null;
};

const SITE_ROOT = findSiteRoot(import.meta.url);
const STABLE_DIR = join(dirname(SITE_ROOT), ".secrets");
const STABLE_PUB = join(STABLE_DIR, "push-vapid-public.key");
const STABLE_PRIV = join(STABLE_DIR, "push-vapid-private.key");
const EMBEDDED_DIR = join(SITE_ROOT, "dist", ".secrets");
const SOURCE_DIR = join(SITE_ROOT, ".secrets");

export type VapidKeys = { publicKey: string; privateKey: string };

async function readKeyFile(path: string): Promise<string> {
  return (await readFile(path, "utf8")).trim();
}

/** Resolve the VAPID keypair — first match wins (see header). Auto-provisions
 *  a fresh keypair at the stable path when nothing exists anywhere. */
export async function loadVapidKeys(env: Record<string, string | undefined> = process.env): Promise<VapidKeys> {
  const envPub = env.PUSH_VAPID_PUBLIC_KEY;
  const envPriv = env.PUSH_VAPID_PRIVATE_KEY;
  if (envPub && envPriv) return { publicKey: envPub.trim(), privateKey: envPriv.trim() };
  for (const dir of [STABLE_DIR, EMBEDDED_DIR, SOURCE_DIR]) {
    const pub = join(dir, "push-vapid-public.key");
    const priv = join(dir, "push-vapid-private.key");
    try {
      if (existsSync(pub) && existsSync(priv)) {
        return { publicKey: await readKeyFile(pub), privateKey: await readKeyFile(priv) };
      }
    } catch { /* try the next location */ }
  }
  // Provision a fresh keypair at the stable path (mirrors towbook-key).
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pubJwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const privJwk = privateKey.export({ format: "jwk" }) as { d: string };
  const raw = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(pubJwk.x, "base64url"),
    Buffer.from(pubJwk.y, "base64url"),
  ]);
  const keys = { publicKey: raw.toString("base64url"), privateKey: privJwk.d };
  await mkdir(STABLE_DIR, { recursive: true, mode: 0o700 });
  await writeFile(STABLE_PUB, keys.publicKey + "\n", { mode: 0o600 });
  await writeFile(STABLE_PRIV, keys.privateKey + "\n", { mode: 0o600 });
  return keys;
}

/* --------------------------------- role gate --------------------------------- */

/** Self-scoped driver gate (fix 2026-08-13, owner-hit al0101). role
 *  'contractor' always passes; any OTHER org member passes ONLY when they have
 *  a valid driver identity (own towbook_driver_id or a linked-driver
 *  resolution, not deactivated) — the owner-in-driver-view case. The actor id
 *  is ALWAYS the row owner (org+user forced from the actor, never from the
 *  client), so this can never touch another contractor's subscriptions. */
const contractorOnly = async (actor: PushActor): Promise<string | null> => {
  if (actor.role === "contractor") return null;
  if (await hasOrgDriverIdentity(actor)) return null;
  return "Only contractors can manage push notifications.";
};

/** The org-member-with-driver-identity check backing the gate: the actor is a
 *  member of their org (any role) whose row carries a driver identity and is
 *  not deactivated. Fails closed on DB errors. */
async function hasOrgDriverIdentity(actor: PushActor): Promise<boolean> {
  try {
    const q = await db();
    const rows = await q`SELECT 1 FROM organization_memberships m JOIN users u ON u.id=m.user_id
      WHERE m.org_id=${actor.orgId} AND m.user_id=${actor.id} AND u.deactivated_at IS NULL
        AND (u.towbook_driver_id IS NOT NULL OR u.linked_driver_user_id IS NOT NULL)
      LIMIT 1`;
    return rows.length > 0;
  } catch {
    return false;
  }
}

const db = () => import("~/db").then((m) => m.sql());

/** Resolve the push actor from a session user — the OWNER↔contractor view
 *  toggle (fix 2026-08-13, owner-hit al0101). Uses the SAME effective-driver
 *  resolver the driver portal maps the session through (auth-server
 *  effectiveDriverIdentity, mirroring resolveContractorActor in
 *  contractor-admin-core): an owner/admin with a valid driver identity becomes
 *  their own contractor identity (id = the driver's user row, role
 *  'contractor'), so the owner-in-driver-view saves/list/deletes subscriptions
 *  under their own driver row — never as a cross-contractor owner. Members
 *  without a driver identity keep their raw role; the gate refuses them. */
export async function resolvePushActor(u: AuthUser): Promise<PushActor> {
  const { effectiveDriverIdentity } = await import("./auth-server");
  const identity = await effectiveDriverIdentity(u);
  if (identity && !identity.deactivated) return { id: identity.userRowId, orgId: u.orgId, role: "contractor" };
  return { id: u.id, orgId: u.orgId, role: u.role };
}

/* ------------------------------ subscription CRUD ------------------------------ */

const SUB_COLS = `id, org_id, user_id, endpoint, p256dh, auth, user_agent, created_at, last_seen_at`;

function mapSub(r: Record<string, unknown>): PushSubscriptionRow {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    userId: String(r.user_id),
    endpoint: String(r.endpoint),
    p256dh: String(r.p256dh),
    auth: String(r.auth),
    userAgent: r.user_agent != null ? String(r.user_agent) : null,
    createdAt: new Date(String(r.created_at)).toISOString(),
    lastSeenAt: r.last_seen_at != null ? new Date(String(r.last_seen_at)).toISOString() : null,
  };
}

const subSchema = z.object({
  endpoint: z.string().min(1).max(1024),
  p256dh: z.string().min(1).max(512),
  auth: z.string().min(1).max(512),
  userAgent: z.string().max(512).optional(),
});

export type SavePushSubscriptionResult = { ok: true; subscription: PushSubscriptionRow } | { ok: false; error: string };

/** Upsert the actor's own subscription. The endpoint UNIQUE index is the
 *  re-subscribe key: a changed endpoint (PushSubscriptionChange) replaces the
 *  old row; the SAME endpoint re-saves refresh last_seen_at. Only the
 *  contractor themselves may write their row (org+user forced from the actor,
 *  never from the client). */
export async function savePushSubscriptionCore(
  actor: PushActor,
  input: unknown,
): Promise<SavePushSubscriptionResult> {
  const gate = await contractorOnly(actor);
  if (gate) return { ok: false, error: gate };
  const v = subSchema.safeParse(input);
  if (!v.success) return { ok: false, error: "Invalid push subscription." };
  const { endpoint, p256dh, auth, userAgent } = v.data;
  const q = await db();
  const id = `sub-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const rows = await q`INSERT INTO push_subscriptions(id, org_id, user_id, endpoint, p256dh, auth, user_agent, last_seen_at)
    VALUES(${id}, ${actor.orgId}, ${actor.id}, ${endpoint}, ${p256dh}, ${auth}, ${userAgent ?? null}, NOW())
    ON CONFLICT (endpoint) DO UPDATE SET
      org_id = EXCLUDED.org_id, user_id = EXCLUDED.user_id,
      p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
      user_agent = EXCLUDED.user_agent, last_seen_at = NOW()
    RETURNING id, org_id, user_id, endpoint, p256dh, auth, user_agent, created_at, last_seen_at`;
  return { ok: true, subscription: mapSub(rows[0] as Record<string, unknown>) };
}

export type ListPushSubscriptionsResult = { ok: true; subscriptions: PushSubscriptionRow[] } | { ok: false; error: string };

export async function listPushSubscriptionsCore(actor: PushActor): Promise<ListPushSubscriptionsResult> {
  const gate = await contractorOnly(actor);
  if (gate) return { ok: false, error: gate };
  const q = await db();
  const rows = await q`SELECT id, org_id, user_id, endpoint, p256dh, auth, user_agent, created_at, last_seen_at FROM push_subscriptions WHERE org_id=${actor.orgId} AND user_id=${actor.id} ORDER BY created_at`;
  return { ok: true, subscriptions: (rows as Record<string, unknown>[]).map(mapSub) };
}

export type DeletePushSubscriptionResult = { ok: true; deleted: boolean } | { ok: false; error: string };

export async function deletePushSubscriptionCore(
  actor: PushActor,
  endpoint: string,
): Promise<DeletePushSubscriptionResult> {
  const gate = await contractorOnly(actor);
  if (gate) return { ok: false, error: gate };
  if (!z.string().min(1).max(1024).safeParse(endpoint).success) return { ok: false, error: "Invalid endpoint." };
  const q = await db();
  const rows = await q`DELETE FROM push_subscriptions WHERE org_id=${actor.orgId} AND user_id=${actor.id} AND endpoint=${endpoint} RETURNING id`;
  return { ok: true, deleted: rows.length > 0 };
}

/* ------------------------------ self-test send ------------------------------ */

/** Result of a push self-test (owner-directed 2026-08-13). reason is null on a
 *  full send, "no_subscriptions" when the actor has no saved subscription on
 *  any device, the actor-gate message when the caller isn't a driver, or the
 *  underlying send error. NEVER throws. */
export type PushSelfTestResult = {
  attempted: number;
  sent: number;
  failed: number;
  reason: string | null;
};

/**
 * Send a test push to the ACTOR's OWN subscriptions — the "Send test
 *  notification" button on the driver's Notifications card. Same driver-
 *  identity gate as the subscription CRUD (contractor, or any org member with
 *  a valid driver identity — owner-in-driver-view). The org id and user id are
 *  taken from the session-resolved actor, NEVER from the client, so a self-test
 *  can only ever target the caller's own subscription rows (self-scoped).
 *
 * Payload: tag `self-test-<ts>`, callId `SELF-<ts>` (audit identity), jobType
 * "Lightning Dispatch test", location "If you see this banner, notifications
 * are working on this phone." — the banner the driver sees.
 */
export async function sendPushSelfTestCore(actor: PushActor, opts: SendDeps = {}): Promise<PushSelfTestResult> {
  const gate = await contractorOnly(actor);
  if (gate) return { attempted: 0, sent: 0, failed: 0, reason: gate };
  const ts = Date.now();
  const payload: AssignmentPushPayload = {
    callId: `SELF-${ts}`,
    callRequestId: null,
    jobType: "Lightning Dispatch test",
    location: "If you see this banner, notifications are working on this phone.",
    etaMinutes: null,
    jobUrl: "/driver",
    tag: `self-test-${ts}`,
  };
  try {
    const out = await sendAssignmentPush(actor.orgId, actor.id, payload, opts);
    return {
      attempted: out.attempted,
      sent: out.sent,
      failed: out.failed,
      reason: out.skipped ? out.reason : out.failed > 0 ? `Send failed on ${out.failed} attempt(s)` : null,
    };
  } catch (err) {
    // sendAssignmentPush never throws by contract; this is belt-and-braces for
    // the "never throws" guarantee of the self-test itself.
    return { attempted: 0, sent: 0, failed: 1, reason: String(err).slice(0, 200) };
  }
}

/* ------------------------------ send on assignment ------------------------------ */

/** The notification payload the service worker renders (spec A1 — verbatim
 *  copy). The SW reads these fields and builds title/body/tag/icon/sound. */
export type AssignmentPushPayload = {
  /** Towbook call id (the job's tag + audit identity). */
  callId: string | null;
  /** The motor-club offer's callRequestId (AI-dispatch tie). */
  callRequestId: string | null;
  /** Human service label ("Flatbed tow"). */
  jobType: string;
  /** Pickup location ("Main St & 5th Ave, 06606" or lat,lng). */
  location: string;
  /** Road-aware ETA minutes (never fabricated; null → "ETA pending"). */
  etaMinutes: number | null;
  /** In-app route the notification opens ("/driver"). */
  jobUrl: string;
  /** Notification tag override (self-test 2026-08-13: "self-test-<ts>").
   *  Defaults to job-<callId|callRequestId> when omitted. */
  tag?: string;
};

export type PushSendOutcome = {
  attempted: number;
  sent: number;
  failed: number;
  staleRemoved: number;
  skipped: boolean;
  reason: string | null;
};

/** Build the SW notification JSON (spec A1 — exact copy, no urgency words). */
export function buildPushNotificationJson(p: AssignmentPushPayload): Record<string, unknown> {
  const eta = p.etaMinutes != null ? `ETA ~${Math.max(1, p.etaMinutes)} min` : "ETA pending";
  const location = p.location && p.location.trim() !== "" ? p.location.trim() : `Call #${p.callId ?? "—"}`;
  return {
    title: "New job — Lightning Dispatch",
    body: `${p.jobType || "Tow job"} · ${location} · ${eta}`,
    tag: p.tag ?? `job-${p.callId ?? p.callRequestId ?? "unknown"}`,
    data: { url: p.jobUrl || "/driver" },
    icon: "/favicon.svg",
    badge: "/favicon.svg",
    // ABSOLUTE same-origin URL — the SW's showNotification `sound` option needs
    // a resolvable static path (public/sounds/lightning-strike.mp3, re-rendered
    // to 98% FS by scripts/generate-strike.mjs). Android Chrome is the main
    // beneficiary; iOS Safari ignores custom sound (OS limitation — the in-app
    // WebAudio strike is the guaranteed-loud path there).
    sound: "/sounds/lightning-strike.mp3",
    renotify: false,
  };
}

async function recordAudit(
  orgId: string,
  userId: string,
  payload: AssignmentPushPayload,
  status: string,
  detail: Record<string, unknown>,
): Promise<void> {
  void status;
  try {
    const q = await db();
    await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
      VALUES(gen_random_uuid()::text, ${orgId}, ${userId}, 'contractor', 'assignment_push', 'job', ${payload.callId ?? payload.callRequestId ?? "unknown"}, ${JSON.stringify({ status, ...detail })}::jsonb, 'assignment-push')`;
    void status;
  } catch { /* audit is best-effort — never mask the send outcome */ }
}

/** Failure escalation → the ops "Needs attention" banner (ai_dispatcher_decisions
 *  with decision escalated_contractor_push_failure, deduped per call). */
async function recordPushEscalation(
  orgId: string,
  payload: AssignmentPushPayload,
  reason: string,
  evidence: Record<string, unknown>,
): Promise<void> {
  try {
    const q = await db();
    await q`INSERT INTO ai_dispatcher_decisions(id, org_id, call_request_id, call_id, decision, escalated, driver_id, driver_name, eta_minutes, zone_distance_miles, reason, raw_response)
      VALUES(gen_random_uuid()::text, ${orgId}, ${`push-${payload.callId ?? payload.callRequestId ?? "unknown"}`}, ${payload.callId}, 'escalated_contractor_push_failure', TRUE, NULL, NULL, NULL, NULL, ${reason}, ${JSON.stringify(evidence)}::jsonb)
      ON CONFLICT DO NOTHING`;
  } catch { /* never mask the send outcome */ }
}

type SendDeps = { fetchImpl?: typeof fetch; now?: Date };

/**
 * Send the assignment push to EVERY subscription of one contractor. Fire-and-
 * forget by contract: NEVER throws (each failure is audited; a total failure
 * also escalates to the ops banner). 404/410 endpoints are removed.
 */
export async function sendAssignmentPush(
  orgId: string,
  userId: string,
  payload: AssignmentPushPayload,
  opts: SendDeps = {},
): Promise<PushSendOutcome> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const outcome: PushSendOutcome = { attempted: 0, sent: 0, failed: 0, staleRemoved: 0, skipped: false, reason: null };
  try {
    const q = await db();
    const subs = await q`SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE org_id=${orgId} AND user_id=${userId}`;
    if (!subs.length) {
      outcome.skipped = true;
      outcome.reason = "no_subscriptions";
      await recordAudit(orgId, userId, payload, "no_subscriptions", { attempts: [] });
      // REPAIR 2026-08-13 (phase 2): a zero-subscription assigned driver used to
      // be silently skipped (audit row only) — the ops "Needs attention" banner
      // never fired. Record the SAME deduplicated escalation the failed-send path
      // writes (decision escalated_contractor_push_failure, dedupe key
      // push-<callId> via the (org_id, call_request_id) unique index + ON
      // CONFLICT DO NOTHING), so ops sees the delivery gap. Fire-and-forget:
      // recordPushEscalation never throws, so the skip stays non-blocking.
      await recordPushEscalation(
        orgId,
        payload,
        `Contractor ${userId} has no push subscription — notification not delivered; in-app banner only.`,
        { sent: 0, failed: 0, attempts: [] },
      );
      return outcome;
    }
    let keys: { publicKey: string; privateKey: string } | null = null;
    const attempts: Array<Record<string, unknown>> = [];
    for (const s of subs as Record<string, unknown>[]) {
      const endpoint = String(s.endpoint);
      const sub = { endpoint, p256dh: String(s.p256dh), auth: String(s.auth) };
      outcome.attempted++;
      try {
        keys ??= await loadVapidKeys();
        const { encryptPush } = await import("./webpush");
        const { body, headers } = encryptPush(sub, JSON.stringify(buildPushNotificationJson(payload)), keys);
        const res = await fetchImpl(endpoint, {
          method: "POST",
          headers: { ...headers },
          body,
        });
        const status = res.status ?? 0;
        if (status === 404 || status === 410) {
          await q`DELETE FROM push_subscriptions WHERE id=${String(s.id)}`;
          outcome.staleRemoved++;
          attempts.push({ endpoint, status, outcome: "stale-removed" });
        } else if (status >= 200 && status < 300) {
          outcome.sent++;
          attempts.push({ endpoint, status, outcome: "sent" });
        } else {
          outcome.failed++;
          attempts.push({ endpoint, status, outcome: "failed", body: String(await res.text().catch(() => "")).slice(0, 200) });
        }
      } catch (err) {
        outcome.failed++;
        attempts.push({ endpoint, outcome: "failed", error: String(err).slice(0, 200) });
      }
    }
    await recordAudit(orgId, userId, payload, outcome.failed === 0 ? "sent" : "failed", { attempts, sent: outcome.sent, failed: outcome.failed, staleRemoved: outcome.staleRemoved });
    if (outcome.failed > 0 || outcome.staleRemoved > 0) {
      await recordPushEscalation(
        orgId,
        payload,
        `${outcome.failed} push attempt(s) failed${outcome.staleRemoved ? `, ${outcome.staleRemoved} stale endpoint(s) removed` : ""} for contractor ${userId} — the in-app banner still fires on their next queue poll`,
        { sent: outcome.sent, failed: outcome.failed, staleRemoved: outcome.staleRemoved, attempts },
      );
    }
    return outcome;
  } catch (err) {
    outcome.failed = Math.max(outcome.failed, 1);
    outcome.reason = String(err).slice(0, 200);
    await recordAudit(orgId, userId, payload, "failed", { attempts: [], error: outcome.reason });
    return outcome;
  }
}

/**
 * Resolve a Towbook driver id to the LD contractor user and send. Used by the
 * AI dispatcher (the engine only knows Towbook driver ids). Matches active
 * users with that towbook_driver_id in the org — contractor role first, then
 * any active member (covers owner-linked driver identities).
 */
export async function sendAssignmentPushByTowbookDriver(
  orgId: string,
  towbookDriverId: string | number,
  payload: AssignmentPushPayload,
  opts: SendDeps = {},
): Promise<PushSendOutcome> {
  const q = await db();
  const tid = String(towbookDriverId);
  const rows = await q`
    SELECT u.id FROM users u
    JOIN organization_memberships m ON m.user_id = u.id AND m.org_id = ${orgId}
    WHERE u.towbook_driver_id = ${tid} AND u.deactivated_at IS NULL
    ORDER BY (m.role = 'contractor') DESC, u.created_at ASC LIMIT 1`;
  if (!rows.length) {
    const outcome: PushSendOutcome = { attempted: 0, sent: 0, failed: 0, staleRemoved: 0, skipped: true, reason: "no_ld_user_for_towbook_driver" };
    await recordAudit(orgId, `tb:${tid}`, payload, "no_subscriptions", { attempts: [], reason: outcome.reason });
    return outcome;
  }
  return sendAssignmentPush(orgId, String((rows[0] as Record<string, unknown>).id), payload, opts);
}

/**
 * THE single assigned-job notification trigger (owner-reassign will call this
 * too — same signature). Loads the dispatch_jobs row for the call, builds the
 * payload, and sends to the assigned contractor (resolved by their LD user id;
 * the AI-dispatcher seam additionally resolves by Towbook driver id via
 * sendAssignmentPushByTowbookDriver, which funnels into the same send).
 * Never throws; never blocks the assignment. No job row → audit + skip.
 */
export async function notifyAssignedDriver(
  orgId: string,
  contractorUserId: string,
  jobId: string,
  opts: SendDeps = {},
): Promise<PushSendOutcome> {
  const q = await db();
  const rows = await q`SELECT service_type, towbook_job_id, area, pickup, lat, lng FROM dispatch_jobs WHERE id=${jobId} AND org_id=${orgId}`;
  if (!rows.length) {
    const outcome: PushSendOutcome = { attempted: 0, sent: 0, failed: 0, staleRemoved: 0, skipped: true, reason: "job_not_found" };
    await recordAudit(orgId, contractorUserId, { callId: null, callRequestId: null, jobType: "Tow job", location: "", etaMinutes: null, jobUrl: "/driver" }, "no_job", { attempts: [], jobId });
    return outcome;
  }
  const r = rows[0] as Record<string, unknown>;
  const serviceType = String(r.service_type ?? "");
  const label = JOB_TYPE_LABELS[serviceType as keyof typeof JOB_TYPE_LABELS] ?? (serviceType ? serviceType.replace(/_/g, " ") : "Tow job");
  const location = [String(r.pickup ?? ""), String(r.area ?? "")].filter(Boolean).join(", ") ||
    (r.lat != null && r.lng != null ? `${String(r.lat)},${String(r.lng)}` : "");
  const payload: AssignmentPushPayload = {
    callId: r.towbook_job_id != null && String(r.towbook_job_id) !== "" ? String(r.towbook_job_id) : null,
    callRequestId: null,
    jobType: label,
    location,
    etaMinutes: null, // manual assign quotes no ETA — the driver app shows its own
    jobUrl: "/driver",
  };
  return sendAssignmentPush(orgId, contractorUserId, payload, opts);
}

/** Back-compat alias — the manual assign path (assignJob in server.ts) and the
 *  AI-dispatcher job-row path both route through notifyAssignedDriver. */
export async function fireAssignmentPush(
  orgId: string,
  contractorUserId: string,
  jobId: string,
  opts: SendDeps = {},
): Promise<PushSendOutcome> {
  return notifyAssignedDriver(orgId, contractorUserId, jobId, opts);
}
/** Tiny local label map (server-side; client libs are off-limits here). */
const JOB_TYPE_LABELS: Record<string, string> = {
  jump_start: "Jump start",
  tire_change: "Tire change",
  tire_service: "Tire service",
  lockout: "Lockout",
  flatbed_tow: "Flatbed tow",
  fuel_delivery: "Fuel delivery",
  tow: "Tow",
  roadside: "Roadside assistance",
};
