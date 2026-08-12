/**
 * Driver portal v1 (owner-directed 2026-08-11): a driver's platform username +
 * password ARE their Towbook credentials — one login. Logging a driver into
 * Lightning Dispatch (a) authenticates them against app.towbook.com via the
 * shared towbookLogin helper, (b) upserts their LD driver user, (c) stores the
 * encrypted per-driver Towbook session (session_kind='driver'), (d) auto-checks
 * them in (POST /api/user/checkin) with their captured geolocation so the AI
 * dispatcher sees them available, and (e) creates the LD session.
 *
 * Queue + actions mirror the Towbook driver app (see
 * /home/team/shared/towbook-driver-app.md): job list = GET /api/calls
 * (server-side per-session scoping expected; fallback filters
 * assets[].driver.id), thumbs-up/en-route = PUT /api/calls/{id}
 * {id, status:{id:2|3}} — via the DRIVER's own session, never the owner's —
 * with idempotency (never double-PUT a transition), a wrong-driver guard, and
 * a write-through to LD dispatch_jobs (status_events + audit_log) so the owner
 * and ops portals reflect the change immediately (the 30s sync re-confirms).
 *
 * Client-safety (build-critical): this module is imported by client routes, so
 * every Node-only dependency (auth-server, towbook-login, towbook-key, db) is
 * loaded via dynamic import inside the server-fn handlers — never statically —
 * and the tiny Towbook-shape helpers are copied here instead of importing the
 * heavy server/ai-dispatcher modules. Every Towbook-facing function takes an
 * injectable fetchImpl for hermetic tests — no real Towbook calls in tests.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { DriverIdentityInfo } from "./auth-server";

export type DriverIdentity = { userId: string; driverId: string; driverName: string };
export type DriverSession = { cookies: string; baseUrl: string };
export type DriverCall = {
  id: string;
  callNumber: string;
  statusId: number;
  serviceName: string;
  pickupAddress: string;
  zip: string;
  vehicle: string;
  arrivalETA: string | null;
  purchaseOrderNumber: string | null;
  /** Real member/customer name — contacts[0] on the raw call (the sync's
   *  firstContact helper mirrored here). "" when the raw call has none. */
  customerName: string;
  /** Raw contact phone (digits kept as-is for tel: links). "" when absent. */
  customerPhone: string;
  /** Pickup waypoint coordinates (waypoints[0]); null when missing/zero. */
  pickupLat: number | null;
  pickupLng: number | null;
  /** Best available Towbook timestamp for this call — arrivalTime (arrived/
   *  completed), else enrouteTime, else createDate. Used by the Earnings
   *  Today/Week toggle + per-job rows. null when the call has no timestamps. */
  updatedAtIso: string | null;
};
export type DriverJobAction = "accept" | "en_route";
const STATUS_ID_FOR_ACTION: Record<DriverJobAction, number> = { accept: 2, en_route: 3 };

/* ------------------------- local copies of Towbook helpers ------------------------- */
/** Mirrors server.ts TOWBOOK_STATUS_ID_TO_LIFECYCLE (owner-verified 2026-08-10). */
const STATUS_ID_TO_LIFECYCLE: Readonly<Record<number, string>> = {
  0: "new", 1: "offered", 2: "accepted", 3: "en_route", 4: "arrived", 5: "completed",
  252: "completed", 255: "cancelled",
};
/** Local copy of server.ts assignedDriverFromRawCall (this module deliberately
 *  keeps tiny Towbook-shape helpers local instead of importing server modules):
 *  the assigned driver on a raw call — assets[].driver = {id, name, ...} (the
 *  same shape the sync persists), so a first-sighting import carries the real
 *  driver attribution (BUG 4 fix 2026-08-11 — jobs were showing UNASSIGNED). */
function assignedDriverFromRawCall(raw: unknown): { towbookId: string | null; name: string | null } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { towbookId: null, name: null };
  const assets = (raw as Record<string, unknown>).assets;
  if (!Array.isArray(assets)) return { towbookId: null, name: null };
  for (const a of assets) {
    if (!a || typeof a !== "object" || Array.isArray(a)) continue;
    const o = a as Record<string, unknown>;
    const direct = o.driver as Record<string, unknown> | undefined;
    if (direct && typeof direct === "object" && direct.id != null) {
      return { towbookId: String(direct.id), name: direct.name != null ? String(direct.name) : null };
    }
    const drivers = o.drivers;
    if (Array.isArray(drivers)) {
      for (const d of drivers) {
        if (!d || typeof d !== "object" || Array.isArray(d)) continue;
        const sub = ((d as Record<string, unknown>).driver ?? null) as Record<string, unknown> | null;
        if (sub && typeof sub === "object" && sub.id != null) {
          return { towbookId: String(sub.id), name: sub.name != null ? String(sub.name) : null };
        }
      }
    }
  }
  return { towbookId: null, name: null };
}
const numericStatusId = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") { const n = Number(v); if (Number.isFinite(n)) return n; }
  return null;
};
/** Mirrors server.ts extractTowbookStatusId. */
function extractTowbookStatusId(status: unknown): number | null {
  if (status == null) return null;
  if (typeof status === "number" || typeof status === "string") return numericStatusId(status);
  if (Array.isArray(status)) return status.length === 1 ? extractTowbookStatusId(status[0]) : null;
  if (typeof status === "object") {
    const o = status as Record<string, unknown>;
    const byId = numericStatusId(o.id);
    if (byId != null) return byId;
    const next = o.next && typeof o.next === "object" && !Array.isArray(o.next) ? (o.next as Record<string, unknown>) : null;
    if (next) {
      const byNext = numericStatusId(next.statusId);
      if (byNext != null) return byNext;
    }
  }
  return null;
}
const configured = () => Boolean(process.env.DATABASE_URL);
let schemaInit: Promise<void> | undefined;
function ensure() {
  if (!configured()) return Promise.resolve();
  schemaInit ??= (async () => {
    const { ensureAuthSchema } = await import("./auth-server");
    await ensureAuthSchema();
    const { ensureSchema } = await import("./migrations");
    await ensureSchema();
  })();
  return schemaInit;
}
const db = () => import("~/db").then((m) => m.sql());
async function resolveOwnerOrgId(): Promise<string | null> {
  const q = await db();
  const rows = await q`SELECT org_id FROM organization_memberships WHERE role='owner' LIMIT 1`;
  return rows.length ? String(rows[0].org_id) : null;
}

