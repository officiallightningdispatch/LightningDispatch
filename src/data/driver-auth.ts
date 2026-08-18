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
  /** Authoritative vehicle attributes from the assigned Towbook asset; null when absent. */
  vehicleYear: string | null;
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehicleDutySignal: string | null;
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
  /** Towbook completionTime, authoritative for payday windows. */
  completedAtIso: string | null;
  /** Service-time live counter data (completion-goals-spec.md, owner-directed
   *  2026-08-13): arrival moment for the running mm:ss timer + the owner's
   *  goal for this service. arrivedAtIso is the SERVER timestamp (LD
   *  dispatch_jobs.arrived_at, falling back to the raw Towbook arrivalTime) —
   *  never local clock drift. goalSeconds = org service_time_goals lookup
   *  (battery installs resolve standard/advanced from battery_sales); null
   *  when the service has no goal (counter shows elapsed without a target).
   *  Filled server-side in fetchDriverQueue. */
  arrivedAtIso: string | null;
  goalSeconds: number | null;
  serviceKey: string | null;
};
export type DriverJobAction = "accept" | "en_route";
/* LD action → Towbook status id. CORRECTED 2026-08-12 (owner-reported bug):
 * Towbook's real statuses are 0 Received, 1 Dispatched, 2 En Route, 3 On
 * Scene, 4 Towing, 5 Complete, 7 Arrived (verified in the dispatch editor's
 * statusTimes mapping). Accept now performs accept→en_route in ONE step
 * (owner 2026-08-12: "Accept & go") — both actions target Towbook 2 (En
 * Route); the separate en_route action remains as a manual fallback. */
const STATUS_ID_FOR_ACTION: Record<DriverJobAction, number> = { accept: 2, en_route: 2 };

/* ------------------------- local copies of Towbook helpers ------------------------- */
/** Mirrors server.ts TOWBOOK_STATUS_ID_TO_LIFECYCLE (corrected 2026-08-12:
 *  Towbook 1=Dispatched→accepted, 2=En Route→en_route, 3=On Scene→arrived,
 *  4=Towing→arrived, 5=Complete→completed, 7=Arrived→arrived; 252 completed,
 *  255 cancelled — owner-reported status-sync bug, recon-verified). */
