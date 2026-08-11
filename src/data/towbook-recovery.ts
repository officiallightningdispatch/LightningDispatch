import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sql } from "~/db";
import { encryptSession, findSiteRoot } from "./towbook-key";
import { towbookLogin, TOWBOOK_ORIGIN } from "./towbook-login";

/**
 * Towbook session self-healing (owner-directed 2026-08-11: "set up Towbook and
 * forget"). The AI auto-accept/auto-dispatch loop's ONLY owner dependency is a
 * valid stored Towbook session. When that session expires (401 / login-page
 * redirect on any Towbook call — the 2026-08-11 13:10Z incident lost a real
 * motor-club offer this way), recoverTowbookSession() re-logs-in with the
 * owner's stored credentials and rewrites the org's OWNER session row — no
 * owner action needed.
 *
 * Contract:
 *  - OWNER-KIND ROWS ONLY: the upsert is scoped to the session_kind='owner'
 *    partial index (`ON CONFLICT (org_id) WHERE session_kind='owner'`), so a
 *    driver-kind session row can never be touched; towbook_driver_id is NOT in
 *    the UPDATE column list, so the owner-driver link (roster bug-2 logic) is
 *    preserved exactly like connectTowbook's persist.
 *  - CREDENTIALS ARE NEVER LOGGED: the password is read from the stable
 *    .secrets files, passed straight into towbookLogin, and dropped; only the
 *    classified failure code/message is ever persisted or surfaced.
 *  - NO CREDS → NO RECOVERY: an org without stored owner credentials keeps
 *    today's behavior (escalation + alert); recoverTowbookSession returns
 *    { recovered:false, reason:'no_stored_owner_creds' } without touching the
 *    session row or the network.
 *  - IN-FLIGHT GUARD: only ONE recovery per org runs at a time (module-level
 *    Map of promises); a concurrent caller awaits the same attempt — a tick
 *    can never overlap the previous tick's re-login.
 *  - THROTTLE: at most one recovery ATTEMPT per org per 60s (module-level
 *    Map of timestamps). A failing credential pair never hammers Towbook; the
 *    session row keeps its existing status/error (the sync's last_result keeps
 *    showing session_expired and the caller keeps its escalation + alert), and
 *    every attempt is recorded in the audit trail.
 *  - NEVER THROWS: every failure is a classified { recovered:false, reason }.
 *  - Recovery events are recorded in the audit trail (action
 *    'towbook_session_recovered', detail { recovered, reason }) — best-effort
 *    like every other audit write.
 */

const STABLE_SECRETS_DIR = join(dirname(findSiteRoot(import.meta.url)), ".secrets");
/** Owner's stored Towbook credentials — sibling of the site root, OUTSIDE the
 *  repo and the build output (the same publish-proof path towbook-key.ts uses
 *  for the session key). Never hardcoded; resolved from this module's URL. */
const OWNER_USERNAME_FILE = join(STABLE_SECRETS_DIR, "towbook-owner-username");
const OWNER_PASSWORD_FILE = join(STABLE_SECRETS_DIR, "towbook-owner-password");

export type OwnerCreds = { username: string; password: string };

/** Read the owner's stored Towbook credentials from the stable .secrets dir.
 *  Returns null when either file is missing or empty — the caller then keeps
 *  today's no-recovery behavior (escalation + alert). The password value is
 *  never logged and never leaves this module except into towbookLogin. */
export async function readOwnerCreds(): Promise<OwnerCreds | null> {
  try {
    const [username, password] = await Promise.all([
      readFile(OWNER_USERNAME_FILE, "utf8"),
      readFile(OWNER_PASSWORD_FILE, "utf8"),
    ]);
    const u = username.trim();
    const p = password.trim();
    if (!u || !p) return null;
    return { username: u, password: p };
  } catch {
    return null;
  }
}

export type RecoveryResult =
  | { recovered: true; reason: "recovered" }
  | { recovered: false; reason: string; throttled?: boolean };

export type RecoveryOptions = {
  /** Injectable fetch for hermetic tests — never real in the suite. */
  fetchImpl?: typeof fetch;
  /** Credentials source override (tests); defaults to readOwnerCreds(). */
  readCreds?: () => Promise<OwnerCreds | null>;
};

/** At most one recovery attempt per org per this window — a failing credential
 *  pair must never hammer Towbook (wrong creds → 1 login per minute max). */
export const RECOVERY_THROTTLE_MS = 60_000;

/** In-flight guard: one recovery attempt per org at a time. A concurrent
 *  caller joins the SAME promise — a tick never overlaps the previous tick's
 *  re-login, and concurrent callers never double-login. */
