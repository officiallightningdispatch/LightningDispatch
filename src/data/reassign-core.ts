/**
 * OWNER-EDITABLE ASSIGNED DRIVER (owner-directed 2026-08-13): change which
 * contractor is assigned to a call, from the owner/ops portal, in one action.
 *
 * SERVER-ONLY module — reached from createServerFn handler bodies (server.ts)
 * via dynamic import, so it never leaks into the client bundle (client-graph
 * rule: it touches the Towbook owner session + node:fetch paths).
 *
 * Flow (all-or-nothing on the DB side; the Towbook write is the ONLY external
 * state change and it happens FIRST so the 3s sync can never observe a stale
 * assignment):
 *   1. Role gate: owner/admin members ONLY (the owner portal kind). The
 *      contractor portal never reaches this function (UI hides the control and
 *      the server fn refuses).
 *   2. Load the job (org-scoped): reject terminal jobs (completed/cancelled —
 *      a finished call cannot be reassigned) and same-driver no-ops.
 *   3. Load the NEW contractor from the ACTIVE roster (any org member with a
 *      Towbook driver id, deactivated excluded — owner-linked driver identities
 *      included, mirroring listRosterContractors). Offline is ALLOWED: the
 *      reassign push (notifyAssignedDriver) reaches online AND offline phones.
 *   4. Towbook persistence — the PROVEN assign path (ai-dispatcher
 *      postAssignDriver, verified against map-actions.js useDispatchCall):
 *      PUT /api/calls/{id} with {id, status:{id:<current>},
 *      assets:[{id:<assetId>, drivers:[{driver:{id:<driverId>}}]}]}. The call's
 *      CURRENT status id is preserved (a reassign must never move a call
 *      backward — status 1 in the Map payload is only correct for a fresh
 *      dispatch; the fetch-first pattern below reads the real one). Read-back
 *      verification: the new driver must be observed on the call
 *      (assets[].driver.id / assets[].drivers[].driver.id) or the reassign
 *      FAILS with evidence — never a silent "changed" claim. A call with no
 *      asset cannot attach a driver → fail. Platform-only jobs (no
 *      towbook_job_id) skip Towbook entirely.
 *   5. DB persistence: update the call's assignment in dispatch_jobs
 *      (assigned_driver_towbook_id/name, assigned_at=NOW(), and the
 *      manual-reassign marker manually_reassigned_at/by) so the 3s sync and
 *      the AI dispatcher see the new driver immediately. The sync's upsert
 *      uses COALESCE on the driver columns, so this write survives until
 *      Towbook itself reflects the new driver (it does — step 4 ran first).
 *   6. Audit: audit_log row (action 'reassign_driver', entity 'job') with the
 *      actor user id + role, old driver → new driver, and the Towbook push
 *      outcome. NOTE: audit_log has NO created_at column — the timestamp
 *      column is `occurred_at` (migration 3), defaulted to NOW().
 *   7. Push: the unified notifyAssignedDriver trigger (push-core, committed
 *      9999c01 — the same one the AI dispatcher and manual assign use) for the
 *      NEW driver. Fire-and-forget, never fails the reassign; injectable in
 *      tests (pushImpl) so the suite asserts it fired for the new driver.
 *
 * Server functions must never return objects with undefined-valued props
 * (Seroval) — every result field is either present with a real value or
 * omitted; nulls are explicit.
 */
import { z } from "zod";
import { parseStateFromAddress, reverseGeocodeState } from "./state-guard-core";
import { resolveTomtomKey } from "./ai-dispatcher";

export type ReassignActor = { id: string; role: "owner" | "admin" | "dispatcher" | "contractor" };

export type ReassignPushOutcome = {
  attempted: boolean;
  skipped: boolean;
  reason: string | null;
};

export type ReassignResult =
  | {
      ok: true;
      jobId: string;
      towbookJobId: string | null;
      oldDriverId: string | null;
      oldDriverName: string | null;
      newDriverId: string | null;
      newDriverName: string | null;
      contractorUserId: string;
      /** Towbook write result: "verified" (driver observed on the call after
       *  PUT), "skipped" (platform-only job — no Towbook counterpart), or
       *  "failed" (never reported ok; the whole reassign fails instead). */
      towbookStatus: "verified" | "skipped";
      push: ReassignPushOutcome;
    }
  | { ok: false; code: "validation" | "unauthorized" | "not_found" | "invalid_state" | "conflict" | "towbook_failed" | "error"; message: string };