const STATUS_ID_TO_LIFECYCLE: Readonly<Record<number, string>> = {
  0: "new", 1: "accepted", 2: "en_route", 3: "arrived", 4: "arrived", 5: "completed",
  7: "arrived", 252: "completed", 255: "cancelled",
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
  // Owner sign-in must land in the real (non-QA) workspace. QA fixture orgs
  // (qa-lifecycle.mjs) all carry an owner membership, so a bare `LIMIT 1`
  // returns whichever row the planner hits first — live incident 2026-08-13:
  // owner login landed in `qa-completion-8bc5783d…`, so every org-scoped
  // query (required doc types, contractor docs) ran against an empty QA org.
  // Deterministic: prefer a non-`qa-` org, oldest-created first; fall back to
  // any owner org (tests with only QA orgs).
  const rows = await q`SELECT org_id FROM organization_memberships WHERE role='owner' AND org_id NOT LIKE 'qa-%' ORDER BY org_id LIMIT 1`;
  if (rows.length) return String(rows[0].org_id);
  const fallback = await q`SELECT org_id FROM organization_memberships WHERE role='owner' ORDER BY org_id LIMIT 1`;
  return fallback.length ? String(fallback[0].org_id) : null;
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
  | { ok: true; kind: "driver"; identity: DriverIdentity; rosterFallback: boolean }
  | { ok: true; kind: "owner"; user: { userId: string; name: string } }
  | { ok: false; expired?: boolean; message: string };

/** The Towbook account TYPE (owner-directed 2026-08-12 role mapping): 1 =
 *  driver, 2 = manager/dispatcher, 3 = driver (owner-corrected 2026-08-13:
 *  type is a CATEGORY, not a status — type 3 is a normal driver account, e.g.
 *  Jayden Fountain 803825 type:3 disabled:false; the real status field is the
 *  separate `disabled` boolean). Recon evidence
 *  /home/team/shared/towbook-recon-evidence/users.json + api-user.json —
 *  /api/user carries `type`; the /api/users list carries it too. Null when the
 *  field is absent or non-numeric. */
function accountTypeOf(o: Record<string, unknown>): number | null {
  const t = o.type;
  if (t == null) return null;
  const n = typeof t === "number" ? t : Number(t);
  return Number.isFinite(n) ? n : null;
}
/** Towbook's `disabled` STATUS boolean (owner-corrected 2026-08-13): the only
 *  field that gates sign-in. Absent/false → ACTIVE; anything undeterminable is
 *  treated as NOT disabled (a missing status must never dead-end a driver).
 *  Strict on the value so a string "false" can never disable an account. */
function disabledOf(o: Record<string, unknown>): boolean {
  const d = o.disabled;
  return d === true || d === 1 || d === "1" || d === "true";
}
/** Account metadata resolved from GET /api/users (the LIST — the ONLY Towbook
 *  response that carries the `disabled` status; /api/user never does, verified
 *  live 2026-08-13). */
type AccountMeta = { type: number | null; disabled: boolean };
/** Resolve account type + `disabled` status from GET /api/users (the list),
 *  matched by user id. Returns null when the list call fails or the user is
 *  absent — callers then keep the /api/user type and treat disabled as false
 *  (the legacy default, never a new dead-end). */
async function lookupAccountMeta(session: DriverSession, userId: string, fetchImpl: typeof fetch): Promise<AccountMeta | null> {
  const res = await tbFetch(fetchImpl, `${session.baseUrl}/api/users`, session);
  if (!Array.isArray(res.body)) return null;
  for (const u of res.body as Record<string, unknown>[]) {
    if (u && typeof u === "object" && u.id != null && String(u.id) === userId) {
      return { type: accountTypeOf(u), disabled: disabledOf(u) };
    }
  }
  return null;
}

/** After a successful Towbook login: GET /api/user (the current user) and read
 *  the account TYPE — the Towbook account type is authoritative for the portal
 *  role (owner-directed 2026-08-12); the account STATUS is the separate
 *  `disabled` boolean (owner-corrected 2026-08-13 — type 3 is a NORMAL driver
 *  category, NOT disabled; /api/user never carries `disabled`, so it is read
 *  from the /api/users LIST, which does):
 *    disabled:true → refused ("contact the owner") — the ONLY status refusal.
 *    type 2 (manager/dispatcher) → owner portal: no roster resolution, no
 *      checkin — the caller upserts an owner user and returns role "owner".
 *    type 1 (driver) OR type 3 (driver) → contractor portal: resolve the roster
 *      driver record (linkedUserId match, name-match fallback) to obtain the
 *      driver id. A type-1/3 account is NEVER rejected for missing a roster
 *      record — the driver id falls back to the Towbook USER id
 *      (rosterFallback: true).
 *    unknown type (non-null, not 1/2/3) → refused ("contact dispatch").
 *  When the type/status cannot be determined at all (no `type` on /api/user,
 *  list call failed, or user absent from the list), default to the driver flow —
 *  the pre-mapping behavior, so nothing that worked before regresses. Returns
 *  the Towbook USER id (checkin id) AND DRIVER id (assignment key) on the
 *  driver path. */
export async function identifyDriver(session: DriverSession, opts: { fetchImpl?: typeof fetch } = {}): Promise<IdentityResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const me = await tbFetch(fetchImpl, `${session.baseUrl}/api/user`, session);
  if (isExpired(me)) return { ok: false, expired: true, message: "Your session was rejected — sign in again." };
  if (!me.ok || !me.body || typeof me.body !== "object") return { ok: false, message: "Sign-in didn't return your account — try again." };
  const userObj = me.body as Record<string, unknown>;
  const userId = userObj.id != null ? String(userObj.id) : "";
  const userName = typeof userObj.name === "string" ? userObj.name.trim() : "";
  if (!userId) return { ok: false, message: "Sign-in didn't return your account id — try again." };
  // STATUS gate: the `disabled` BOOLEAN (owner-corrected 2026-08-13). Type is a
  // category, not a status; /api/user never carries `disabled`, so it is always
  // resolved from the /api/users list. Undeterminable (list failed / user
  // absent) → NOT disabled — a missing status must never refuse a driver.
  const meta = await lookupAccountMeta(session, userId, fetchImpl);
  const type = accountTypeOf(userObj) ?? meta?.type ?? null;
  if (meta?.disabled === true) return { ok: false, message: "This account is disabled — contact the owner." };
  if (type === 2) {
    return { ok: true, kind: "owner", user: { userId, name: userName || "Lightning Dispatch" } };
  }
  // A non-null type that is not 1/2/3 is an unrecognized account type → refuse.
  // Type 3 is a NORMAL driver account (disabled:false) → contractor flow.
  // Null (type undeterminable: no `type` on /api/user AND the /api/users
  // fallback failed) defaults to the driver flow — the pre-mapping behavior.
  if (type != null && type !== 1 && type !== 3) return { ok: false, message: "Account type not recognized — contact dispatch." };
  // Type 1 or 3 (driver) — or type undeterminable (legacy default). Roster resolution.
  const roster = await tbFetch(fetchImpl, `${session.baseUrl}/api/drivers`, session);
  const drivers = Array.isArray(roster.body) ? (roster.body as Record<string, unknown>[]) : [];
  const byLinked = drivers.find((d) => d.linkedUserId != null && String(d.linkedUserId) === userId);
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const byName = !byLinked && userName ? drivers.find((d) => d.name != null && norm(String(d.name)) === norm(userName)) : undefined;
  const hit = byLinked ?? byName;
  if (hit && hit.id != null) {
    return {
      ok: true,
      kind: "driver",
      rosterFallback: false,
      identity: {
        userId,
        driverId: String(hit.id),
        driverName: typeof hit.name === "string" && hit.name.trim() ? hit.name.trim() : userName || `Driver ${hit.id}`,
      },
    };
  }
  // No roster match — a type-1 driver must NEVER get the old "not linked to a
  // driver record" dead-end (owner mandate 2026-08-12). Resolve the driver id
  // pragmatically to the Towbook USER id (flagged rosterFallback). This cannot
  // break job assignment: the AI dispatcher picks drivers from the Towbook
  // roster (/api/drivers) so a fabricated id never enters that pool; the job
  // queue scoped by this id matches no calls (empty queue, never wrong jobs);
  // checkin/checkout use the Towbook USER id either way. Verified 2026-08-12:
  // user ids (116012–822857) and roster driver ids (103335–717660) do not
  // overlap, so the fallback id cannot collide with a real driver.
  return {
    ok: true,
    kind: "driver",
    rosterFallback: true,
    identity: { userId, driverId: userId, driverName: userName || `Driver ${userId}` },
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
  const existing = await q`SELECT u.id FROM users u WHERE u.towbook_driver_id=${identity.driverId} OR u.towbook_user_id=${identity.userId} OR LOWER(u.login_handle)=${handle} LIMIT 1`;
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

/** persistDriverSession lives in driver-gps-core.ts (server-only) — callers
 *  here dynamic-import it from inside serverFn handler bodies (client-graph
 *  rule: a plain export in this client-reachable module must never
 *  dynamic-import towbook-key/auth-server). */

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
/** The raw Towbook arrival timestamp ONLY (no enroute/create fallbacks) — the
 *  live counter's fallback arrival moment when LD dispatch_jobs.arrived_at is
 *  missing (completion-goals-spec.md: counter ticks from the SERVER timestamp).
 *  The driver queue enrichment prefers dispatch_jobs.arrived_at and only falls
 *  back to this. */
function callArrivalAt(call: Record<string, unknown>): string | null {
  const v = call["arrivalTime"];
  return typeof v === "string" && v ? v : null;
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
    vehicleYear: asset?.year != null ? String(asset.year) : null,
    vehicleMake: asset?.make != null ? String(asset.make) : null,
    vehicleModel: asset?.model != null ? String(asset.model) : null,
    vehicleDutySignal: asset?.vehicleClass != null ? String(asset.vehicleClass) : (asset?.weightClass != null ? String(asset.weightClass) : null),
    arrivalETA,
    purchaseOrderNumber: call.purchaseOrderNumber != null ? String(call.purchaseOrderNumber) : null,
    customerName: contact ? pickString(contact, "name", "fullName", "contactName", "customerName", "displayName") : "",
    customerPhone: contact ? pickString(contact, "phone", "mobile", "telephone", "phoneNumber", "cell") : "",
    pickupLat: Number.isFinite(wLat) && wLat !== 0 ? wLat : null,
    pickupLng: Number.isFinite(wLng) && wLng !== 0 ? wLng : null,
    updatedAtIso: callUpdatedAt(call),
    completedAtIso: typeof call.completionTime === "string" ? call.completionTime : null,
    arrivedAtIso: callArrivalAt(call),
    goalSeconds: null,
    serviceKey: null,
  };
}

export type QueueResult =
  | { ok: true; calls: DriverCall[] }
  | { ok: false; expired: boolean; message: string };

/** LD status → driver-portal statusId (mirror of STATUS_ID_TO_LIFECYCLE for
 *  platform-only jobs: the battery-install job created on a paid battery sale
 *  has NO Towbook call — it lives only in dispatch_jobs). 1=offer (Accept),
 *  2=en route, 3=on scene, 5=completed, 255=cancelled. */
const LD_STATUS_TO_ID: Readonly<Record<string, number>> = {
  new: 1, offered: 1, accepted: 2, en_route: 2, arrived: 3, completed: 5, cancelled: 255,
};

/** Platform-created jobs (towbook_job_id IS NULL — e.g. the auto-created
 *  "Battery installation" job from a paid battery sale, owner-spec'd 2026-08-13)
 *  merged into the driver queue so they appear in the contractor's app
 *  immediately. Card shape mirrors normalizeDriverCall. */
async function platformOnlyCalls(user: { orgId: string; towbookDriverId: string }): Promise<DriverCall[]> {
  try {
    const q = await db();
    const rows = await q`SELECT id, status, customer_name, phone, area, pickup, pickup_lat, pickup_lng, vehicle_desc, note, service_type, created_at, completed_at, arrived_at, assigned_at
      FROM dispatch_jobs
      WHERE org_id=${user.orgId} AND towbook_job_id IS NULL AND assigned_driver_towbook_id=${user.towbookDriverId}
      ORDER BY created_at DESC LIMIT 100`;
    return (rows as Record<string, unknown>[]).map((r) => {
      const statusId = LD_STATUS_TO_ID[String(r.status ?? "new")] ?? 1;
      const lat = Number(r.pickup_lat ?? 0);
      const lng = Number(r.pickup_lng ?? 0);
      const serviceType = String(r.service_type ?? "");
      const arrivedAt = r.arrived_at != null ? new Date(String(r.arrived_at)).toISOString() : null;
      return {
        id: String(r.id),
        callNumber: String(r.id),
        statusId,
        serviceName: serviceType === "battery_install" ? "Battery installation" : "Service job",
        pickupAddress: String(r.pickup ?? r.area ?? ""),
        zip: "",
        vehicle: String(r.vehicle_desc ?? ""),
        vehicleYear: null,
        vehicleMake: null,
        vehicleModel: null,
        vehicleDutySignal: null,
        arrivalETA: null,
        purchaseOrderNumber: null,
        customerName: String(r.customer_name ?? ""),
        customerPhone: String(r.phone ?? ""),
        pickupLat: Number.isFinite(lat) && lat !== 0 ? lat : null,
        pickupLng: Number.isFinite(lng) && lng !== 0 ? lng : null,
        updatedAtIso: r.completed_at != null ? new Date(String(r.completed_at)).toISOString() : new Date(String(r.created_at)).toISOString(),
        completedAtIso: r.completed_at != null ? new Date(String(r.completed_at)).toISOString() : null,
        arrivedAtIso: arrivedAt,
        goalSeconds: null,
        serviceKey: null,
      };
    });
  } catch {
    return []; // platform jobs must never break the Towbook queue
  }
}

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
  const towbookCards = (scopeApplies ? scoped : raw)
    .map((c) => normalizeDriverCall(c as Record<string, unknown>))
    .filter((c): c is DriverCall => c !== null);
  const platformCards = await platformOnlyCalls(user); // battery-install etc.
  const seen = new Set(towbookCards.map((c) => c.id));
  const merged = [...towbookCards, ...platformCards.filter((c) => !seen.has(c.id))];
  return { ok: true, calls: await attachServiceTime(user, merged) };
}
/** Service-time live counter enrichment (completion-goals-spec.md §1, §5):
 *  for every ARRIVED-state call (statusId 3 on scene / 4 towing) attach the
 *  arrival moment + the org's service-time goal. arrival = dispatch_jobs
 *  .arrived_at (SERVER timestamp — never local clock drift) with the raw
 *  Towbook arrivalTime as fallback; goal = org service_time_goals via
 *  service-time-core's pure lookup (battery installs resolve standard/advanced
 *  from Phase 1's battery_sales.install_type). Best-effort: any DB hiccup
 *  leaves the queue fully functional with nulls (counter hidden). */