/** The session's driver identity (owner↔contractor view toggle, 2026-08-12).
 *  Resolves through auth-server's effectiveDriverIdentity so owner/admin
 *  sessions with a driver identity (their own towbook_driver_id — shape a — or
 *  a linked driver — shape b) can drive the full contractor flow. Returns null
 *  for signed-out / no-driver-identity / deactivated-linked-driver sessions.
 *  Handler-only private helper — safe to dynamic-import server-only modules
 *  (client-graph rule); u.id/u.role remain the REAL session actor for audit
 *  attribution, identity.userRowId/towbookDriverId the effective driver. */
async function resolveEffectiveDriver(): Promise<{ u: { id: string; orgId: string; role: string }; identity: DriverIdentityInfo } | null> {
  const { currentUser, effectiveDriverIdentity } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return null;
  const identity = await effectiveDriverIdentity(u);
  if (!identity || identity.deactivated) return null;
  return { u: { id: u.id, orgId: u.orgId, role: u.role }, identity };
}

/* ----------------------------------- Towbook HTTP ----------------------------------- */

const TOWBOOK_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const driverHeaders = (cookie: string) => ({
  "user-agent": TOWBOOK_UA,
  accept: "application/json,text/plain,*/*",
  "accept-language": "en-US,en;q=0.9",
  cookie,
});
type TbRes = { ok: boolean; status: number | null; body: unknown };
/** Private (b15211c surface) — the driver portal's own Towbook HTTP path for
 *  identifyDriver/driverCheckin/driverCheckout. The geofence engine uses the
 *  exported copy in driver-gps-core.ts; this module is client-reachable, so no
 *  server-only import may be referenced by its exported plain functions. */
async function tbFetch(fetchImpl: typeof fetch, url: string, session: DriverSession, init?: { method?: string; body?: string }): Promise<TbRes> {
  try {
    const res = await fetchImpl(url, {
      method: init?.method ?? "GET",
      headers: init?.method === "POST" || init?.method === "PUT"
        ? { ...driverHeaders(session.cookies), "content-type": "application/json" }
        : driverHeaders(session.cookies),
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
      ...(init?.body ? { body: init.body } : {}),
    });
    const text = await res.text();
    let body: unknown = text;
    if (text) { try { body = JSON.parse(text); } catch { /* keep raw text */ } }
    return { ok: res.status >= 200 && res.status < 300, status: res.status, body };
  } catch (err) {
    return { ok: false, status: null, body: String(err).slice(0, 200) };
  }
}
/** True when a response means the session cookie is dead (401/403, or a 200
 *  that is actually the login page HTML — the MVC login form fingerprint). */
const isExpired = (r: TbRes): boolean =>
  r.status === 401 || r.status === 403 ||
  (r.status === 200 && typeof r.body === "string" && /<form/i.test(r.body) && /RequestVerificationToken/i.test(r.body));

/* --------------------------------- identity resolution --------------------------------- */

export type IdentityResult =
  | { ok: true; identity: DriverIdentity }
  | { ok: false; expired?: boolean; message: string };

/** After a successful Towbook login: GET /api/user (the current user) and
 *  GET /api/drivers (the roster) with the fresh session, then find the driver
 *  record that belongs to that user (linkedUserId match, name-match fallback).
 *  Returns the Towbook USER id (checkin id) AND DRIVER id (assignment key). */
export async function identifyDriver(session: DriverSession, opts: { fetchImpl?: typeof fetch } = {}): Promise<IdentityResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const me = await tbFetch(fetchImpl, `${session.baseUrl}/api/user`, session);
  if (isExpired(me)) return { ok: false, expired: true, message: "Your session was rejected — sign in again." };
  if (!me.ok || !me.body || typeof me.body !== "object") return { ok: false, message: "Sign-in didn't return your account — try again." };
  const userObj = me.body as Record<string, unknown>;
  const userId = userObj.id != null ? String(userObj.id) : "";
  const userName = typeof userObj.name === "string" ? userObj.name.trim() : "";
  if (!userId) return { ok: false, message: "Sign-in didn't return your account id — try again." };
  const roster = await tbFetch(fetchImpl, `${session.baseUrl}/api/drivers`, session);
  const drivers = Array.isArray(roster.body) ? (roster.body as Record<string, unknown>[]) : [];
  const byLinked = drivers.find((d) => d.linkedUserId != null && String(d.linkedUserId) === userId);
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const byName = !byLinked && userName ? drivers.find((d) => d.name != null && norm(String(d.name)) === norm(userName)) : undefined;
  const hit = byLinked ?? byName;
  if (!hit || hit.id == null) {
    return { ok: false, message: "Your login isn't linked to a driver record on this account — contact dispatch." };
  }
  return {
    ok: true,
    identity: {
      userId,
      driverId: String(hit.id),
      driverName: typeof hit.name === "string" && hit.name.trim() ? hit.name.trim() : userName || `Driver ${hit.id}`,
    },
  };
}