const recoveryInFlight = new Map<string, Promise<RecoveryResult>>();
/** Throttle: last ATTEMPT time per org. Set at the START of every actual
 *  towbookLogin attempt (success or failure). */
const lastRecoveryAttemptAt = new Map<string, number>();

/** Best-effort audit trail for every recovery outcome (action
 *  'towbook_session_recovered'). Attribution mirrors resolveOrgActor (the
 *  org's first owner). A failure to write the audit row never masks the
 *  recovery outcome. */
async function recordRecoveryAudit(orgId: string, outcome: { recovered: boolean; reason: string }): Promise<void> {
  try {
    const rows = await sql()`SELECT user_id, role FROM organization_memberships WHERE org_id=${orgId} ORDER BY (role='owner') DESC, role LIMIT 1`;
    if (!rows.length) return;
    const actor = rows[0] as Record<string, unknown>;
    await sql()`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
      VALUES(gen_random_uuid()::text, ${orgId}, ${String(actor.user_id)}, ${String(actor.role)}, 'towbook_session_recovered', 'towbook_session', ${orgId},
        ${JSON.stringify({ recovered: outcome.recovered, reason: outcome.reason, at: new Date().toISOString() })}::jsonb, 'towbook-recovery')`;
  } catch { /* audit is best-effort — never mask the recovery outcome */ }
}

/**
 * Re-login to Towbook with the owner's stored credentials and rewrite the
 * org's OWNER session row (status='connected', error=NULL, updated_at=NOW(),
 * encrypted_session refreshed, towbook_driver_id PRESERVED). Returns a
 * classified result; never throws. See the module contract above for the
 * in-flight guard, the 60s throttle, and the no-creds passthrough.
 */
export async function recoverTowbookSession(orgId: string, opts: RecoveryOptions = {}): Promise<RecoveryResult> {
  const running = recoveryInFlight.get(orgId);
  if (running) return running; // join the in-flight attempt — one login
  const last = lastRecoveryAttemptAt.get(orgId);
  if (last != null && Date.now() - last < RECOVERY_THROTTLE_MS) {
    return { recovered: false, reason: "throttled", throttled: true };
  }
  const p = doRecover(orgId, opts);
  recoveryInFlight.set(orgId, p);
  try {
    return await p;
  } finally {
    recoveryInFlight.delete(orgId);
  }
}

async function doRecover(orgId: string, opts: RecoveryOptions): Promise<RecoveryResult> {
  lastRecoveryAttemptAt.set(orgId, Date.now());
  let creds: OwnerCreds | null = null;
  try {
    creds = await (opts.readCreds ?? readOwnerCreds)();
  } catch {
    creds = null;
  }
  if (!creds) {
    await recordRecoveryAudit(orgId, { recovered: false, reason: "no_stored_owner_creds" });
    return { recovered: false, reason: "no_stored_owner_creds" };
  }
  // The PURE login (page GET → token → form POST → redirect follow → cookie
  // jar) is towbookLogin — the same code path connectTowbook and the driver
  // portal use. The password goes in here and never comes out.
  const result = await towbookLogin(creds.username, creds.password, { fetchImpl: opts.fetchImpl });
  if (!result.ok) {
    const reason = `login_failed:${result.error.code}`;
    await recordRecoveryAudit(orgId, { recovered: false, reason });
    return { recovered: false, reason };
  }
  // Upsert the OWNER session row exactly like connectTowbook's persist:
  // status='connected', error=NULL, updated_at=NOW(), encrypted_session
  // refreshed — and towbook_driver_id NOT in the UPDATE list, so the owner's
  // driver link survives the recovery. Driver-kind rows are untouched by
  // construction (the partial index only matches session_kind='owner').
  try {
    const encrypted = await encryptSession(JSON.stringify({ cookies: result.cookies, baseUrl: TOWBOOK_ORIGIN }));
    await sql()`INSERT INTO towbook_sessions(org_id, encrypted_session, status, session_kind, error, updated_at)
      VALUES(${orgId}, ${encrypted}, 'connected', 'owner', NULL, NOW())
      ON CONFLICT (org_id) WHERE session_kind='owner'
      DO UPDATE SET encrypted_session=EXCLUDED.encrypted_session, status='connected', error=NULL, updated_at=NOW()`;
  } catch {
    const reason = "persist_failed";
    await recordRecoveryAudit(orgId, { recovered: false, reason });
    return { recovered: false, reason };
  }
  await recordRecoveryAudit(orgId, { recovered: true, reason: "recovered" });
  return { recovered: true, reason: "recovered" };
}
