/**
 * Driver profile photo — SERVER-ONLY CORE (driver-portal feature batch 7,
 * owner-directed 2026-08-12). The driver uploads/changes their profile photo
 * (avatar); bytes go to the SAME B2 infra as the job-photo workflow
 * (loadB2Config + authorizeAccount + putObject/getObject, bucket
 * lightning-dispatch-photos) under the key
 * `profile-photos/<orgId>/<userId>/avatar` — deterministic, so a re-upload
 * overwrites the same object. The B2 key is recorded on
 * contractor_profiles.profile_photo_key (migration 28). The avatar shows in
 * the driver-portal header/nav once set.
 *
 * White-label: no Towbook mention anywhere — this surface is Lightning
 * Dispatch's own.
 *
 * Testability (same split as driver-photos-core): handlers are thin auth
 * wrappers over `*Core` functions that take an explicit user context —
 * hermetic tests call the cores directly with mock B2 fetches + stableDir
 * fixtures.
 *
 * Imported ONLY by the client-safe facade (src/data/driver-profile-photo.ts,
 * whose createServerFn handlers dynamic-import this module) and by hermetic
 * tests. Static server imports are fine here — this module never enters the
 * client bundle graph (node:crypto lives in b2-client.ts).
 */
import { z } from "zod";
import { loadB2Config, authorizeAccount, putObject, getObject } from "./b2-client";

/* --------------------------------- helpers --------------------------------- */
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

export type ProfilePhotoUser = { orgId: string; id: string; role: string; actorUserId?: string; actorRole?: string; ownerInDriverView?: boolean };

export type ProfilePhotoResult =
  | { ok: true; storageKey: string | null; dataUrl: string | null; mime: string | null }
  | { ok: false; code: "invalid_input" | "b2_not_configured" | "b2_failed" | "not_found" | "unauthorized" | "database_error"; message: string };

function decodeImageDataUrl(dataUrl: string): { bytes: Uint8Array; mime: string } | null {
  const m = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (mime !== "image/jpeg" && mime !== "image/png" && mime !== "image/webp") return null;
  return { bytes: new Uint8Array(Buffer.from(m[2], "base64")), mime };
}

const profilePhotoKey = (orgId: string, userId: string) => `profile-photos/${orgId}/${userId}/avatar`;

/** Upload (or replace) the driver's profile photo. B2 put (same object key —
 *  a re-upload overwrites) + contractor_profiles.profile_photo_key upsert +
 *  best-effort audit. Returns the storage key; the client re-reads via
 *  getMyProfilePhoto. Injectable fetchImpl + b2StableDir for hermetic tests. */
export async function uploadProfilePhotoCore(user: ProfilePhotoUser, data: unknown, opts: { fetchImpl?: typeof fetch; b2StableDir?: string } = {}): Promise<ProfilePhotoResult> {
  const v = z.object({ dataUrl: z.string().min(20).max(20_000_000) }).safeParse(data);
  if (!v.success) return { ok: false, code: "invalid_input", message: "Invalid photo." };
  const decoded = decodeImageDataUrl(v.data.dataUrl);
  if (!decoded) return { ok: false, code: "invalid_input", message: "The photo couldn't be read — choose a JPG, PNG or WebP image." };
  if (decoded.bytes.length < 1024) return { ok: false, code: "invalid_input", message: "The photo looks empty — choose another one." };
  if (decoded.bytes.length > 12 * 1024 * 1024) return { ok: false, code: "invalid_input", message: "The photo is too large (max 12 MB)." };
  try {
    await ensure();
    const key = profilePhotoKey(user.orgId, user.id);
    let b2;
    try {
      const config = await loadB2Config(undefined, { stableDir: opts.b2StableDir });
      const auth = await authorizeAccount({ keyId: config.keyId, applicationKey: config.applicationKey, fetchImpl: opts.fetchImpl });
      b2 = { config, s3ApiUrl: auth.s3ApiUrl };
    } catch (err) {
      return { ok: false, code: "b2_not_configured", message: err instanceof Error ? err.message : "Photo storage isn't connected." };
    }
    const put = await putObject({ config: b2.config, s3ApiUrl: b2.s3ApiUrl, key, bytes: decoded.bytes, contentType: decoded.mime, fetchImpl: opts.fetchImpl });
    if (!put.ok) return { ok: false, code: "b2_failed", message: `Photo storage rejected the upload (HTTP ${put.status ?? "error"}). Try again.` };
    const q = await db();
    await q`INSERT INTO contractor_profiles(org_id, user_id, profile_photo_key, updated_at)
      VALUES(${user.orgId}, ${user.id}, ${key}, NOW())
      ON CONFLICT (org_id, user_id) DO UPDATE SET profile_photo_key=EXCLUDED.profile_photo_key, updated_at=NOW()`;
    try {
      await q`INSERT INTO audit_log(id, org_id, actor_user_id, actor_role, action, entity_type, entity_id, detail, request_id)
        SELECT gen_random_uuid()::text, ${user.orgId}, ${user.actorUserId ?? user.id}, ${user.actorRole ?? "contractor"}, 'profile_photo_uploaded', 'contractor', ${user.id},
          jsonb_build_object('storageKey', ${key}::text, 'bytes', ${decoded.bytes.length}::int, 'mime', ${decoded.mime}::text), 'driver-portal'`;
    } catch { /* best-effort audit */ }
    return { ok: true, storageKey: key, dataUrl: null, mime: decoded.mime };
  } catch (err) {
    return { ok: false, code: "database_error", message: err instanceof Error ? err.message : "Photo upload failed. Try again." };
  }
}

/** Read the driver's profile photo bytes back as a data URL (avatar display).
 *  The B2 key is read from contractor_profiles; a missing key → ok:true with
 *  storageKey:null (no photo set — the client shows initials). */
export async function getProfilePhotoCore(user: { orgId: string; id: string }, opts: { fetchImpl?: typeof fetch; b2StableDir?: string } = {}): Promise<ProfilePhotoResult> {
  try {
    await ensure();
    const q = await db();
    const rows = await q`SELECT profile_photo_key FROM contractor_profiles WHERE org_id=${user.orgId} AND user_id=${user.id} LIMIT 1`;
    const key = rows.length && rows[0].profile_photo_key != null ? String(rows[0].profile_photo_key) : null;
    if (!key) return { ok: true, storageKey: null, dataUrl: null, mime: null };
    let b2;
    try {
      const config = await loadB2Config(undefined, { stableDir: opts.b2StableDir });
      const auth = await authorizeAccount({ keyId: config.keyId, applicationKey: config.applicationKey, fetchImpl: opts.fetchImpl });
      b2 = { config, s3ApiUrl: auth.s3ApiUrl };
    } catch (err) {
      return { ok: false, code: "b2_not_configured", message: err instanceof Error ? err.message : "Photo storage isn't connected." };
    }
    const got = await getObject({ config: b2.config, s3ApiUrl: b2.s3ApiUrl, key, fetchImpl: opts.fetchImpl });
    if (!got.ok || !got.bytes) return { ok: false, code: "b2_failed", message: `Photo storage couldn't read the photo (HTTP ${got.status ?? "error"}).` };
    const mime = key.endsWith(".png") ? "image/png" : key.endsWith(".webp") ? "image/webp" : "image/jpeg";
    const b64 = Buffer.from(got.bytes).toString("base64");
    return { ok: true, storageKey: key, dataUrl: `data:${mime};base64,${b64}`, mime };
  } catch (err) {
    return { ok: false, code: "database_error", message: err instanceof Error ? err.message : "Unable to load the photo." };
  }
}