/* --------------------------------- LD user + session persistence --------------------------------- */

/** Upsert the LD driver user: find by Towbook driver id, else by login handle
 *  (= the Towbook username), else create. Always role 'contractor' in the given
 *  org, login_handle = Towbook username, name from Towbook. The LD password
 *  hash is random and never usable — drivers authenticate through Towbook. */
async function upsertDriverUser(orgId: string, username: string, identity: DriverIdentity): Promise<{ userId: string; created: boolean }> {
  await ensure();
  const handle = username.trim().toLowerCase();
  const q = await db();
  const emailLike = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(handle);
  const email = emailLike ? handle : `${handle.replace(/[^a-z0-9._-]/g, "") || "driver"}@towbook.driver`;
  const existing = await q`SELECT u.id FROM users u WHERE u.towbook_driver_id=${identity.driverId} OR LOWER(u.login_handle)=${handle} LIMIT 1`;
  if (existing.length) {
    const userId = String(existing[0].id);
    await q`UPDATE users SET name=${identity.driverName}, towbook_driver_id=${identity.driverId}, towbook_user_id=${identity.userId} WHERE id=${userId}`;
    const memberships = await q`SELECT 1 FROM organization_memberships WHERE org_id=${orgId} AND user_id=${userId}`;
    if (!memberships.length) {
      await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${orgId}, ${userId}, 'contractor')`;
    }
    return { userId, created: false };
  }
  const { makeId, hash } = await import("./auth-server");
  const userId = makeId();
  const randomPassword = Math.random().toString(36).slice(2) + Date.now().toString(36);
  await q`INSERT INTO users(id, name, email, password_hash, login_handle, towbook_driver_id, towbook_user_id) VALUES(${userId}, ${identity.driverName}, ${email}, ${hash(randomPassword)}, ${handle}, ${identity.driverId}, ${identity.userId})`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${orgId}, ${userId}, 'contractor')`;
  return { userId, created: true };
}

/** Store (or refresh) the driver's encrypted Towbook session row:
 *  session_kind='driver', keyed by (org_id, towbook_driver_id). */
async function persistDriverSession(orgId: string, driverId: string, session: DriverSession): Promise<void> {
  await ensure();
  const q = await db();
  const { encryptSession } = await import("./towbook-key");
  await q`INSERT INTO towbook_sessions(org_id, encrypted_session, status, session_kind, towbook_driver_id, error, updated_at)
    VALUES(${orgId}, ${await encryptSession(JSON.stringify({ cookies: session.cookies, baseUrl: session.baseUrl }))}, 'connected', 'driver', ${driverId}, NULL, NOW())
    ON CONFLICT (org_id, towbook_driver_id) WHERE session_kind='driver' AND towbook_driver_id IS NOT NULL
    DO UPDATE SET encrypted_session=EXCLUDED.encrypted_session, status='connected', error=NULL, updated_at=NOW()`;
}

/** Load a driver's stored session from their LD user (role contractor +
 *  towbook_driver_id). Returns null when no session row exists. Lives in
 *  driver-gps-core.ts (server-only) — callers here dynamic-import it from
 *  inside serverFn handlers / handler-only private functions so the
 *  client-reachable module never statically references the decrypt path. */

/* --------------------------------- checkin / checkout --------------------------------- */

export type CheckinResult = { ok: boolean; warning: string | null };
/** POST /api/user/checkin {id, latitude, longitude} with the DRIVER's session.
 *  Denied geolocation (0,0) surfaces the "may not be dispatchable" warning; a
 *  failed POST also surfaces a warning — login itself never fails on checkin. */
export async function driverCheckin(session: DriverSession, userId: string, latitude: number, longitude: number, opts: { fetchImpl?: typeof fetch; locationDenied?: boolean } = {}): Promise<CheckinResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await tbFetch(fetchImpl, `${session.baseUrl}/api/user/checkin`, session, {
    method: "POST",
    body: JSON.stringify({ id: userId, latitude, longitude }),
  });
  if (!res.ok || isExpired(res)) return { ok: false, warning: "We couldn't check you in — you may not be dispatchable. Sign in again or check your connection." };
  if (opts.locationDenied || (latitude === 0 && longitude === 0)) return { ok: true, warning: "Location is off — you may not be dispatchable. Allow location access, then sign out and back in." };
  return { ok: true, warning: null };
}
/** Best-effort POST /api/user/checkout so a logout never leaves a driver
 *  "online" in Towbook. */
export async function driverCheckout(session: DriverSession, userId: string, opts: { fetchImpl?: typeof fetch } = {}): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  await tbFetch(fetchImpl, `${session.baseUrl}/api/user/checkout`, session, {
    method: "POST",
    body: JSON.stringify({ id: userId, latitude: 0, longitude: 0 }),
  });
}

/* --------------------------------- job queue --------------------------------- */

/** First contact (the real customer/member) on a Towbook call: `contacts` is an
 *  array of contact DTOs ({name, phone, ...}) or, in some shapes, a single
 *  object — mirrors server.ts firstContact (local copy: this module is
 *  client-reachable and must not import server-only helpers). */
function firstContact(call: Record<string, unknown>): Record<string, unknown> | null {
  const c = call.contacts;
  if (Array.isArray(c) && c.length) {
    const first = c[0];
    if (first && typeof first === "object" && !Array.isArray(first)) return first as Record<string, unknown>;
    return null;
  }
  if (c && typeof c === "object" && !Array.isArray(c)) return c as Record<string, unknown>;
  return null;
}
const pickString = (o: Record<string, unknown>, ...keys: string[]): string => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
};
/** Best available Towbook timestamp for a call (arrivalTime → enrouteTime →
 *  createDate → dispatchTime). Display-only semantics: "when the job was
 *  worked" — used by Earnings Today/Week + the per-job row time. */