export type ReassignCoreInput = {
  jobId: string;
  contractorId: string;
  orgId: string;
  actor: ReassignActor;
  opts?: {
    /** Injectable fetch for hermetic tests — never hits real Towbook. */
    fetchImpl?: typeof fetch;
    /** Injectable push sender for hermetic tests — defaults to the real
     *  notifyAssignedDriver (push-core). Never awaited by the core flow. */
    pushImpl?: (orgId: string, contractorUserId: string, jobId: string) => Promise<unknown>;
    /** Injectable clock (tests pin the marker timestamp). */
    now?: Date;
    /** SAME-STATE GUARD driver-state resolver (owner rule 2026-08-13, no
     *  cross-state assignments): resolves the NEW driver's CURRENT US state
     *  from its last-known coordinates. Injected for hermetic tests —
     *  production defaults to a TomTom reverse geocode (reverseGeocodeState)
     *  with the resolved key. The override supplies ONLY driver-state
     *  evidence; the job-state parsing, same-state comparison and fail-closed
     *  refusal all stay in this core — an override can never weaken the rule. */
    resolveDriverState?: (towbookDriverId: string, lat: number, lng: number) => Promise<string | null>;
  };
};

const db = () => import("~/db").then((m) => m.sql());

type TbRes = { ok: boolean; status: number | null; body: unknown; bodyText: string; error: string | null };

async function tbFetch(fetchImpl: typeof fetch, url: string, cookie: string, init?: { method?: string; body?: string }): Promise<TbRes> {
  try {
    const res = await fetchImpl(url, {
      method: init?.method ?? "GET",
      headers: {
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
        accept: "application/json,text/plain,*/*",
        "accept-language": "en-US,en;q=0.9",
        cookie,
        ...(init?.method === "PUT" || init?.method === "POST" ? { "content-type": "application/json" } : {}),
      },
      redirect: "manual",
      signal: AbortSignal.timeout(12000),
      ...(init?.body ? { body: init.body } : {}),
    });
    const text = await res.text();
    let body: unknown = text;
    if (text) { try { body = JSON.parse(text); } catch { /* keep raw text */ } }
    const ok = res.status >= 200 && res.status < 300;
    return { ok, status: res.status, body, bodyText: text, error: ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: null, body: null, bodyText: "", error: String(err).slice(0, 200) };
  }
}

/** True when a response means the stored owner session is dead (401/403, or a
 *  200 that is actually the MVC login page — the fingerprint every other module
 *  uses). */
const isSessionExpired = (r: TbRes): boolean =>
  r.status === 401 || r.status === 403 ||
  (r.status === 200 && typeof r.body === "string" && /<form/i.test(r.body) && /RequestVerificationToken/i.test(r.body));

/** Numeric status id from a Towbook status field (object {id} / number /
 *  numeric string — mirrors status-push-core.extractStatusId). */
function extractStatusId(status: unknown): number | null {
  if (status == null) return null;
  if (typeof status === "number") return Number.isFinite(status) ? status : null;
  if (typeof status === "string" && status.trim() !== "") { const n = Number(status); return Number.isFinite(n) ? n : null; }
  if (typeof status === "object") {
    const o = status as Record<string, unknown>;
    const nId = typeof o.id === "number" ? o.id : typeof o.id === "string" && o.id.trim() !== "" ? Number(o.id) : NaN;
    if (Number.isFinite(nId)) return nId;
  }
  return null;
}

/** First asset (vehicle) id on a call — the Map app's dispatch payload
 *  requires assets[0].id (same helper the AI dispatcher uses). */
function firstAssetIdOnCall(call: Record<string, unknown>): string | null {
  const assets = call.assets;
  if (!Array.isArray(assets) || !assets.length) return null;
  const a = assets[0];
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  const id = (a as Record<string, unknown>).id;
  return id != null ? String(id) : null;
}

/** True when the call's assets carry `driver.id === driverId` — the assignment
 *  mirror used by the Towbook UI (assets[].driver.id and
 *  assets[].drivers[].driver.id are both DRIVER ids). Same shape as
 *  ai-dispatcher.callHasDriver. */