async function attachServiceTime(user: { orgId: string }, calls: DriverCall[]): Promise<DriverCall[]> {
  const active = calls.filter((c) => c.statusId === 3 || c.statusId === 4);
  if (!active.length) return calls;
  try {
    const q = await db();
    const ids = active.map((c) => c.id);
    const [goalRows, variantRows, arrivalRows] = await Promise.all([
      q`SELECT service_type, variant, goal_seconds FROM service_time_goals WHERE org_id=${user.orgId}`,
      q`SELECT install_job_id, install_type FROM battery_sales WHERE org_id=${user.orgId} AND install_type IS NOT NULL AND install_job_id IS NOT NULL`,
      q`SELECT id, towbook_job_id, arrived_at, service_type FROM dispatch_jobs WHERE org_id=${user.orgId} AND (towbook_job_id = ANY(${ids}) OR id = ANY(${ids}))`,
    ]);
    const goals = (goalRows as Record<string, unknown>[]).map((r) => ({
      serviceType: String(r.service_type),
      variant: String(r.variant ?? ""),
      goalSeconds: Number(r.goal_seconds),
    }));
    const batteryVariantByJobId = new Map<string, string>();
    for (const r of variantRows as Record<string, unknown>[]) {
      if (r.install_job_id != null) batteryVariantByJobId.set(String(r.install_job_id), String(r.install_type));
    }
    const arrivalByJobId = new Map<string, { arrivedAtIso: string | null; serviceType: string | null }>();
    for (const r of arrivalRows as Record<string, unknown>[]) {
      const entry = {
        arrivedAtIso: r.arrived_at != null ? new Date(String(r.arrived_at)).toISOString() : null,
        serviceType: r.service_type != null ? String(r.service_type) : null,
      };
      if (r.id != null) arrivalByJobId.set(String(r.id), entry);
      if (r.towbook_job_id != null) arrivalByJobId.set(String(r.towbook_job_id), entry);
    }
    const { attachServiceTimeData } = await import("./service-time-core");
    const enriched = attachServiceTimeData(
      calls.map((c) => ({ id: c.id, statusId: c.statusId, serviceName: c.serviceName, ldServiceType: null, rawArrivalAtIso: c.arrivedAtIso })),
      goals,
      batteryVariantByJobId,
      arrivalByJobId,
    );
    return calls.map((c) => {
      const e = enriched.get(c.id);
      if (!e) return c;
      return { ...c, arrivedAtIso: e.arrivedAtIso ?? c.arrivedAtIso, goalSeconds: e.goalSeconds, serviceKey: e.serviceKey };
    });
  } catch {
    return calls; // never break the queue for counter data
  }
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
  // PLATFORM-ONLY jobs (towbook_job_id IS NULL — the auto-created "Battery
  // installation" job from a paid battery sale) have NO Towbook call: the
  // transition is applied to dispatch_jobs directly (owner-spec'd 2026-08-13).
  // accept: offered/new → en_route; en_route: en_route → arrived.
  {
    const q = await db();
    const ldRows = await q`SELECT id, status, towbook_job_id, assigned_driver_towbook_id
      FROM dispatch_jobs WHERE org_id=${user.orgId} AND id=${callId} LIMIT 1`;
    if (ldRows.length && ldRows[0].towbook_job_id == null) {
      const ldJob = ldRows[0] as Record<string, unknown>;
      const currentLd = String(ldJob.status ?? "");
      const assignedTo = ldJob.assigned_driver_towbook_id != null ? String(ldJob.assigned_driver_towbook_id) : "";
      if (assignedTo && assignedTo !== user.towbookDriverId) {
        return { ok: false, code: "unauthorized", message: "This job is not assigned to you." };
      }
      if (action === "accept") {
        const { enforceReservedZoneEligibility, containingZone } = await import("./reserved-zone-core");
        const zoneRows = await q`SELECT id, state, zone_type, lat, lng, radius_miles, polygon_geojson, zip_codes, is_reserved, unlock_jobs_required FROM dispatch_zones WHERE org_id=${user.orgId} AND active=TRUE`;
        const jobCoords = await q`SELECT lat, lng, pickup_lat, pickup_lng, area FROM dispatch_jobs WHERE id=${callId} AND org_id=${user.orgId} LIMIT 1`;
        const j = jobCoords[0] as any;
        const zone = j ? containingZone(zoneRows as any, Number(j.pickup_lat ?? j.lat), Number(j.pickup_lng ?? j.lng), String(j.area ?? "")) : null;
        const gate = await enforceReservedZoneEligibility(q, { orgId: user.orgId, userId: user.userId, towbookDriverId: user.towbookDriverId, zone, actorRole: actor.role, explicitOwnerOverride: actor.ownerInDriverView });
        if (zone && !gate.ok) return { ok: false, code: "invalid_state", message: gate.message };
      }
      const fromTo: Record<string, string | null> = { offered: "en_route", new: "en_route", en_route: "arrived" };
      const next = fromTo[currentLd] ?? null;
      if (next === null) {
        return { ok: false, code: "invalid_state", message: `This job cannot be ${action === "accept" ? "accepted" : "moved en route"} from its current status.` };
      }
      if (next === "arrived" && action !== "en_route") {
        return { ok: false, code: "invalid_state", message: "This job is already on the way." };
      }
      if (next === "en_route" && currentLd === "en_route") {
        return { ok: true, changed: false, statusId: 2 };
      }
      const note = `driver ${action === "accept" ? "accepted" : "en route"} (Lightning Dispatch platform job)${actor.ownerInDriverView ? " (owner in driver view)" : ""}`;
      await q`UPDATE dispatch_jobs SET status=${next}, assigned_at=COALESCE(assigned_at, NOW()),
        arrived_at=CASE WHEN ${next}='arrived' THEN NOW() ELSE arrived_at END
        WHERE id=${callId} AND org_id=${user.orgId}`;
      await q`INSERT INTO status_events(id, org_id, job_id, from_status, to_status, actor_user_id, actor_role, note)
        SELECT gen_random_uuid()::text, ${user.orgId}, ${callId}, ${currentLd}, ${next}, ${actor.userId}, ${actor.role}, ${note}`;
      try {
        await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
          SELECT gen_random_uuid()::text, ${user.orgId}, ${actor.userId}, ${actor.role}, 'driver_status_change', 'job', ${callId},
            ${JSON.stringify({ platformOnly: true, from: currentLd, to: next, actorRole: actor.role })}::jsonb, 'driver-portal'`;
      } catch { /* best-effort audit */ }
      return { ok: true, changed: true, statusId: next === "arrived" ? 3 : 2 };
    }
  }
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
  if (toStatus === 2) {
    const q = await db();
    const { enforceReservedZoneEligibility, containingZone } = await import("./reserved-zone-core");
    const zoneRows = await q`SELECT id, state, zone_type, lat, lng, radius_miles, polygon_geojson, zip_codes, is_reserved, unlock_jobs_required FROM dispatch_zones WHERE org_id=${user.orgId} AND active=TRUE`;
    const jobRows = await q`SELECT lat, lng, pickup_lat, pickup_lng, area FROM dispatch_jobs WHERE org_id=${user.orgId} AND (id=${callId} OR towbook_job_id=${callId}) LIMIT 1`;
    const j = jobRows[0] as any;
    const zone = j ? containingZone(zoneRows as any, Number(j.pickup_lat ?? j.lat), Number(j.pickup_lng ?? j.lng), String(j.area ?? "")) : null;
    const gate = await enforceReservedZoneEligibility(q, { orgId: user.orgId, userId: user.userId, towbookDriverId: user.towbookDriverId, zone, actorRole: actor.role, explicitOwnerOverride: actor.ownerInDriverView });
    if (!gate.ok) return { ok: false, code: "invalid_state", message: gate.message };
  }
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

/** Sign-in copy for a failed driver (Towbook) login (owner bug 2026-08-12): the
 *  raw towbookLogin failure messages are shared with the owner's Connect Towbook
 *  card (server.ts connectTowbook shows them verbatim), but the login form must
 *  not surface the connect-card's "interactive reconnect" hint — a network /
 *  unreachable failure reads as a plain "try again in a moment". Only the
 *  towbook_unreachable classification is reworded; invalid_credentials ("Towbook
 *  rejected those credentials.") and blocked keep their raw copy. */
export const driverSignInErrorCopy = (code: string | undefined, raw: string): string =>
  code === "towbook_unreachable" ? "Towbook didn't respond — please try again in a moment." : raw;

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
    if (!login.ok) return { ok: false as const, code: login.error.code, error: driverSignInErrorCopy(login.error.code, login.error.message) };
    const session: DriverSession = { cookies: login.cookies, baseUrl: login.baseUrl };
    const identity = await identifyDriver(session);
    if (!identity.ok) return { ok: false as const, error: identity.message };
    if (identity.kind === "owner") {
      // Towbook manager/dispatcher account (type 2) → OWNER portal
      // (owner-directed 2026-08-12: account type is authoritative). NO driver
      // checkin, NO driver session row, NO GPS — owner-portal users
      // authenticate through Towbook on every sign-in.
      const { upsertTowbookOwnerUser, startSession } = await import("./auth-server");
      const { userId } = await upsertTowbookOwnerUser(orgId, d.username, identity.user);
      await startSession(userId);
      return { ok: true as const, name: identity.user.name, role: "owner" as const };
    }
    // Owner-directed guard (contractor edit/remove): a removed contractor must
    // not be able to sign in even with valid Towbook credentials — checked
    // BEFORE the LD upsert so a deactivated row is never touched (and never
    // re-created via an id shift: isDriverDeactivated matches on BOTH
    // towbook_driver_id and towbook_user_id, so the roster-fallback resolution
    // and any id drift still refuse).
    const { isDriverDeactivated, persistDriverSession } = await import("./driver-gps-core");
    if (await isDriverDeactivated(orgId, identity.identity.driverId)) {
      return { ok: false as const, error: "This driver account was removed in Lightning Dispatch — contact the owner." };
    }
    const { userId } = await upsertDriverUser(orgId, d.username, identity.identity);
    await persistDriverSession(orgId, identity.identity.driverId, session);
    const lat = typeof d.latitude === "number" && Number.isFinite(d.latitude) ? d.latitude : 0;
    const lng = typeof d.longitude === "number" && Number.isFinite(d.longitude) ? d.longitude : 0;
    const checkin = await driverCheckin(session, identity.identity.userId, lat, lng, { locationDenied: Boolean(d.locationDenied) });
    const { startSession, ownerMemberRole } = await import("./auth-server");
    // Owner direction 2026-08-13: an owner/admin membership overrides the
    // type-1 landing. The Towbook account type still decides the portal for
    // NON-members (type 1/3 → contractor below; type 2 → the owner branch
    // above; only the `disabled` boolean refuses — resolved in identifyDriver),
    // but a real owner/admin member with a Towbook driver account lands in the
    // OWNER portal — powers come from the membership (role-gating intact), and
    // the driver identity + driver session persisted above make the
    // owner↔contractor view toggle work.
    const memberRole = await ownerMemberRole(orgId, userId);
    await startSession(userId);
    if (memberRole) {
      return { ok: true as const, name: identity.identity.driverName, role: memberRole };
    }
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

/* ------------------------------- driver reconnect ------------------------------- */
export type { DriverReconnectResult } from "./driver-reconnect-core";
/** driverReconnectCore lives in ./driver-reconnect-core (SERVER-ONLY module —
 *  client-graph rule: a plain export in this client-reachable module must
 *  never dynamic-import towbook-login/auth-server — that pulled node:crypto
 *  into the client bundle, "randomBytes is not exported by
 *  __vite-browser-external"). The handler below dynamic-imports the core from
 *  inside its body (stripped client-side); hermetic tests import the core
 *  module directly. The type above is a compile-time-only re-export. */
/** Reconnect handler: refreshes ONLY the driver's Towbook session (never the
 *  LD session). Any signed-in user with an effective driver identity may call
 *  it (contractor re-authing themselves; owner/admin re-authing their own or
 *  linked driver) — the identity guard inside driverReconnectCore keeps it
 *  scoped to the session's own driver. */
export const driverReconnect = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }) => {
  const v = z.object({ username: z.string().min(1).max(256), password: z.string().min(1).max(256) }).safeParse(data);
  if (!v.success) return { ok: false as const, message: "Enter the driver's dispatch username and password." };
  if (!configured()) return { ok: false as const, message: "Driver reconnect requires database mode." };
  const ctx = await resolveEffectiveDriver();
  if (!ctx) return { ok: false as const, message: "Sign in as a driver first." };
  try {
    await ensure();
    const { driverReconnectCore } = await import("./driver-reconnect-core");
    const r = await driverReconnectCore(
      { orgId: ctx.u.orgId, towbookDriverId: ctx.identity.towbookDriverId },
      v.data.username,
      v.data.password,
    );
    if (!r.ok) return r;
    return { ok: true as const, driverId: r.driverId };
  } catch (err) {
    return { ok: false as const, message: err instanceof Error ? err.message : "Reconnect failed. Try again." };
  }
});

/** Reconnect-screen context: the effective driver's TOWBOOK USERNAME
 *  (users.login_handle — the exact handle the driver signs into dispatch with)
 *  so the reconnect form can pre-fill it. The driver's own login_handle is
 *  safe to expose to the session's own driver view (it is the driver's own
 *  identity); no password or cookie material is ever returned. */
export const driverReconnectContext = createServerFn({ method: "GET" }).handler(async () => {
  if (!configured()) return { ok: false as const, message: "Driver reconnect requires database mode." };
  const ctx = await resolveEffectiveDriver();
  if (!ctx) return { ok: false as const, message: "Sign in as a driver first." };
  try {
    const q = await db();
    const rows = await q`SELECT u.login_handle FROM users u JOIN organization_memberships m ON m.user_id=u.id AND m.org_id=${ctx.u.orgId} WHERE u.id=${ctx.identity.userRowId} LIMIT 1`;
    return { ok: true as const, username: rows.length ? String(rows[0].login_handle ?? "") : "" };
  } catch {
    return { ok: false as const, message: "Unable to load reconnect details — try again." };
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
        const rows = await q`SELECT u.towbook_driver_id, u.towbook_user_id FROM users u JOIN organization_memberships m ON m.user_id=u.id AND m.org_id=${u.orgId} WHERE u.id=${identity.userRowId}`;
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
export const AVAILABILITY_HEARTBEAT_INTERVAL_MS = 30_000;
export const AVAILABILITY_STALE_AFTER_SECONDS = 90;
/** Refreshes the persisted GO lease. It is deliberately separate from STOP:
 * tab closure does not call STOP, and a missing refresh expires eligibility. */
export const driverAvailabilityHeartbeat = createServerFn({ method: "POST" }).validator(passthrough).handler(async (): Promise<AvailabilityResult> => {
  if (!configured()) return { ok: false as const, message: "Availability requires database mode." };
  const ctx = await resolveEffectiveDriver();
  if (!ctx) return { ok: false as const, message: "Sign in as a driver first." };
  try {
    await ensure();
    const q = await db();
    // The ledger is keyed by day.  At midnight the new row does not exist yet,
    // so an UPDATE-only heartbeat would silently drop an otherwise-live GO
    // driver. Carry the original open stretch into the new day's row; STOP then
    // uses that timestamp to calculate the full multi-day elapsed duration.
    const rows = await q`WITH prior AS (
        SELECT session_started_at FROM driver_availability_log
        WHERE org_id=${ctx.u.orgId} AND user_id=${ctx.identity.userRowId}
          AND session_started_at IS NOT NULL
        ORDER BY day DESC LIMIT 1
      )
      INSERT INTO driver_availability_log(org_id, user_id, day, online_minutes, ping_count, session_started_at, heartbeat_at, updated_at)
      VALUES(${ctx.u.orgId}, ${ctx.identity.userRowId}, CURRENT_DATE, 0, 0,
        COALESCE((SELECT session_started_at FROM prior), NOW()), NOW(), NOW())
      ON CONFLICT (org_id, user_id, day) DO UPDATE SET
        heartbeat_at=NOW(), updated_at=NOW(),
        session_started_at=COALESCE(driver_availability_log.session_started_at, EXCLUDED.session_started_at)
      RETURNING user_id`;
    return rows.length ? { ok: true as const } : { ok: false as const, message: "Availability is offline." };
  } catch { return { ok: false as const, message: "Heartbeat unavailable." }; }
});
/** Daily availability ledger (owner-directed 2026-08-12, metrics Q2): the
 *  driver_availability_log row per (org, user, day) is the source for the
 *  hours-online metric + the "GO/Offline planning" Academy lesson. GO starts
 *  (or reopens) the day's online stretch; Offline closes it and banks the
 *  elapsed minutes. session_started_at is the open-stretch bookkeeping column
 *  (null when offline). ping_count counts online-session starts that day (one
 *  per GO that actually flipped the stretch open). Both helpers are
 *  best-effort: the Towbook checkin/checkout outcome is the source of truth —
 *  a failed log write must never fail or mask the availability toggle. */
export async function recordAvailabilityStart(q: Awaited<ReturnType<typeof db>>, orgId: string, userId: string): Promise<void> {
  try {
    await q`WITH prior AS (
        SELECT session_started_at FROM driver_availability_log
        WHERE org_id=${orgId} AND user_id=${userId} AND session_started_at IS NOT NULL
        ORDER BY day DESC LIMIT 1
      )
      INSERT INTO driver_availability_log(org_id, user_id, day, online_minutes, ping_count, session_started_at, heartbeat_at, updated_at)
      VALUES(${orgId}, ${userId}, CURRENT_DATE, 0, 1,
        COALESCE((SELECT session_started_at FROM prior), NOW()), NOW(), NOW())
      ON CONFLICT (org_id, user_id, day) DO UPDATE SET
        session_started_at = COALESCE(driver_availability_log.session_started_at, EXCLUDED.session_started_at),
        ping_count = driver_availability_log.ping_count + CASE WHEN driver_availability_log.session_started_at IS NULL THEN 1 ELSE 0 END,
        heartbeat_at = NOW(), updated_at = NOW()`;
  } catch { /* best-effort — never mask the checkin outcome */ }
}
export async function recordAvailabilityStop(q: Awaited<ReturnType<typeof db>>, orgId: string, userId: string): Promise<void> {
  try {
    const open = await q`SELECT day, session_started_at FROM driver_availability_log
      WHERE org_id=${orgId} AND user_id=${userId} AND session_started_at IS NOT NULL
      ORDER BY day DESC, session_started_at DESC LIMIT 1`;
    if (!open.length) return;
    const started = new Date(String(open[0].session_started_at));
    const elapsed = Math.max(1, Math.floor((Date.now() - started.getTime()) / 60000));
    const day = open[0].day instanceof Date ? open[0].day.toISOString().slice(0, 10) : String(open[0].day).slice(0, 10);
    await q`INSERT INTO driver_availability_log(org_id, user_id, day, online_minutes, ping_count, updated_at)
      VALUES(${orgId}, ${userId}, ${day}, ${elapsed}, 0, NOW())
      ON CONFLICT (org_id, user_id, day) DO UPDATE SET
        online_minutes = driver_availability_log.online_minutes + EXCLUDED.online_minutes,
        updated_at = NOW()`;
    await q`UPDATE driver_availability_log SET session_started_at=NULL, updated_at=NOW()
      WHERE org_id=${orgId} AND user_id=${userId} AND session_started_at IS NOT NULL`;
  } catch { /* best-effort */ }
}
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
  const v = z.object({ online: z.boolean(), zoneId: z.string().min(1).optional() }).safeParse(data);
  if (!v.success) return { ok: false as const, message: "Invalid availability value." };
  if (!configured()) return { ok: false as const, message: "Availability requires database mode." };
  const ctx = await resolveEffectiveDriver();
  if (!ctx) return { ok: false as const, message: "Sign in as a driver first." };
  try {
    await ensure();
    if (v.data.online) {
      if (!v.data.zoneId) return { ok: false as const, message: "Pick a zone before going online." };
      const { selectZoneCore } = await import("./zones-core");
      const zoneResult = await selectZoneCore({ orgId: ctx.u.orgId, id: ctx.identity.userRowId, role: "contractor" }, v.data.zoneId);
      if (!zoneResult.ok) return zoneResult;
      const q = await db();
      const zoneRows = await q`SELECT id, is_reserved, unlock_jobs_required FROM dispatch_zones WHERE id=${v.data.zoneId} AND org_id=${ctx.u.orgId} AND active=TRUE LIMIT 1`;
      const { enforceReservedZoneEligibility } = await import("./reserved-zone-core");
      const reservedGate = await enforceReservedZoneEligibility(q, { orgId: ctx.u.orgId, userId: ctx.identity.userRowId, towbookDriverId: ctx.identity.towbookDriverId, zone: (zoneRows[0] as any) ?? null, actorRole: ctx.u.role, explicitOwnerOverride: false });
      if (!reservedGate.ok) return reservedGate;
      // Compliance gate FIRST — no Towbook call, no checkin, until approved.
      const { getComplianceGateCore } = await import("./contractor-admin-core");
      const gate = await getComplianceGateCore({ orgId: ctx.u.orgId, id: ctx.identity.userRowId, role: "contractor" });
      if (!gate.ok) return { ok: false as const, message: gate.message };
    }
    const q = await db();
    const rows = await q`SELECT u.towbook_driver_id, u.towbook_user_id FROM users u JOIN organization_memberships m ON m.user_id=u.id AND m.org_id=${ctx.u.orgId} WHERE u.id=${ctx.identity.userRowId}`;
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
      if (checkin.ok) await recordAvailabilityStart(q, ctx.u.orgId, ctx.identity.userRowId);
      return { ok: checkin.ok, ...(checkin.warning ? { message: checkin.warning } : {}) };
    }
    await driverCheckout(session, towbookUserId);
    await recordAvailabilityStop(q, ctx.u.orgId, ctx.identity.userRowId);
    return { ok: true as const };
  } catch {
    return { ok: false as const, message: "Unable to update availability. Try again." };
  }
});

/* ------------------------------- earnings + profile ------------------------------- */
export type DriverEarningsTirePlug = {
  jobId: string; callNumber: string | null; amountCents: number; status: string; createdAtIso: string | null;
};
export type DriverEarningsBatteryInstall = {
  saleId: string; jobId: string; callNumber: string | null; amountCents: number; createdAtIso: string | null;
};
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
/** Busy-time bonus (owner-locked 2026-08-13): one line item per busy hour
 *  (3+ ASSIGNED calls in one ET clock hour) showing +$1 × jobs completed in
 *  that hour. Derived from the driver's dispatch_jobs rows (system of record —
 *  the same numbers the owner's payday manifest snapshots). */
export type DriverBusyBonusHour = { startsAtIso: string; completedJobs: number; bonusCents: number };
export type DriverBusyBonus = {
  hours: DriverBusyBonusHour[];
  bonusJobs: number;
  bonusCents: number;
};
export type DriverCompletedCounts = { day: number; week: number; month: number; year: number };
export type DriverEarningsResult =
  | { ok: true; profile: { name: string; email: string; towbookDriverId: string; payrateCents: number | null }; completed: DriverCall[]; tips: DriverEarningsTip[]; tirePlugs: DriverEarningsTirePlug[]; batteryInstalls: DriverEarningsBatteryInstall[]; busyBonus: DriverBusyBonus; completedCounts: DriverCompletedCounts; payPeriods: { current: { startsAt: string; endsAt: string; jobCount: number; grossCents: number; tipsCents: number; batteryPayoutCents: number; busyBonusCents: number; totalCents: number }; previous: { startsAt: string; endsAt: string; jobCount: number; grossCents: number; tipsCents: number; batteryPayoutCents: number; busyBonusCents: number; totalCents: number }; diagnostics: { unknownCompletionTimeRows: number } }; totals: { completedJobs: number; tipsTotalCents: number; tipCount: number } }
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
      FROM users u JOIN organization_memberships m ON m.user_id=u.id AND m.org_id=${ctx.u.orgId}
      LEFT JOIN contractor_profiles cp ON cp.org_id = ${ctx.u.orgId} AND cp.user_id = u.id
      WHERE u.id=${ctx.identity.userRowId}`;
    const driverId = rows.length ? String(rows[0].towbook_driver_id ?? "") : "";
    if (!driverId) return { ok: false as const, expired: true, message: "Your account isn't linked to a driver yet — reconnect." };
    const queue = await fetchDriverQueue({ orgId: ctx.u.orgId, towbookDriverId: driverId });
    if (!queue.ok) return queue;
    const completed = queue.calls.filter((c) => c.statusId === 5 || c.statusId === 6 || c.statusId === 252);
    // Canonical completed-work counters: a job_completions row is the evidence
    // of completion. Boundaries are evaluated in ET by Postgres, then converted
    // back to instants for the half-open comparisons. Attribution follows the
    // payout path: dispatch_jobs assigned_driver_towbook_id → this driver's
    // Towbook identity. Never use the Towbook queue here (it is not a durable
    // completion ledger and can omit older jobs).
    const countRows = await q`
      SELECT
        COUNT(*) FILTER (WHERE jc.created_at >= (date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')
          AND jc.created_at < ((date_trunc('day', now() AT TIME ZONE 'America/New_York') + INTERVAL '1 day') AT TIME ZONE 'America/New_York'))::int AS day_count,
        COUNT(*) FILTER (WHERE jc.created_at >= (date_trunc('week', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')
          AND jc.created_at < ((date_trunc('week', now() AT TIME ZONE 'America/New_York') + INTERVAL '1 week') AT TIME ZONE 'America/New_York'))::int AS week_count,
        COUNT(*) FILTER (WHERE jc.created_at >= (date_trunc('month', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')
          AND jc.created_at < ((date_trunc('month', now() AT TIME ZONE 'America/New_York') + INTERVAL '1 month') AT TIME ZONE 'America/New_York'))::int AS month_count,
        COUNT(*) FILTER (WHERE jc.created_at >= (date_trunc('year', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')
          AND jc.created_at < ((date_trunc('year', now() AT TIME ZONE 'America/New_York') + INTERVAL '1 year') AT TIME ZONE 'America/New_York'))::int AS year_count
      FROM job_completions jc
      JOIN dispatch_jobs dj ON dj.org_id=jc.org_id AND dj.id=jc.job_id
      WHERE jc.org_id=${ctx.u.orgId} AND dj.assigned_driver_towbook_id=${driverId}`;
    const countRow = (countRows[0] ?? {}) as Record<string, unknown>;
    const completedCounts: DriverCompletedCounts = {
      day: Number(countRow.day_count ?? 0), week: Number(countRow.week_count ?? 0),
      month: Number(countRow.month_count ?? 0), year: Number(countRow.year_count ?? 0),
    };
    // completion_tips is the canonical Square-capture ledger. Do not derive
    // earnings from job_completions.tip: that legacy payload is not guaranteed
    // to be present after the payment attempt and has no paid-status gate.
    const tipRows = await q`
      SELECT ct.job_id, ct.amount_cents, ct.currency, ct.status, ct.created_at, ct.driver_towbook_id,
             d.towbook_job_id, d.customer_name
      FROM completion_tips ct LEFT JOIN dispatch_jobs d ON d.id = ct.job_id AND d.org_id = ct.org_id
      WHERE ct.org_id = ${ctx.u.orgId} AND ct.driver_id = ${ctx.identity.userRowId}
        AND ct.driver_towbook_id = ${driverId} AND ct.status = 'paid'
      ORDER BY ct.created_at DESC`;
    const tirePlugRows = await q`SELECT t.job_id, t.amount_cents, t.status, t.paid_at, d.towbook_job_id
      FROM tire_plug_transactions t LEFT JOIN dispatch_jobs d ON d.id=t.job_id AND d.org_id=t.org_id
      WHERE t.org_id=${ctx.u.orgId} AND t.contractor_user_id=${ctx.identity.userRowId} AND t.status='paid' ORDER BY t.paid_at DESC`;
    const tirePlugs: DriverEarningsTirePlug[] = (tirePlugRows as Record<string, unknown>[]).map((r) => ({ jobId: String(r.job_id), callNumber: r.towbook_job_id != null ? String(r.towbook_job_id) : null, amountCents: Number(r.amount_cents ?? 0), status: String(r.status), createdAtIso: r.paid_at != null ? new Date(String(r.paid_at)).toISOString() : null }));
    const tirePlugTotalCents = tirePlugs.reduce((sum, row) => sum + row.amountCents, 0);
    const batteryRows = await q`SELECT bp.sale_id, bp.job_id, bp.amount_cents, bp.earned_at, d.towbook_job_id
      FROM battery_payouts bp JOIN battery_sales bs ON bs.org_id=bp.org_id AND bs.id=bp.sale_id
      LEFT JOIN dispatch_jobs d ON d.org_id=bp.org_id AND d.id=bp.job_id
      WHERE bp.org_id=${ctx.u.orgId} AND bp.contractor_user_id=${ctx.identity.userRowId}
        AND bs.status='paid' AND bs.completed_at IS NOT NULL ORDER BY bp.earned_at DESC`;
    const batteryInstalls: DriverEarningsBatteryInstall[] = (batteryRows as Record<string, unknown>[]).map((r) => ({
      saleId: String(r.sale_id), jobId: String(r.job_id), callNumber: r.towbook_job_id != null ? String(r.towbook_job_id) : null,
      amountCents: Number(r.amount_cents ?? 0), createdAtIso: r.earned_at != null ? new Date(String(r.earned_at)).toISOString() : null,
    }));
    const tips: DriverEarningsTip[] = [];
    for (const r of tipRows as Record<string, unknown>[]) {
      const amountCents = Number(r.amount_cents ?? 0);
      if (!Number.isFinite(amountCents) || amountCents <= 0) continue;
      tips.push({
        jobId: String(r.job_id ?? ""),
        callNumber: r.towbook_job_id != null ? String(r.towbook_job_id) : null,
        customerName: r.customer_name != null ? String(r.customer_name) : null,
        amountCents,
        currency: String(r.currency ?? "USD"),
        status: String(r.status ?? "unknown"),
        createdAtIso: r.created_at != null ? new Date(String(r.created_at)).toISOString() : null,
      });
    }
    const tipsTotalCents = tips.reduce((s, t) => s + t.amountCents, 0);
    // BUSY-TIME BONUS (owner-locked 2026-08-13): derived from THIS driver's
    // dispatch_jobs rows — assignment instant = COALESCE(assigned_at, raw
    // dispatchTime, created_at), completion instant = COALESCE(completed_at,
    // raw completionTime). ALL-TIME window (the driver's full history; the
    // Earnings Today/Week toggle filters the line items client-side). Dynamic
    // import inside the handler body so the client bundle never follows it
    // (tanstack-client-graph-leak rule).
    const busyBonus: DriverBusyBonus = { hours: [], bonusJobs: 0, bonusCents: 0 };
    try {
      const { computeBusyBonus, jobAssignmentMs, jobCompletedMs, BUSY_BONUS_PER_JOB_CENTS } = await import("./busy-bonus-core");
      const bbRows = await q`
        SELECT status, assigned_at, completed_at, created_at, raw_json
        FROM dispatch_jobs
        WHERE org_id=${ctx.u.orgId} AND assigned_driver_towbook_id=${driverId}`;
      const assignments: Array<number | null> = [];
      const completions: Array<number | null> = [];
      for (const r of bbRows as Record<string, unknown>[]) {
        assignments.push(jobAssignmentMs(r));
        if (String(r.status) === "completed") completions.push(jobCompletedMs(r));
      }
      const bonus = computeBusyBonus(assignments, completions);
      busyBonus.bonusJobs = bonus.bonusJobs;
      busyBonus.bonusCents = bonus.bonusCents;
      busyBonus.hours = bonus.hours.map((h) => ({
        startsAtIso: new Date(h.startsAtMs).toISOString(),
        completedJobs: h.completedJobs,
        bonusCents: h.completedJobs * BUSY_BONUS_PER_JOB_CENTS,
      }));
    } catch { /* busy bonus never fails the earnings screen — zero on error */ }
    const { getDriverPayPeriodSummaryCore } = await import("./payouts-core");
    const payday = await getDriverPayPeriodSummaryCore({ orgId: ctx.u.orgId, id: ctx.identity.userRowId, role: "contractor" }, driverId);
    const payPeriods = payday.ok ? payday.data : {
      current: { startsAt: new Date(0).toISOString(), endsAt: new Date(0).toISOString(), jobCount: 0, grossCents: 0, tipsCents: 0, batteryPayoutCents: 0, busyBonusCents: 0, totalCents: 0 },
      previous: { startsAt: new Date(0).toISOString(), endsAt: new Date(0).toISOString(), jobCount: 0, grossCents: 0, tipsCents: 0, batteryPayoutCents: 0, busyBonusCents: 0, totalCents: 0 },
      diagnostics: { unknownCompletionTimeRows: 0 },
    };
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
      tirePlugs,
      batteryInstalls,
      busyBonus,
      completedCounts,
      payPeriods,
      totals: { completedJobs: completed.length, tipsTotalCents: tipsTotalCents + tirePlugTotalCents, tipCount: tips.length + tirePlugs.length },
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
    const rows = await q`SELECT u.name, u.email, u.towbook_driver_id FROM users u JOIN organization_memberships m ON m.user_id=u.id AND m.org_id=${ctx.u.orgId} WHERE u.id=${ctx.identity.userRowId}`;
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