function callUpdatedAt(call: Record<string, unknown>): string | null {
  for (const k of ["arrivalTime", "enrouteTime", "createDate", "dispatchTime"]) {
    const v = call[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/** Normalize one raw Towbook call into a driver card. Field names read directly
 *  from the real call object (evidence: api-calls-full.json). */
export function normalizeDriverCall(call: Record<string, unknown>): DriverCall | null {
  if (call.id == null) return null;
  const statusId = extractTowbookStatusId(call.status);
  if (statusId == null) return null;
  const waypoint = Array.isArray(call.waypoints) ? (call.waypoints[0] as Record<string, unknown> | undefined) : undefined;
  const asset = Array.isArray(call.assets) ? (call.assets[0] as Record<string, unknown> | undefined) : undefined;
  const color = asset && asset.color && typeof asset.color === "object" ? String((asset.color as Record<string, unknown>).name ?? "") : "";
  const vehicle = [asset?.year, asset?.make, asset?.model, color, asset?.vin].filter((v) => v != null && String(v) !== "").join(" ");
  const reason = call.reason && typeof call.reason === "object" ? String((call.reason as Record<string, unknown>).name ?? "") : "";
  const arrivalETA = typeof call.arrivalETA === "string" && call.arrivalETA ? call.arrivalETA : null;
  const contact = firstContact(call);
  const wLat = waypoint ? Number(waypoint.latitude) : NaN;
  const wLng = waypoint ? Number(waypoint.longitude) : NaN;
  return {
    id: String(call.id),
    callNumber: call.callNumber != null ? String(call.callNumber) : String(call.id),
    statusId,
    serviceName: reason || "Service call",
    pickupAddress: waypoint ? String(waypoint.address ?? "") : "",
    zip: waypoint ? String(waypoint.zip ?? "") : "",
    vehicle,
    arrivalETA,
    purchaseOrderNumber: call.purchaseOrderNumber != null ? String(call.purchaseOrderNumber) : null,
    customerName: contact ? pickString(contact, "name", "fullName", "contactName", "customerName", "displayName") : "",
    customerPhone: contact ? pickString(contact, "phone", "mobile", "telephone", "phoneNumber", "cell") : "",
    pickupLat: Number.isFinite(wLat) && wLat !== 0 ? wLat : null,
    pickupLng: Number.isFinite(wLng) && wLng !== 0 ? wLng : null,
    updatedAtIso: callUpdatedAt(call),
  };
}

export type QueueResult =
  | { ok: true; calls: DriverCall[] }
  | { ok: false; expired: boolean; message: string };

/** GET /api/calls with the driver's session. Server-side per-session scoping is
 *  expected; when other drivers' calls leak, filter to this driver's assignment. */
async function fetchDriverQueue(user: { orgId: string; towbookDriverId: string }, opts: { fetchImpl?: typeof fetch } = {}): Promise<QueueResult> {
  const { callHasDriver, loadDriverSession } = await import("./driver-gps-core");
  const session = await loadDriverSession(user);
  if (!session) return { ok: false, expired: true, message: "No active session — sign in again." };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await tbFetch(fetchImpl, `${session.baseUrl}/api/calls`, session);
  if (isExpired(res)) return { ok: false, expired: true, message: "Your session expired — reconnect to keep working." };
  if (!res.ok) return { ok: false, expired: false, message: `Couldn't load your jobs (HTTP ${res.status ?? "error"}). Try again.` };
  const raw = Array.isArray(res.body) ? (res.body as unknown[]) : [];
  const driverIdNum = Number(user.towbookDriverId);
  const scoped = raw.filter((c) => c && typeof c === "object" && callHasDriver(c, driverIdNum));
  const scopeApplies = raw.some((c) => c && typeof c === "object" && !callHasDriver(c, driverIdNum));
  const cards = (scopeApplies ? scoped : raw)
    .map((c) => normalizeDriverCall(c as Record<string, unknown>))
    .filter((c): c is DriverCall => c !== null);
  return { ok: true, calls: cards };
}

/* --------------------------------- status transitions --------------------------------- */

export type TransitionResult =
  | { ok: true; changed: boolean; statusId: number }
  | { ok: false; expired?: boolean; code: "invalid_state" | "unauthorized" | "towbook_failed" | "not_found" | "no_session"; message: string };

/** Thumbs-up (offered→accepted) / En route (accepted→en_route): PUT
 *  /api/calls/{id} {id, status:{id:N}} via the DRIVER's session, then
 *  write-through to LD dispatch_jobs (status_events + audit_log) so the owner
 *  and ops portals reflect it immediately. Idempotent: a re-tap on an
 *  already-applied transition is a no-op (never a double PUT). Only the
 *  assigned driver can act (assets[].driver.id check). user = the EFFECTIVE
 *  driver identity; actor = the real session user for audit attribution
 *  (owner-confirmed Q4: owner-as-driver actions write status_events under the
 *  owner's user id with a "(owner in driver view)" note suffix). */
async function applyDriverTransition(
  user: { orgId: string; userId: string; towbookDriverId: string },
  actor: { userId: string; role: string; ownerInDriverView: boolean },
  callId: string,
  action: DriverJobAction,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<TransitionResult> {
  const toStatus = STATUS_ID_FOR_ACTION[action];
  const { callHasDriver, loadDriverSession } = await import("./driver-gps-core");
  const session = await loadDriverSession(user);
  if (!session) return { ok: false, expired: true, code: "no_session", message: "No active session — reconnect to keep working." };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const numericId = Number(callId);
  const idForBody = Number.isInteger(numericId) && numericId > 0 ? numericId : callId;
  const callRes = await tbFetch(fetchImpl, `${session.baseUrl}/api/calls/${callId}`, session);
  if (isExpired(callRes)) return { ok: false, expired: true, code: "no_session", message: "Your session expired — reconnect to keep working." };
  if (!callRes.ok || !callRes.body || typeof callRes.body !== "object") {
    return { ok: false, code: "not_found", message: `Job ${callId} was not found on your account.` };
  }
  const call = callRes.body as Record<string, unknown>;
  const currentId = extractTowbookStatusId(call.status);
  if (currentId === toStatus) return { ok: true, changed: false, statusId: toStatus }; // re-tap → no-op
  if (currentId == null) return { ok: false, code: "invalid_state", message: "The job didn't report a status — refresh and try again." };
  if (!callHasDriver(call, Number(user.towbookDriverId))) {
    return { ok: false, code: "unauthorized", message: "This job is not assigned to you." };
  }
  const required = toStatus === 2 ? 1 : 2; // accept needs offered; en-route needs accepted
  if (currentId !== required) {
    const label = toStatus === 2 ? "accept" : "go en route";
    return { ok: false, code: "invalid_state", message: `This job cannot be ${label}ed from its current status.` };
  }
  const put = await tbFetch(fetchImpl, `${session.baseUrl}/api/calls/${callId}`, session, {
    method: "PUT",
    body: JSON.stringify({ id: idForBody, status: { id: toStatus } }),
  });
  if (isExpired(put)) return { ok: false, expired: true, code: "no_session", message: "Your session expired — reconnect to keep working." };
  if (!put.ok) return { ok: false, code: "towbook_failed", message: `The update was rejected (HTTP ${put.status ?? "error"}). Try again.` };
  await writeThrough(user, actor, callId, call, toStatus);
  return { ok: true, changed: true, statusId: toStatus };
}

const actionLabel = (toStatus: number) => (toStatus === 2 ? "accepted" : "en route");

/** LD dispatch_jobs write-through: update (or import when the job has not been
 *  synced yet — the 30s sync re-confirms) + status_events + audit_log, matching
 *  the sync's transition policy. Never throws — the Towbook PUT already
 *  succeeded; the portal refresh catches up via the sync if this fails.
 *  user = the EFFECTIVE driver identity (scopes the dispatch_jobs row + Towbook
 *  attribution); actor = the real session user for status_events/audit
 *  attribution (owner-confirmed Q4). */
async function writeThrough(user: { orgId: string; towbookDriverId: string }, actor: { userId: string; role: string; ownerInDriverView: boolean }, callId: string, rawCall: Record<string, unknown>, toStatus: number): Promise<void> {
  try {
    await ensure();
    const mapped = STATUS_ID_TO_LIFECYCLE[toStatus];
    if (!mapped) return;
    const q = await db();
    const note = `driver ${actionLabel(toStatus)} (Lightning Dispatch)${actor.ownerInDriverView ? " (owner in driver view)" : ""}`;
    const existing = await q`SELECT id, status FROM dispatch_jobs WHERE org_id=${user.orgId} AND towbook_job_id=${callId} LIMIT 1`;
    const jobRowId = existing.length ? String(existing[0].id) : null;
    if (jobRowId) {
      const from = String(existing[0].status);
      if (from === mapped) return; // already current — nothing to record
      await q`UPDATE dispatch_jobs SET status=${mapped}, towbook_status=${String(toStatus)} WHERE id=${jobRowId} AND org_id=${user.orgId}`;
      await q`INSERT INTO status_events(id, org_id, job_id, from_status, to_status, actor_user_id, actor_role, note)
        SELECT gen_random_uuid()::text, ${user.orgId}, ${jobRowId}, ${from}, ${mapped}, ${actor.userId}, ${actor.role}, ${note}`;
      await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
        SELECT gen_random_uuid()::text, ${user.orgId}, ${actor.userId}, ${actor.role}, 'driver_status_change', 'job', ${jobRowId}, ${JSON.stringify({ towbookJobId: callId, from, to: mapped, statusId: toStatus, actorRole: actor.role })}::jsonb, 'driver-portal'`;
      return;
    }
    // First sighting: import like the sync would, then the transition.
    const waypoints = Array.isArray(rawCall.waypoints) ? rawCall.waypoints as Record<string, unknown>[] : [];
    const assets = Array.isArray(rawCall.assets) ? rawCall.assets as Record<string, unknown>[] : [];
    const account = rawCall.account && typeof rawCall.account === "object" ? rawCall.account as Record<string, unknown> : null;
    const asset = assets[0] ?? null;
    const vehicle = [asset?.year, asset?.make, asset?.model].filter((v) => v != null && String(v) !== "").join(" ");
    const customer = account ? String(account.company ?? account.name ?? "") : "";
    const pickup = waypoints[0] ? String(waypoints[0].address ?? "") : "";
    const dropoff = waypoints[1] ? String(waypoints[1].address ?? "") : "";
    const currentId = extractTowbookStatusId(rawCall.status);
    const currentMapped = currentId == null ? "new" : (STATUS_ID_TO_LIFECYCLE[currentId] ?? "new");
    const slug = callId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60);
    const newJobRowId = slug ? `tb-${slug}` : `tb-${Math.random().toString(36).slice(2, 10)}`;
    const wp0 = waypoints[0] as Record<string, unknown> | undefined;
    const wLat = wp0 ? Number(wp0.latitude) : NaN;
    const wLng = wp0 ? Number(wp0.longitude) : NaN;
    const pickupLat = Number.isFinite(wLat) && wLat !== 0 ? wLat : null;
    const pickupLng = Number.isFinite(wLng) && wLng !== 0 ? wLng : null;
    const assigned = assignedDriverFromRawCall(rawCall);
    await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, towbook_job_id, customer_phone, vehicle_desc, pickup, dropoff, towbook_status, raw_json, pickup_lat, pickup_lng, assigned_driver_towbook_id, assigned_driver_name)
      VALUES(${newJobRowId}, ${user.orgId}, ${customer || `Towbook job ${callId}`}, '', 0, 0, ${pickup || "Unknown"}, 'flatbed_tow', ${mapped}, NOW(), '', ${callId}, '', ${vehicle}, ${pickup}, ${dropoff}, ${String(toStatus)}, ${JSON.stringify({ sourceUrl: "driver-portal", ...rawCall })}::jsonb, ${pickupLat}, ${pickupLng}, ${assigned.towbookId ?? user.towbookDriverId}, ${assigned.name})`;
    await q`INSERT INTO status_events(id, org_id, job_id, from_status, to_status, actor_user_id, actor_role, note)
      SELECT gen_random_uuid()::text, ${user.orgId}, ${newJobRowId}, ${currentMapped}, ${mapped}, ${actor.userId}, ${actor.role}, ${note}`;
    await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
      SELECT gen_random_uuid()::text, ${user.orgId}, ${actor.userId}, ${actor.role}, 'driver_status_change', 'job', ${newJobRowId}, ${JSON.stringify({ towbookJobId: callId, from: currentMapped, to: mapped, statusId: toStatus, imported: true, actorRole: actor.role })}::jsonb, 'driver-portal'`;
  } catch { /* best-effort — the Towbook PUT already succeeded; sync reconciles */ }
}

/* --------------------------------- createServerFn wrappers --------------------------------- */

const passthrough = (x: unknown) => x;

export const driverLogin = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }) => {
  const v = z.object({
    username: z.string().min(1).max(256),
    password: z.string().min(1).max(256),
    latitude: z.number().nullable().optional(),
    longitude: z.number().nullable().optional(),
    locationDenied: z.boolean().optional(),
  }).safeParse(data);
  if (!v.success) return { ok: false as const, error: "Enter your dispatch username and password." };
  if (!configured()) return { ok: false as const, error: "Driver sign-in requires database mode." };
  const d = v.data;
  try {
    await ensure();
    const orgId = await resolveOwnerOrgId();
    if (!orgId) return { ok: false as const, error: "No owner workspace exists yet — set it up first." };
    const { towbookLogin } = await import("./towbook-login");
    const login = await towbookLogin(d.username, d.password);
    if (!login.ok) return { ok: false as const, error: login.error.message };
    const session: DriverSession = { cookies: login.cookies, baseUrl: login.baseUrl };
    const identity = await identifyDriver(session);
    if (!identity.ok) return { ok: false as const, error: identity.message };
    const { userId } = await upsertDriverUser(orgId, d.username, identity.identity);
    // Owner-directed guard (contractor edit/remove): a removed contractor must
    // not be able to sign in even with valid Towbook credentials — check BEFORE
    // persisting a session row or starting an LD session.
    const { isDriverDeactivated } = await import("./driver-gps-core");
    if (await isDriverDeactivated(orgId, identity.identity.driverId)) {
      return { ok: false as const, error: "This driver account was removed in Lightning Dispatch — contact the owner." };
    }
    await persistDriverSession(orgId, identity.identity.driverId, session);
    const lat = typeof d.latitude === "number" && Number.isFinite(d.latitude) ? d.latitude : 0;
    const lng = typeof d.longitude === "number" && Number.isFinite(d.longitude) ? d.longitude : 0;
    const checkin = await driverCheckin(session, identity.identity.userId, lat, lng, { locationDenied: Boolean(d.locationDenied) });
    const { startSession } = await import("./auth-server");
    await startSession(userId);
    return {
      ok: true as const,
      name: identity.identity.driverName,
      role: "contractor" as const,
      checkinWarning: checkin.warning,
    };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Driver sign-in failed. Try again." };
  }
});

export const driverLogout = createServerFn({ method: "POST" }).handler(async () => {
  if (!configured()) return { ok: true as const };
  const { currentUser, effectiveDriverIdentity } = await import("./auth-server");
  const u = await currentUser();
  try {
    // Best-effort Towbook checkout so a logout never leaves the driver online.
    // The checkin/checkout body id is the TOWBOOK user id (identity.userId),
    // not the LD user id — the two differ for every driver. Resolves the
    // EFFECTIVE driver (owner↔contractor view toggle): an owner who worked jobs
    // in driver view checks out their linked/own driver; LD logout still clears
    // the ONE sign-in session.
    if (u) {
      const identity = await effectiveDriverIdentity(u);
      if (identity && !identity.deactivated) {
        const q = await db();
        const rows = await q`SELECT towbook_driver_id, towbook_user_id FROM users WHERE id=${identity.userRowId}`;
        if (rows.length && rows[0].towbook_driver_id != null) {
          const { loadDriverSession } = await import("./driver-gps-core");
          const session = await loadDriverSession({ orgId: u.orgId, towbookDriverId: String(rows[0].towbook_driver_id) });
          if (session) await driverCheckout(session, String(rows[0].towbook_user_id ?? ""));
        }
      }
    }
  } catch { /* best-effort — LD logout must never fail because Towbook checkout failed */ }
  const { cookieValues, cookieName, legacyCookieNames, writeCookie } = await import("./auth-server");
  const tokens = await cookieValues(cookieName);
  if (tokens.length) { const q = await db(); for (const t of tokens) await q`DELETE FROM sessions WHERE id=${t}`; }
  await writeCookie(cookieName, "", 0);
  for (const legacy of legacyCookieNames) await writeCookie(legacy, "", 0);
  return { ok: true as const };
});

export const driverJobs = createServerFn({ method: "GET" }).handler(async () => {
  if (!configured()) return { ok: false as const, expired: false, message: "Driver queue requires database mode." };
  const ctx = await resolveEffectiveDriver();
  if (!ctx) return { ok: false as const, expired: false, message: "Sign in as a driver first." };
  try {
    await ensure();
    const driverId = ctx.identity.towbookDriverId;
    if (!driverId) return { ok: false as const, expired: true, message: "Your account isn't linked to a driver yet — reconnect." };
    return await fetchDriverQueue({ orgId: ctx.u.orgId, towbookDriverId: driverId });
  } catch {
    return { ok: false as const, expired: false, message: "Unable to load your jobs. Try again." };
  }
});

export const driverJobAction = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }) => {
  const v = z.object({ jobId: z.string().min(1).max(64), action: z.enum(["accept", "en_route"]) }).safeParse(data);
  if (!v.success) return { ok: false as const, code: "invalid_state", message: "Invalid job action." };
  if (!configured()) return { ok: false as const, code: "towbook_failed", message: "Driver actions require database mode." };
  const ctx = await resolveEffectiveDriver();
  if (!ctx) return { ok: false as const, code: "unauthorized", message: "Sign in as a driver first." };
  try {
    await ensure();
    return await applyDriverTransition(
      { orgId: ctx.u.orgId, userId: ctx.identity.userRowId, towbookDriverId: ctx.identity.towbookDriverId },
      { userId: ctx.u.id, role: ctx.u.role, ownerInDriverView: ctx.u.role !== "contractor" },
      v.data.jobId,
      v.data.action,
    );
  } catch {
    return { ok: false as const, code: "towbook_failed", message: "Unable to update the job. Try again." };
  }
});

/* ------------------------------- availability toggle ------------------------------- */
export type AvailabilityResult = { ok: boolean; message?: string };
/** GO/Offline pill (driver portal R2, lead interim 2026-08-11): a visible
 *  availability control that performs a real Towbook checkin/checkout with the
 *  driver's last known position. It NEVER blocks assignment — per the owner's
 *  dispatch directive the AI may still pick an offline driver, so this is a
 *  preference + Towbook presence signal, not a hard pool gate. Idempotent:
 *  re-toggling the same state is a harmless repeat of the checkin/checkout.
 *  Part 3 (owner-directed 2026-08-12) adds the COMPLIANCE GATE: going ONLINE
 *  is blocked until every required document is submitted AND approved
 *  (getComplianceGateCore in contractor-admin-core — the same read-time rules
 *  as the roster counts; facial-verification pairs need the live selfie too).
 *  The block message is white-label driver-facing copy pointing at the
 *  Documents screen. Owner-in-driver-view resolves to the same effective
 *  driver, so the gate is identical for staff driving the contractor app.
 *  Going OFFLINE is never blocked. */
export const driverSetAvailability = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<AvailabilityResult> => {
  const v = z.object({ online: z.boolean() }).safeParse(data);
  if (!v.success) return { ok: false as const, message: "Invalid availability value." };
  if (!configured()) return { ok: false as const, message: "Availability requires database mode." };
  const ctx = await resolveEffectiveDriver();
  if (!ctx) return { ok: false as const, message: "Sign in as a driver first." };
  try {
    await ensure();
    if (v.data.online) {
      // Compliance gate FIRST — no Towbook call, no checkin, until approved.
      const { getComplianceGateCore } = await import("./contractor-admin-core");
      const gate = await getComplianceGateCore({ orgId: ctx.u.orgId, id: ctx.identity.userRowId, role: "contractor" });
      if (!gate.ok) return { ok: false as const, message: gate.message };
    }
    const q = await db();
    const rows = await q`SELECT towbook_driver_id, towbook_user_id FROM users WHERE id=${ctx.identity.userRowId}`;
    const driverId = rows.length ? String(rows[0].towbook_driver_id ?? "") : "";
    const towbookUserId = rows.length ? String(rows[0].towbook_user_id ?? "") : "";
    if (!driverId) return { ok: false as const, message: "Your account isn't linked to a driver yet — reconnect." };
    const { loadDriverSession } = await import("./driver-gps-core");
    const session = await loadDriverSession({ orgId: ctx.u.orgId, towbookDriverId: driverId });
    if (!session) return { ok: false as const, message: "No active session — sign in again." };
    if (v.data.online) {
      const loc = await q`SELECT latitude, longitude FROM driver_locations WHERE org_id=${ctx.u.orgId} AND driver_id=${ctx.identity.userRowId} ORDER BY captured_at DESC LIMIT 1`;
      const lat = loc.length && Number.isFinite(Number(loc[0].latitude)) ? Number(loc[0].latitude) : 0;
      const lng = loc.length && Number.isFinite(Number(loc[0].longitude)) ? Number(loc[0].longitude) : 0;
      const checkin = await driverCheckin(session, towbookUserId, lat, lng, { locationDenied: lat === 0 && lng === 0 });
      return { ok: checkin.ok, ...(checkin.warning ? { message: checkin.warning } : {}) };
    }
    await driverCheckout(session, towbookUserId);
    return { ok: true as const };
  } catch {
    return { ok: false as const, message: "Unable to update availability. Try again." };
  }
});

/* ------------------------------- earnings + profile ------------------------------- */
export type DriverEarningsTip = {
  jobId: string;
  callNumber: string | null;
  customerName: string | null;
  amountCents: number;
  currency: string;
  status: string;
  /** When the tip row was last updated (job_completions.updated_at) — powers
   *  the Earnings Today/Week toggle. ISO string; absent → null. */
  createdAtIso: string | null;
};
export type DriverEarningsResult =
  | { ok: true; profile: { name: string; email: string; towbookDriverId: string; payrateCents: number | null }; completed: DriverCall[]; tips: DriverEarningsTip[]; totals: { completedJobs: number; tipsTotalCents: number; tipCount: number } }
  | { ok: false; expired: boolean; message: string };
/** The driver-facing email: real addresses are shown; derived @towbook.driver
 *  placeholders are internal-only and must never reach a driver's screen
 *  (white-label, 2026-08-12 — drivers never see the backend brand or its
 *  internal addressing scheme). */
function driverFacingEmail(email: unknown): string {
  const s = email != null ? String(email) : "";
  return s.toLowerCase().endsWith("@towbook.driver") ? "" : s;
}
/** Driver earnings: completed calls (from the Towbook queue) + tips attributed
 *  to this driver (job_completions.tip->>'driver_towbook_id'). Contractor-only.
 *  Tips are accounted separately from card payments — per the owner's payments
 *  spec, tips reconcile to the specific driver. */
export const driverEarnings = createServerFn({ method: "GET" }).handler(async (): Promise<DriverEarningsResult> => {
  if (!configured()) return { ok: false as const, expired: false, message: "Driver earnings require database mode." };
  const ctx = await resolveEffectiveDriver();
  if (!ctx) return { ok: false as const, expired: false, message: "Sign in as a driver first." };
  try {
    await ensure();
    const q = await db();
    // Payrate joins contractor_profiles (part 1/3) so the Earnings screen can
    // show "+$rate" per completed job and the honest per-job math.
    const rows = await q`SELECT u.name, u.email, u.towbook_driver_id, cp.payrate_cents
      FROM users u LEFT JOIN contractor_profiles cp ON cp.org_id = ${ctx.u.orgId} AND cp.user_id = u.id
      WHERE u.id=${ctx.identity.userRowId}`;
    const driverId = rows.length ? String(rows[0].towbook_driver_id ?? "") : "";
    if (!driverId) return { ok: false as const, expired: true, message: "Your account isn't linked to a driver yet — reconnect." };
    const queue = await fetchDriverQueue({ orgId: ctx.u.orgId, towbookDriverId: driverId });
    if (!queue.ok) return queue;
    const completed = queue.calls.filter((c) => c.statusId === 5 || c.statusId === 6);
    const tipRows = await q`
      SELECT jc.job_id, jc.tip, jc.updated_at, d.towbook_job_id, d.customer_name
      FROM job_completions jc LEFT JOIN dispatch_jobs d ON d.id = jc.job_id AND d.org_id = jc.org_id
      WHERE jc.org_id = ${ctx.u.orgId} AND jc.tip IS NOT NULL AND jc.tip->>'driver_towbook_id' = ${driverId}
      ORDER BY jc.updated_at DESC`;
    const tips: DriverEarningsTip[] = [];
    for (const r of tipRows as Record<string, unknown>[]) {
      const tip = typeof r.tip === "object" && r.tip != null ? (r.tip as Record<string, unknown>) : {};
      const amountCents = Number(tip.amount_cents ?? 0);
      if (!Number.isFinite(amountCents) || amountCents <= 0) continue;
      tips.push({
        jobId: String(r.job_id ?? ""),
        callNumber: r.towbook_job_id != null ? String(r.towbook_job_id) : null,
        customerName: r.customer_name != null ? String(r.customer_name) : null,
        amountCents,
        currency: String(tip.currency ?? "USD"),
        status: String(tip.status ?? "unknown"),
        createdAtIso: r.updated_at != null ? new Date(String(r.updated_at)).toISOString() : null,
      });
    }
    const tipsTotalCents = tips.reduce((s, t) => s + t.amountCents, 0);
    return {
      ok: true as const,
      profile: {
        name: String(rows[0].name ?? ""),
        email: driverFacingEmail(rows[0].email),
        towbookDriverId: driverId,
        payrateCents: rows[0].payrate_cents != null ? Number(rows[0].payrate_cents) : null,
      },
      completed,
      tips,
      totals: { completedJobs: completed.length, tipsTotalCents, tipCount: tips.length },
    };
  } catch {
    return { ok: false as const, expired: false, message: "Unable to load your earnings. Try again." };
  }
});
export type DriverProfileResult =
  | { ok: true; name: string; email: string; towbookDriverId: string }
  | { ok: false; message: string };
/** Driver profile: the LD user row behind the contractor session (no Towbook
 *  call — cheap for the profile tab). */
export const driverProfile = createServerFn({ method: "GET" }).handler(async (): Promise<DriverProfileResult> => {
  if (!configured()) return { ok: false as const, message: "Driver profile requires database mode." };
  const ctx = await resolveEffectiveDriver();
  if (!ctx) return { ok: false as const, message: "Sign in as a driver first." };
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT name, email, towbook_driver_id FROM users WHERE id=${ctx.identity.userRowId}`;
    if (!rows.length) return { ok: false as const, message: "Driver account not found." };
    return {
      ok: true as const,
      name: String(rows[0].name ?? ""),
      email: driverFacingEmail(rows[0].email),
      towbookDriverId: String(rows[0].towbook_driver_id ?? ""),
    };
  } catch {
    return { ok: false as const, message: "Unable to load your profile. Try again." };
  }
});
