/**
 * Backblaze B2 (S3-compatible) client — SERVER-ONLY.
 *
 * Photo workflow (milestone #4) storage. Imported ONLY by the server-only
 * photo core (src/data/driver-photos-core.ts) and hermetic tests — never by
 * client-reachable modules (node:crypto signing would leak into the client
 * bundle). Uses a small fetch-based AWS Signature V4 implementation (B2's
 * S3-compatible API speaks standard SigV4); no SDK dependency.
 *
 * Credential resolution mirrors towbook-key.ts (env → explicit file → stable
 * files; first match wins):
 *   key id:        B2_KEY_ID            → B2_KEY_ID_FILE            → <site-parent>/.secrets/b2-key-id
 *                                                                    → <site-root>/dist/.secrets/b2-key-id
 *                                                                    → <site-root>/.secrets/b2-key-id
 *   app key:       B2_APPLICATION_KEY   → B2_APPLICATION_KEY_FILE   → <site-parent>/.secrets/b2-application-key
 *                                                                    → <site-root>/dist/.secrets/b2-application-key
 *                                                                    → <site-root>/.secrets/b2-application-key
 *   bucket:        B2_BUCKET_NAME       → B2_BUCKET_NAME_FILE       → <site-parent>/.secrets/b2-bucket-name
 *                                                                    → <site-root>/dist/.secrets/b2-bucket-name
 *                                                                    → <site-root>/.secrets/b2-bucket-name
 * The sibling <site-parent>/.secrets path is preferred (publish-proof, outside
 * the repo and the build output). The artifact fallbacks exist for the HOSTED
 * live deployment (…ctonew.app, a CloudFront snapshot whose runtime cannot
 * read the machine-local sibling dir): the build embeds the three files at
 * dist/.secrets, and the source-tree .secrets covers local source runs. The
 * artifact fallback is skipped whenever the caller pins resolution with
 * opts.stableDir (hermetic tests load only their fixtures), unless the caller
 * explicitly opts in with allowArtifactFallback.
 * Unlike the session key, a missing B2 credential FAILS loudly (structured
 * error) — photo upload is a hard gate on completing a job, so a photo is
 * never silently dropped. Nothing is ever auto-generated.
 *
 * The S3 endpoint is discovered from B2's authorize endpoint
 * (POST https://api.backblazeb2.com/b2api/v3/b2_authorize_account) using the
 * application key itself — no region hardcoding; the result is cached briefly.
 */
