/**
 * Account deletion — SERVER-ONLY core (Apple App Store requirement, 2026-09-03).
 *
 * A contractor self-deleting their account must remove every piece of PERSONAL
 * data the business does not have a legal duty to retain, while leaving the
 * production organization and every OTHER member's data untouched, and while
 * keeping ONLY the records payroll/tax compliance requires.
 *
 * Approach — anonymizing soft-delete (matches migration 14's precedent that
 * users are referenced by jobs, sessions, GPS pings, photos and audit rows, so
 * "history must survive"): we keep an anonymized `users` TOMBSTONE row (name
 * scrubbed, email rewritten to a non-identifying deterministic value, password
 * hash replaced with an unverifiable value, all Towbook/login identifiers
 * cleared, deactivated_at set) rather than `DELETE FROM users`. This keeps
 * every org-scoped FK reference (status_events, audit_log, payout_records,
 * completion_tips, contractor_form_submissions, …) valid — no org or peer data
 * is ever cascade-deleted.
 *
 * We then HARD-DELETE the personal sub-tables:
 *   - driver_locations          (location history — the 2026-08-17 GPS source)
 *   - job_photos                (job photos the contractor uploaded)
 *   - contractor_documents      (license / insurance / compliance uploads)
 *   - contractor_doc_selfies    (facial-verification selfies)
 *   - contractor_profiles       (phone / address / vehicle / payrate / avatar key)
 *   - payout_methods            (cash-app/venmo/zelle/bank handles)
 *   - push_subscriptions        (web-push endpoints)
 *   - apns_device_tokens        (iOS push tokens)
 *   - academy_progress / driver_availability_log / contractor_schedules /
 *     contractor_services       (personal operational rows)
 *   - sessions                  (ends the sign-in — sign-out guarantee)
 *   - towbook_sessions (driver) (the stored encrypted Towbook credential)
 *
 * RETAINED (payroll/tax/legal — never deleted):
 *   - dispatch_jobs (completed job records), status_events, audit_log
 *   - pay_periods, payout_records, completion_tips, tip_cashouts
 *   - tire_plug_transactions, battery_sales, battery_payouts
 *   - contractor_form_submissions + contractor_form_docs (W-9 / I-9 tax forms)
 *
 * B2 objects behind the deleted rows (job photos, document scans, selfies, the
 * profile photo) are deleted best-effort AFTER the DB commit; a B2 failure must
 * never fail the account deletion (the DB rows are already gone).
 *
 * Imported ONLY by the client-safe facade (src/data/account-deletion.ts) inside
 * its createServerFn handler and by hermetic tests. It never enters the client
 * bundle graph (node:crypto / db / auth-server / b2-client stay server-side).
 */
import { randomBytes } from "node:crypto";
import { loadB2Config, authorizeAccount, deleteObject } from "./b2-client";
import type { AuthUser } from "./auth-server";

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

export type DeleteAccountResult =
  | {
      ok: true;
      deletedUserId: string;
      retained: {
        jobRecords: number;
        payoutRecords: number;
        tipRecords: number;
        taxFormSubmissions: number;
      };
    }
  | { ok: false; code: "staff_account" | "already_deleted" | "database_error" | "unavailable"; message: string };

/** Deterministic, non-identifying replacement email. userId is unique, so the
 *  `users.email` UNIQUE constraint is satisfied and the address can never
 *  resolve to a real mailbox or be used to sign back in. */
export const anonymizedEmail = (userId: string) => `deleted+${userId}@account-deleted.lightningdispatch.app`;

/** Collect B2 object keys behind a set of rows (used pre-delete so the keys are
 *  recoverable after the rows are gone). */
type StorageKeyRow = Record<string, unknown>;