function callHasDriver(call: unknown, driverId: number): boolean {
  if (!call || typeof call !== "object") return false;
  const assets = (call as Record<string, unknown>).assets;
  if (!Array.isArray(assets)) return false;
  return assets.some((a) => {
    if (!a || typeof a !== "object") return false;
    const driver = (a as Record<string, unknown>).driver as Record<string, unknown> | undefined;
    if (driver && Number(driver.id) === driverId) return true;
    const drivers = (a as Record<string, unknown>).drivers;
    return Array.isArray(drivers) && drivers.some((d) => {
      if (!d || typeof d !== "object") return false;
      const sub = ((d as Record<string, unknown>).driver ?? null) as Record<string, unknown> | null;
      return sub != null && Number(sub.id) === driverId;
    });
  });
}

/** Load + decrypt the org's owner Towbook session (the same stored session the
 *  pull and the AI dispatcher use). */
async function loadOwnerSession(orgId: string): Promise<{ cookie: string; baseUrl: string } | null> {
  try {
    const q = await db();
    const sess = await q`SELECT encrypted_session, status FROM towbook_sessions WHERE org_id=${orgId} AND session_kind='owner'`;
    if (!sess.length || String(sess[0].status) !== "connected" || !String(sess[0].encrypted_session || "").length) return null;
    const { decryptSession } = await import("./towbook-key");
    const plain = await decryptSession(String(sess[0].encrypted_session));
    const parsed = JSON.parse(plain) as { cookies?: string; baseUrl?: string };
    return { cookie: parsed.cookies || "", baseUrl: parsed.baseUrl || "https://app.towbook.com" };
  } catch {
    return null;
  }
}

/** The Towbook write for a reassign: GET the call (read the CURRENT status id
 *  + the asset id), PUT the proven assign payload preserving that status,
 *  read-back verify the new driver is on the call. Returns
 *  {ok, code, message, attempts} — never throws. */
async function pushReassignToTowbook(
  fetchImpl: typeof fetch,
  baseUrl: string,
  cookie: string,
  towbookJobId: string,
  driverId: number,
): Promise<{ ok: boolean; code: string; message: string; attempts: string[] }> {
  const attempts: string[] = [];
  const numericId = Number(towbookJobId);
  const idForBody = Number.isInteger(numericId) && numericId > 0 ? numericId : towbookJobId;

  const getRes = await tbFetch(fetchImpl, `${baseUrl}/api/calls/${towbookJobId}`, cookie);
  attempts.push(`GET /api/calls/${towbookJobId} → ${getRes.status ?? "network error"} (${getRes.ok ? "ok" : "failed"})`);
  if (isSessionExpired(getRes)) return { ok: false, code: "session_expired", message: "The Towbook session expired — reconnect Towbook in Settings.", attempts };
  if (!getRes.ok || !getRes.body || typeof getRes.body !== "object") {
    return { ok: false, code: "towbook_failed", message: `Could not read the call on Towbook (${getRes.error ?? `HTTP ${getRes.status}`}).`, attempts };
  }
  const call = getRes.body as Record<string, unknown>;
  const assetId = firstAssetIdOnCall(call);
  if (assetId == null) {
    return { ok: false, code: "towbook_failed", message: `Call ${towbookJobId} has no asset to attach the driver to — cannot reassign on Towbook.`, attempts };
  }
  // Preserve the call's CURRENT status — a reassign changes WHO is assigned,
  // never WHERE the call is in its lifecycle (never move it backward).
  const statusId = extractStatusId(call.status) ?? 1;
  const body = JSON.stringify({
    id: idForBody,
    status: { id: statusId },
    assets: [{ id: Number(assetId) || assetId, drivers: [{ driver: { id: driverId } }] }],
  });
  const putRes = await tbFetch(fetchImpl, `${baseUrl}/api/calls/${towbookJobId}`, cookie, { method: "PUT", body });
  attempts.push(`PUT /api/calls/${towbookJobId} → ${putRes.status ?? "network error"} (${putRes.ok ? "ok" : "failed"})`);
  if (!putRes.ok && !isSessionExpired(putRes)) {
    const retry = await tbFetch(fetchImpl, `${baseUrl}/api/calls/${towbookJobId}`, cookie, { method: "PUT", body });
    attempts.push(`PUT retry /api/calls/${towbookJobId} → ${retry.status ?? "network error"} (${retry.ok ? "ok" : "failed"})`);
    if (retry.ok) { const v = await verifyCallHasDriver(fetchImpl, baseUrl, cookie, towbookJobId, driverId); return v.ok ? { ok: true, code: "verified", message: v.message, attempts: [...attempts, ...v.attempts] } : v; }
  }
  if (!putRes.ok || isSessionExpired(putRes)) {
    return { ok: false, code: isSessionExpired(putRes) ? "session_expired" : "towbook_failed", message: `Towbook rejected the reassign (${isSessionExpired(putRes) ? "session expired" : putRes.error ?? `HTTP ${putRes.status}`}).`, attempts };
  }
  const v = await verifyCallHasDriver(fetchImpl, baseUrl, cookie, towbookJobId, driverId);
  return v.ok ? { ok: true, code: "verified", message: v.message, attempts: [...attempts, ...v.attempts] } : v;
}