import { createHmac, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { findSiteRoot } from "./towbook-key";

const SITE_ROOT = findSiteRoot(import.meta.url);
/** Stable, publish-proof key path: sibling of the site root, outside the repo. */
const STABLE_DIR = join(dirname(SITE_ROOT), ".secrets");
/** Artifact fallbacks (mirror towbook-key.ts LEGACY_KEY_FILES): the hosted
 *  live deployment cannot read the machine-local sibling dir, so the build
 *  embeds the creds at <site-root>/dist/.secrets (preferred over the
 *  source-tree .secrets, which only local source runs would have). */
const ARTIFACT_DIRS = [join(SITE_ROOT, "dist", ".secrets"), join(SITE_ROOT, ".secrets")];

export type B2Config = { keyId: string; applicationKey: string; bucketName: string };

const readEnvOrFile = async (env: string | undefined, envFile: string | undefined, stableFiles: string[]): Promise<string | null> => {
  if (env && env.trim() !== "") return env.trim();
  if (envFile) {
    try {
      const v = (await readFile(envFile, "utf8")).trim();
      if (!v) throw new Error(`${envFile} is empty`);
      return v;
    } catch (err) {
      throw new Error(`${envFile} is not readable: ${String(err)}`);
    }
  }
  for (const file of stableFiles) {
    try {
      const v = (await readFile(file, "utf8")).trim();
      if (v) return v;
    } catch { /* try the next candidate */ }
  }
  return null;
};

/** Resolve the B2 credentials. Throws a clear, structured error when any of
 *  the three parts is missing — callers surface it as a hard failure, never a
 *  fake success.
 *
 *  Hermeticity: when opts.stableDir is passed (tests pin their fixtures) the
 *  artifact fallback dirs are NOT consulted, so a test can never accidentally
 *  resolve the real production creds. The artifact fallback applies only on
 *  the production path (no stableDir override), or when the caller explicitly
 *  opts in with allowArtifactFallback (verification harnesses). */
export async function loadB2Config(env: NodeJS.ProcessEnv = process.env, opts: { stableDir?: string; allowArtifactFallback?: boolean } = {}): Promise<B2Config> {
  const stableDir = opts.stableDir ?? STABLE_DIR;
  const fallbackDirs = opts.stableDir && !opts.allowArtifactFallback ? [] : ARTIFACT_DIRS;
  const searchedDirs = [stableDir, ...fallbackDirs];
  const filesFor = (name: string) => [join(stableDir, name), ...fallbackDirs.map((dir) => join(dir, name))];
  const [keyId, applicationKey, bucketName] = await Promise.all([
    readEnvOrFile(env.B2_KEY_ID, env.B2_KEY_ID_FILE, filesFor("b2-key-id")),
    readEnvOrFile(env.B2_APPLICATION_KEY, env.B2_APPLICATION_KEY_FILE, filesFor("b2-application-key")),
    readEnvOrFile(env.B2_BUCKET_NAME, env.B2_BUCKET_NAME_FILE, filesFor("b2-bucket-name")),
  ]);
  const missing: string[] = [];
  if (!keyId) missing.push("B2_KEY_ID (or a b2-key-id file in .secrets)");
  if (!applicationKey) missing.push("B2_APPLICATION_KEY (or a b2-application-key file in .secrets)");
  if (!bucketName) missing.push("B2_BUCKET_NAME (or a b2-bucket-name file in .secrets)");
  if (missing.length) {
    throw new Error(`Backblaze B2 is not configured — missing ${missing.join(", ")}. Searched: ${searchedDirs.join(", ")}. Photo uploads are a hard gate on job completion.`);
  }
  return { keyId: keyId!, applicationKey: applicationKey!, bucketName: bucketName! };
}

/* --------------------------- AWS Signature V4 (pure) --------------------------- */

const hmac = (key: string | Buffer, data: string): Buffer =>
  createHmac("sha256", key).update(data, "utf8").digest();
const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** Sign an AWS SigV4 request (the standard B2's S3-compatible API accepts).
 *  Pure + exported so hermetic tests assert against the AWS documentation's
 *  own test vector. payloadHash defaults to the SHA-256 of the (known) body. */
export function signV4(opts: {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
  method: string;
  host: string;
  path: string;
  query?: string;
  headers?: Record<string, string>;
  payloadHash?: string;
  now?: Date;
}): { authorization: string; xAmzDate: string; xAmzContentSha256: string; signedHeaders: string } {
  const service = opts.service ?? "s3";
  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = opts.payloadHash ?? sha256Hex("");
  const xAmzContentSha256 = payloadHash;
  const headers: Record<string, string> = { host: opts.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, ...(opts.headers ?? {}) };
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) normalized[k.toLowerCase()] = v;
  const sorted = Object.keys(normalized).sort();
  const canonicalHeaders = sorted.map((k) => `${k}:${normalized[k].trim()}\n`).join("");
  const signedHeaders = sorted.map((k) => k.toLowerCase()).join(";");
  const canonicalQuery = (opts.query ?? "").replace(/^\?/, "");
  const canonicalRequest = [
    opts.method.toUpperCase(),
    opts.path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    xAmzContentSha256,
  ].join("\n");
  const scope = `${dateStamp}/${opts.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${opts.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, opts.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    xAmzDate: amzDate,
    xAmzContentSha256,
    signedHeaders,
  };
}

/** Region parsed from a B2 S3 API URL hostname (s3.<region>.backblazeb2.com). */
export function regionFromS3Url(s3ApiUrl: string): string {
  try {
    const host = new URL(s3ApiUrl).hostname;
    const m = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/i.exec(host);
    if (m) return m[1];
  } catch { /* fall through */ }
  return "us-west-002";
}

/* --------------------------------- authorize --------------------------------- */

export type B2Authorized = { s3ApiUrl: string; bucketName: string | null };
let cachedAuthorize: { at: number; value: B2Authorized } | null = null;

/** POST /b2api/v3/b2_authorize_account with HTTP Basic (keyId:applicationKey)
 *  → the S3 API URL + the bucket the key is allowed to touch. Cached ~10 min.
 *  Injectable fetchImpl for hermetic tests (no real B2 calls in tests). */
export async function authorizeAccount(opts: { keyId: string; applicationKey: string; fetchImpl?: typeof fetch }): Promise<B2Authorized> {
  if (cachedAuthorize && Date.now() - cachedAuthorize.at < 10 * 60_000) return cachedAuthorize.value;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const basic = Buffer.from(`${opts.keyId}:${opts.applicationKey}`).toString("base64");
  const res = await fetchImpl("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", {
    method: "GET",
    headers: { authorization: `Basic ${basic}` },
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let body: unknown = text;
  if (text) { try { body = JSON.parse(text); } catch { /* keep raw */ } }
  if (!res.ok || !body || typeof body !== "object") {
    throw new Error(`B2 authorize failed (HTTP ${res.status ?? "error"}) — check B2_KEY_ID / B2_APPLICATION_KEY.`);
  }
  const apiInfo = (body as Record<string, unknown>).apiInfo as Record<string, unknown> | undefined;
  const allowed = (body as Record<string, unknown>).allowed as Record<string, unknown> | undefined;
  // v3 shape nests the S3 endpoint under apiInfo.storageApi.s3ApiUrl; older
  // shapes put it directly at apiInfo.s3ApiUrl. Account-wide keys return
  // allowed.bucketName = null (the bucket comes from config), so only the S3
  // endpoint is required here.
  const storageApi = (apiInfo?.storageApi ?? null) as Record<string, unknown> | null;
  const s3ApiUrl = typeof storageApi?.s3ApiUrl === "string" && storageApi.s3ApiUrl
    ? storageApi.s3ApiUrl
    : typeof apiInfo?.s3ApiUrl === "string" && apiInfo.s3ApiUrl ? apiInfo.s3ApiUrl : null;
  const bucketName = typeof allowed?.bucketName === "string" && allowed.bucketName ? allowed.bucketName : null;
  if (!s3ApiUrl) {
    throw new Error("B2 authorize did not return an S3 endpoint — check the application key's capabilities.");
  }
  const value = { s3ApiUrl, bucketName };
  cachedAuthorize = { at: Date.now(), value };
  return value;
}

/* ------------------------------ object operations ------------------------------ */

export type B2PutResult = { ok: boolean; status: number | null; body: unknown };
export type B2GetResult = { ok: boolean; status: number | null; bytes: Uint8Array | null };

/** SigV4 PUT of an object. The body is fully buffered, so the payload SHA-256
 *  is signed (the most compatible form). Injectable fetchImpl for tests. */
export async function putObject(opts: {
  config: B2Config;
  s3ApiUrl: string;
  key: string;
  bytes: Uint8Array;
  contentType?: string;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<B2PutResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const region = regionFromS3Url(opts.s3ApiUrl);
  const u = new URL(`${opts.s3ApiUrl}/${encodeBucketPath(opts.config.bucketName)}/${encodeKey(opts.key)}`);
  const signed = signV4({
    accessKeyId: opts.config.keyId,
    secretAccessKey: opts.config.applicationKey,
    region,
    method: "PUT",
    host: u.host,
    path: u.pathname,
    headers: { "content-type": opts.contentType ?? "application/octet-stream", "content-length": String(opts.bytes.length) },
    payloadHash: sha256Hex(opts.bytes),
    now: opts.now,
  });
  const res = await fetchImpl(u.toString(), {
    method: "PUT",
    headers: {
      authorization: signed.authorization,
      "x-amz-date": signed.xAmzDate,
      "x-amz-content-sha256": signed.xAmzContentSha256,
      "content-type": opts.contentType ?? "application/octet-stream",
      "content-length": String(opts.bytes.length),
    },
    body: Buffer.from(opts.bytes),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let body: unknown = text;
  if (text) { try { body = JSON.parse(text); } catch { /* keep raw */ } }
  return { ok: res.status >= 200 && res.status < 300, status: res.status, body };
}

/** SigV4 GET of an object (used on completion to read the stored photos back
 *  and forward them to the Towbook PO). Injectable fetchImpl for tests. */
export async function getObject(opts: {
  config: B2Config;
  s3ApiUrl: string;
  key: string;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<B2GetResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const region = regionFromS3Url(opts.s3ApiUrl);
  const u = new URL(`${opts.s3ApiUrl}/${encodeBucketPath(opts.config.bucketName)}/${encodeKey(opts.key)}`);
  const signed = signV4({
    accessKeyId: opts.config.keyId,
    secretAccessKey: opts.config.applicationKey,
    region,
    method: "GET",
    host: u.host,
    path: u.pathname,
    payloadHash: sha256Hex(""),
    now: opts.now,
  });
  const res = await fetchImpl(u.toString(), {
    method: "GET",
    headers: {
      authorization: signed.authorization,
      "x-amz-date": signed.xAmzDate,
      "x-amz-content-sha256": signed.xAmzContentSha256,
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) return { ok: false, status: res.status, bytes: null };
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { ok: true, status: res.status, bytes };
}

/* ----------------------------------- helpers ----------------------------------- */

/** Bucket names are plain S3 path segments. */
const encodeBucketPath = (bucket: string) => bucket.replace(/[^a-zA-Z0-9._-]/g, "_");
/** Object keys contain our own id chars only; encode defensively for the URL. */
const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");