export async function deleteMyAccountCore(
  user: AuthUser,
  opts: { fetchImpl?: typeof fetch; b2StableDir?: string } = {},
): Promise<DeleteAccountResult> {
  if (!configured()) return { ok: false, code: "unavailable", message: "Account deletion requires database mode." };
  try {
    await ensure();
    const q = await db();

    // Authorization re-check (defense in depth): only an ACTIVE contractor in
    // their own org may self-delete. A staff/owner/admin membership is refused
    // here even if the caller fabricated a contractor-shaped AuthUser.
    const target = (await q`SELECT u.id, u.towbook_driver_id, u.deactivated_at
      FROM users u JOIN organization_memberships m ON m.user_id=u.id AND m.org_id=${user.orgId}
      WHERE u.id=${user.id} AND m.role='contractor' LIMIT 1`)[0] as Record<string, unknown> | undefined;
    if (!target) {
      return { ok: false, code: "staff_account", message: "This is the business owner account and cannot be deleted from inside the app. Email lightroad29@gmail.com to request deletion." };
    }
    if (target.deactivated_at != null) {
      return { ok: false, code: "already_deleted", message: "This account was already deleted." };
    }

    // Collect the B2 object keys to remove AFTER commit (rows are deleted below).
    const jobPhotoKeys = (await q`SELECT storage_key FROM job_photos WHERE org_id=${user.orgId} AND uploaded_by_user_id=${user.id}`) as StorageKeyRow[];
    const docKeys = (await q`SELECT storage_key FROM contractor_documents WHERE org_id=${user.orgId} AND contractor_id=${user.id}`) as StorageKeyRow[];
    const selfieKeys = (await q`SELECT storage_key FROM contractor_doc_selfies WHERE org_id=${user.orgId} AND contractor_id=${user.id}`) as StorageKeyRow[];
    const profileKeys = (await q`SELECT profile_photo_key FROM contractor_profiles WHERE org_id=${user.orgId} AND user_id=${user.id} AND profile_photo_key IS NOT NULL`) as StorageKeyRow[];
    const b2Keys = [...jobPhotoKeys, ...docKeys, ...selfieKeys, ...profileKeys]
      .map((r) => String(r.storage_key ?? ""))
      .filter((k) => k.length > 0);

    const towbookDriverId = target.towbook_driver_id != null ? String(target.towbook_driver_id) : null;
    const scrubbedEmail = anonymizedEmail(user.id);
    const scrubbedHash = randomBytes(24).toString("hex"); // never verifiable

    const statements = [
      q`DELETE FROM driver_locations WHERE org_id=${user.orgId} AND driver_id=${user.id}`,
      q`DELETE FROM job_photos WHERE org_id=${user.orgId} AND uploaded_by_user_id=${user.id}`,
      q`DELETE FROM contractor_documents WHERE org_id=${user.orgId} AND contractor_id=${user.id}`,
      q`DELETE FROM contractor_doc_selfies WHERE org_id=${user.orgId} AND contractor_id=${user.id}`,
      q`DELETE FROM contractor_profiles WHERE org_id=${user.orgId} AND user_id=${user.id}`,
      q`DELETE FROM payout_methods WHERE org_id=${user.orgId} AND contractor_id=${user.id}`,
      q`DELETE FROM push_subscriptions WHERE org_id=${user.orgId} AND user_id=${user.id}`,
      q`DELETE FROM apns_device_tokens WHERE org_id=${user.orgId} AND user_id=${user.id}`,
      q`DELETE FROM academy_progress WHERE org_id=${user.orgId} AND user_id=${user.id}`,
      q`DELETE FROM driver_availability_log WHERE org_id=${user.orgId} AND user_id=${user.id}`,
      q`DELETE FROM contractor_schedules WHERE org_id=${user.orgId} AND user_id=${user.id}`,
      q`DELETE FROM contractor_services WHERE org_id=${user.orgId} AND contractor_id=${user.id}`,
      q`DELETE FROM sessions WHERE user_id=${user.id}`,
    ];
    if (towbookDriverId) {
      statements.push(
        q`DELETE FROM towbook_sessions WHERE org_id=${user.orgId} AND session_kind='driver' AND towbook_driver_id=${towbookDriverId}`,
      );
    }
    statements.push(
      q`UPDATE users SET name='Deleted account', email=${scrubbedEmail}, password_hash=${scrubbedHash}, login_handle=NULL, towbook_driver_id=NULL, towbook_user_id=NULL, linked_driver_user_id=NULL, deactivated_at=NOW() WHERE id=${user.id}`,
      q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail)
        VALUES(gen_random_uuid()::text, ${user.orgId}, ${user.id}, 'contractor', 'account_deleted', 'user', ${user.id}, '{}'::jsonb)`,
    );
    // Run sequentially (not Neon batch transaction): Neon's prepared-statement
    // cache reuses names by query text and errors with "bind message supplies
    // N parameters" when a batch reuses text with a different arity. Each
    // statement is a distinct text, so sequential execution is safe and avoids
    // the batch arity collision while still applying every deletion.
    for (const statement of statements) await statement;

    // Retained-count evidence (payroll/tax records that MUST survive).
    const retained = {
      jobRecords: Number((await q`SELECT COUNT(*)::int AS n FROM dispatch_jobs WHERE org_id=${user.orgId} AND assigned_driver_towbook_id=${towbookDriverId}`)[0]?.n ?? 0),
      payoutRecords: Number((await q`SELECT COUNT(*)::int AS n FROM payout_records WHERE org_id=${user.orgId} AND contractor_id=${user.id}`)[0]?.n ?? 0),
      tipRecords: Number((await q`SELECT COUNT(*)::int AS n FROM completion_tips WHERE org_id=${user.orgId} AND driver_id=${user.id}`)[0]?.n ?? 0),
      taxFormSubmissions: Number((await q`SELECT COUNT(*)::int AS n FROM contractor_form_submissions WHERE org_id=${user.orgId} AND contractor_id=${user.id}`)[0]?.n ?? 0),
    };

    // Best-effort B2 object deletion (never fail the account deletion for it).
    await deleteB2Objects(b2Keys, opts);

    return { ok: true, deletedUserId: user.id, retained };
  } catch (err) {
    return { ok: false, code: "database_error", message: err instanceof Error ? err.message : "Account deletion failed. Try again or email lightroad29@gmail.com." };
  }
}

async function deleteB2Objects(keys: string[], opts: { fetchImpl?: typeof fetch; b2StableDir?: string }): Promise<void> {
  if (!keys.length) return;
  try {
    const config = await loadB2Config(undefined, { stableDir: opts.b2StableDir });
    const auth = await authorizeAccount({ keyId: config.keyId, applicationKey: config.applicationKey, fetchImpl: opts.fetchImpl });
    for (const key of keys) {
      try {
        await deleteObject({ config, s3ApiUrl: auth.s3ApiUrl, key, fetchImpl: opts.fetchImpl });
      } catch {
        /* best-effort per object */
      }
    }
  } catch {
    /* B2 unconfigured/unreachable — DB rows are already gone; orphaned objects are acceptable */
  }
}