/** Read-back verification (never claim "changed" without seeing the driver on
 *  the call): GET the call once more and require the new driver's id in
 *  assets[].driver.id / assets[].drivers[].driver.id. */
async function verifyCallHasDriver(
  fetchImpl: typeof fetch,
  baseUrl: string,
  cookie: string,
  towbookJobId: string,
  driverId: number,
): Promise<{ ok: boolean; code: string; message: string; attempts: string[] }> {
  const attempts: string[] = [];
  const res = await tbFetch(fetchImpl, `${baseUrl}/api/calls/${towbookJobId}`, cookie);
  attempts.push(`GET verify /api/calls/${towbookJobId} → ${res.status ?? "network error"}`);
  if (!res.ok || !res.body || typeof res.body !== "object") {
    return { ok: false, code: "verify_failed", message: "Could not re-read the call after the reassign PUT.", attempts };
  }
  if (callHasDriver(res.body, driverId)) {
    return { ok: true, code: "verified", message: `driver ${driverId} observed on call ${towbookJobId}`, attempts };
  }
  return { ok: false, code: "verify_failed", message: `Towbook did not confirm driver ${driverId} on call ${towbookJobId} after the reassign PUT.`, attempts };
}

/** Job state from the dispatch_jobs row: pickup address text → raw
 *  startingLocation text — parsed by the same address rule the AI dispatcher
 *  uses (ZIP prefix table + trailing state token; NEVER coordinates, because
 *  production rows carried Bridgeport placeholder coords with TX addresses).
 *  Uppercase 2-letter state or null (null → the caller fails closed). */
function jobStateOfJob(job: Record<string, unknown>): string | null {
  const pickup = job.pickup != null && String(job.pickup).trim() !== "" ? String(job.pickup).trim() : null;
  if (pickup) {
    const st = parseStateFromAddress(pickup);
    if (st) return st;
  }
  const raw = job.raw_json;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const sl = (raw as Record<string, unknown>).startingLocation;
    if (typeof sl === "string" && sl.trim() !== "") {
      const st = parseStateFromAddress(sl.trim());
      if (st) return st;
    }
  }
  return null;
}

/** The NEW driver's CURRENT location: a real app GPS fix only. The query
 * enforces the 24-hour state-evidence window and this function enforces the
 * <=15-minute location/placement window. Historical assignment anchors are
 * never a fallback. Never throws. */
async function resolveDriverCurrentLocation(
  orgId: string,
  towbookDriverId: string,
  now: Date = new Date(),
): Promise<{ lat: number; lng: number; basis: "gps" } | null> {
  try {
    const q = await db();
    const fixRows = await q`SELECT latitude, longitude, captured_at FROM driver_locations
      WHERE org_id=${orgId} AND towbook_driver_id=${towbookDriverId}
        AND latitude != 0 AND longitude != 0
        AND captured_at >= NOW() - INTERVAL '24 hours'
      ORDER BY captured_at DESC LIMIT 1`;
    if (!fixRows.length) return null;
    const row = fixRows[0] as Record<string, unknown>;
    const lat = Number(row.latitude);
    const lng = Number(row.longitude);
    const captured = Date.parse(String(row.captured_at ?? ""));
    const ageMinutes = (now.getTime() - captured) / 60000;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat === 0 || lng === 0
      || !Number.isFinite(ageMinutes) || ageMinutes < 0 || ageMinutes > 15) return null;
    return { lat, lng, basis: "gps" };
  } catch {
    return null;
  }
}

/** Driver state from a location: the injected resolver (tests) or a TomTom
 *  reverse geocode with the resolved key (production; a missing key yields
 *  null → fail closed). Never throws. */
async function resolveDriverStateFor(
  towbookDriverId: string,
  lat: number,
  lng: number,
  injected: ((towbookDriverId: string, lat: number, lng: number) => Promise<string | null>) | undefined,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  try {
    if (injected) return await injected(towbookDriverId, lat, lng);
    const key = resolveTomtomKey(process.env);
    if (!key) return null;
    return await reverseGeocodeState(lat, lng, key, fetchImpl);
  } catch {
    return null;
  }
}

