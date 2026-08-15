/**
 * Server-only image storage boundary.
 *
 * This deliberately owns the storage lifecycle without knowing about dispatch,
 * Towbook, or any particular image table: callers resolve and authorize their
 * DB record first, then pass the persisted key and the metadata they recorded.
 * A URL/data result is never returned until B2 HEAD verification succeeds.
 */
import { authorizeAccount, getObject, headObject, loadB2Config, putObject } from "./b2-client";

export type ImageBlobContract = {
  key: string;
  byteLength: number;
  contentType: string;
};

export type ImageStorageOptions = {
  fetchImpl?: typeof fetch;
  b2StableDir?: string;
};

export type ImageStorageResult =
  | { ok: true; key: string; byteLength: number; contentType: string }
  | { ok: false; code: "storage_unavailable" | "upload_failed" | "verification_failed"; message: string };

export type ImageReadResult =
  | { ok: true; key: string; bytes: Uint8Array; dataUrl: string; contentType: string }
  | { ok: false; code: "storage_unavailable" | "verification_failed"; message: string };

async function b2Connection(opts: ImageStorageOptions) {
  const config = await loadB2Config(undefined, { stableDir: opts.b2StableDir });
  const auth = await authorizeAccount({ keyId: config.keyId, applicationKey: config.applicationKey, fetchImpl: opts.fetchImpl });
  return { config, s3ApiUrl: auth.s3ApiUrl };
}

/** Verify the object metadata contract recorded by the owning DB row.
 * B2 is authoritative for existence, byte length, and content type. */
export async function verify(contract: ImageBlobContract, opts: ImageStorageOptions = {}): Promise<boolean> {
  try {
    const b2 = await b2Connection(opts);
    const result = await headObject({ ...b2, key: contract.key, fetchImpl: opts.fetchImpl });
    return result.ok && result.contentType != null && result.contentLength === contract.byteLength && result.contentType.toLowerCase() === contract.contentType.toLowerCase();
  } catch {
    return false;
  }
}

/** Authorize, write, then verify before exposing a successful result. */
export async function run(contract: ImageBlobContract, bytes: Uint8Array, opts: ImageStorageOptions = {}): Promise<ImageStorageResult> {
  if (bytes.byteLength !== contract.byteLength) return { ok: false, code: "verification_failed", message: "Image metadata does not match the stored DB contract." };
  try {
    const b2 = await b2Connection(opts);
    const put = await putObject({ ...b2, key: contract.key, bytes, contentType: contract.contentType, fetchImpl: opts.fetchImpl });
    if (!put.ok) return { ok: false, code: "upload_failed", message: `Image storage rejected the upload (HTTP ${put.status ?? "error"}).` };
    if (!(await verifyWithConnection(b2, contract, opts))) return { ok: false, code: "verification_failed", message: "Image upload could not be verified." };
    return { ok: true, key: contract.key, byteLength: contract.byteLength, contentType: contract.contentType };
  } catch (err) {
    return { ok: false, code: "storage_unavailable", message: err instanceof Error ? err.message : "Image storage is unavailable." };
  }
}

async function verifyWithConnection(b2: Awaited<ReturnType<typeof b2Connection>>, contract: ImageBlobContract, opts: ImageStorageOptions) {
  const result = await headObject({ ...b2, key: contract.key, fetchImpl: opts.fetchImpl });
  return result.ok && result.contentType != null && result.contentLength === contract.byteLength && result.contentType.toLowerCase() === contract.contentType.toLowerCase();
}

/** Read-only path: DB resolution/authorization remains the caller's concern.
 * Data is suppressed when the B2 object is missing or mismatched. */
export async function read(contract: ImageBlobContract, opts: ImageStorageOptions = {}): Promise<ImageReadResult> {
  try {
    const b2 = await b2Connection(opts);
    if (!(await verifyWithConnection(b2, contract, opts))) return { ok: false, code: "verification_failed", message: "Image storage verification failed." };
    const got = await getObject({ ...b2, key: contract.key, fetchImpl: opts.fetchImpl });
    if (!got.ok || !got.bytes || got.bytes.byteLength !== contract.byteLength) return { ok: false, code: "verification_failed", message: "Image data failed verification." };
    return { ok: true, key: contract.key, bytes: got.bytes, dataUrl: `data:${contract.contentType};base64,${Buffer.from(got.bytes).toString("base64")}`, contentType: contract.contentType };
  } catch (err) {
    return { ok: false, code: "storage_unavailable", message: err instanceof Error ? err.message : "Image storage is unavailable." };
  }
}