/**
 * Reassign a call's assigned driver. See the header for the full flow.
 * Never throws — every failure mode is a structured {ok:false} result.
 */
export async function reassignDriverCore(input: ReassignCoreInput): Promise<ReassignResult> {
  const v = z.object({
    jobId: z.string().min(1).max(128),
    contractorId: z.string().min(1).max(128),
    orgId: z.string().min(1).max(128),
  }).safeParse({ jobId: input.jobId, contractorId: input.contractorId, orgId: input.orgId });
  if (!v.success) return { ok: false, code: "validation", message: "Invalid reassign input." };
  const { jobId, contractorId, orgId } = v.data;
  const actor = input.actor;
  const fetchImpl = input.opts?.fetchImpl ?? globalThis.fetch;
  const now = input.opts?.now ?? new Date();

  // (1) Role gate — owner/admin members only (the owner portal kind). The
  //     contractor portal must NEVER reassign.
  if (actor.role !== "owner" && actor.role !== "admin") {
    return { ok: false, code: "unauthorized", message: "Only owners and admins can change a job's assigned driver." };
  }
  try {
    const q = await db();
    // (2) The job — org-scoped; terminal jobs cannot be reassigned.
    const jobRows = await q`SELECT id, status, towbook_job_id, assigned_driver_towbook_id, assigned_driver_name, pickup, raw_json FROM dispatch_jobs WHERE id=${jobId} AND org_id=${orgId}`;
    if (!jobRows.length) return { ok: false, code: "not_found", message: "Job not found." };
    const job = jobRows[0] as Record<string, unknown>;
    const status = String(job.status ?? "");
    if (status === "completed" || status === "cancelled") {
      return { ok: false, code: "invalid_state", message: `This job is ${status} — a finished call cannot be reassigned.` };
    }
    const towbookJobId = job.towbook_job_id != null && String(job.towbook_job_id) !== "" ? String(job.towbook_job_id) : null;
    const oldDriverId = job.assigned_driver_towbook_id != null && String(job.assigned_driver_towbook_id) !== "" ? String(job.assigned_driver_towbook_id) : null;
    const oldDriverName = job.assigned_driver_name != null && String(job.assigned_driver_name) !== "" ? String(job.assigned_driver_name) : null;

    // (3) The NEW contractor — the ACTIVE roster (any org member with a
    //     Towbook driver id, deactivated excluded; owner-linked driver
    //     identities included). Offline is allowed — the push reaches offline
    //     phones too.
    const conRows = await q`SELECT u.id, u.name, u.towbook_driver_id
      FROM users u
      JOIN organization_memberships m ON m.user_id = u.id AND m.org_id = ${orgId}
      WHERE u.id = ${contractorId} AND u.deactivated_at IS NULL AND u.towbook_driver_id IS NOT NULL
      LIMIT 1`;
    if (!conRows.length) return { ok: false, code: "not_found", message: "Contractor not found on the active roster." };
    const con = conRows[0] as Record<string, unknown>;
    const newDriverId = String(con.towbook_driver_id);
    const newDriverName = String(con.name ?? "");
    if (oldDriverId != null && oldDriverId === newDriverId) {
      return { ok: false, code: "conflict", message: `${newDriverName} is already the assigned driver for this job.` };
    }

    // (3.5) SAME-STATE GUARD (owner rule 2026-08-13: "No cross-state
    // assignments"; production incident — offers carrying Bridgeport CT
    // placeholder coords with Georgetown/Austin TX addresses were dispatched
    // to CT drivers). A manual reassign is an ASSIGNMENT and gets the same
    // containment as the AI dispatcher: the job's state comes from its
    // ADDRESS text (pickup → raw startingLocation — never coordinates), the
    // driver's state from a reverse geocode of its CURRENT fresh app GPS fix.
    // FAIL-CLOSED: an unresolvable job state, a missing/stale driver GPS fix,
    // or an unresolvable driver state
    // all REFUSE the reassign (no Towbook write, no DB write, no push); a
    // driver proven in a DIFFERENT state is refused outright. The owner can
    // still assign via Towbook directly — this rail guards the platform path.
    const jobState = jobStateOfJob(job);
    if (!jobState) {
      return { ok: false, code: "invalid_state", message: `The job's state could not be determined from its address — the same-state rule cannot be verified. The assignment was NOT changed (no cross-state assignments).` };
    }
    const driverLoc = await resolveDriverCurrentLocation(orgId, newDriverId, now);
    if (!driverLoc) {
      return { ok: false, code: "invalid_state", message: `${newDriverName} has no fresh app GPS fix (required within 15 minutes) — their state/location cannot be verified. The assignment was NOT changed (no cross-state assignments).` };
    }
    const driverState = await resolveDriverStateFor(newDriverId, driverLoc.lat, driverLoc.lng, input.opts?.resolveDriverState, fetchImpl);
    if (!driverState) {
      return { ok: false, code: "invalid_state", message: `${newDriverName}'s state could not be verified from their current location — the same-state rule cannot be confirmed. The assignment was NOT changed (no cross-state assignments).` };
    }
    if (driverState !== jobState) {
      return { ok: false, code: "invalid_state", message: `${newDriverName} is currently in ${driverState}, but this job is in ${jobState} — cross-state assignments are not allowed. The assignment was NOT changed.` };
    }

    // (4) Towbook persistence FIRST (so the sync can never observe a stale
    //     assignment): the PROVEN assign path — PUT /api/calls/{id} with the
    //     driver on the call's asset, preserving the call's current status.
    let towbookStatus: "verified" | "skipped" = "skipped";
    let towbookAttempts: string[] = [];
    if (towbookJobId != null) {
      const session = await loadOwnerSession(orgId);
      if (!session) {
        return { ok: false, code: "towbook_failed", message: "Towbook is not connected for this organization — connect it in Settings before reassigning." };
      }
      const push = await pushReassignToTowbook(fetchImpl, session.baseUrl, session.cookie, towbookJobId, Number(newDriverId) || 0);
      towbookAttempts = push.attempts;
      if (!push.ok) {
        return { ok: false, code: push.code === "session_expired" ? "towbook_failed" : "towbook_failed", message: `${push.message} The assignment was NOT changed.`, };
      }
      towbookStatus = "verified";
    }

    // (5) DB persistence — the assignment + the manual-reassign marker (the AI
    //     dispatcher guard reads it). Status is NOT changed — only WHO is on it.
    const upd = await q`UPDATE dispatch_jobs
      SET assigned_driver_towbook_id = ${newDriverId},
          assigned_driver_name = ${newDriverName},
          assigned_at = ${now.toISOString()},
          manually_reassigned_at = ${now.toISOString()},
          manually_reassigned_by = ${actor.id}
      WHERE id = ${jobId} AND org_id = ${orgId}
      RETURNING id`;
    if (!upd.length) return { ok: false, code: "error", message: "The job could not be updated." };

    // (6) Audit — action 'reassign_driver', entity 'job', old → new driver,
    //     actor + the Towbook push evidence. audit_log timestamps live in
    //     `occurred_at` (migration 3) — defaulted to NOW(), never written here.
    await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
      VALUES(gen_random_uuid()::text, ${orgId}, ${actor.id}, ${actor.role}, 'reassign_driver', 'job', ${jobId},
        ${JSON.stringify({
          jobId,
          towbookJobId,
          oldDriverId,
          oldDriverName,
          newDriverId,
          newDriverName,
          contractorUserId: contractorId,
          reassignedBy: actor.id,
          towbookStatus,
          towbookAttempts,
        })}::jsonb, 'reassign-driver')`;

    // (7) Push — the unified notifyAssignedDriver trigger for the NEW driver
    //     (the same one the AI dispatcher + manual assign use; online AND
    //     offline). Fire-and-forget; injectable in tests.
    let pushOutcome: ReassignPushOutcome = { attempted: false, skipped: true, reason: "push-sender-unavailable" };
    try {
      if (input.opts?.pushImpl) {
        await input.opts.pushImpl(orgId, contractorId, jobId);
        pushOutcome = { attempted: true, skipped: false, reason: null };
      } else {
        const { notifyAssignedDriver } = await import("./push-core");
        const outcome = await notifyAssignedDriver(orgId, contractorId, jobId);
        pushOutcome = { attempted: true, skipped: Boolean(outcome.skipped), reason: outcome.skipped ? (outcome.reason ?? "skipped") : null };
      }
    } catch { /* push never fails the reassign */ }

    return {
      ok: true,
      jobId,
      towbookJobId,
      oldDriverId,
      oldDriverName,
      newDriverId,
      newDriverName,
      contractorUserId: contractorId,
      towbookStatus,
      push: pushOutcome,
    };
  } catch (err) {
    return { ok: false, code: "error", message: err instanceof Error ? err.message : "Unable to reassign the job." };
  }
}
