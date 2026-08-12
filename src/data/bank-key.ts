import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Bank payout detail encryption key (owner-directed 2026-08-12 — Plaid
 * DROPPED, manual bank rail instead). Routing + account numbers entered by the
 * contractor for the Bank payout rail are PII of the highest order — they are
 * stored ONLY as AES-256-GCM ciphertext under a DEDICATED key (separate from
 * the Towbook session key so the two secret classes never share a key).
 *
 * PUBLISH-SAFE KEY RESOLUTION (same pattern as towbook-key.ts): the key lives
 * OUTSIDE the repo and outside the build output, at
 * <site-root-parent>/.secrets/bank.key — i.e. /home/team/shared/.secrets/
 * bank.key for this deployment — which a build can never touch. prepare-
 * secrets.sh additionally embeds a copy at dist/.secrets/bank.key for the
 * hosted CloudFront deployment (which cannot read machine-local files).
 *
 * Resolution order (first match wins):
 *   1. BANK_ENCRYPTION_KEY env var — base64 of exactly 32 bytes (validated).
 *   2. BANK_ENCRYPTION_KEY_FILE env var — explicit path to a key file.
 *   3. Stable key file at <site-root-parent>/.secrets/bank.key (outside the
 *      repo and outside the build output) — auto-generated with
 *      crypto.randomBytes(32) on first use (mkdir -p, chmod 600).
 *   4. Legacy: dist/.secrets/bank.key (embedded by prepare-secrets.sh) or the
 *      source-tree .secrets/bank.key — copied to the stable path once.
 *
 * The key value itself is never logged and never written to any tracked file.
 * The ciphertext envelope is "v1.<iv b64>.<auth tag b64>.<ciphertext b64>"
 * (same shape as towbook session encryption). Full numbers NEVER appear in
 * logs, audit detail, or any contractor-facing read — decrypt happens only
 * server-side for the owner surface (listPayoutMethodsCore /
 * getContractorPayoutMethodCore) and for micro-deposit confirmation.
 */

export function findSiteRoot(fromUrl: string): string {
  let dir = dirname(fileURLToPath(fromUrl));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const SITE_ROOT = findSiteRoot(import.meta.url);
/** Stable, publish-proof key path: sibling of the site root, outside the repo. */
const STABLE_KEY_FILE = join(dirname(SITE_ROOT), ".secrets", "bank.key");
/** Legacy pre-fix locations (build-output + source-tree) for one-time migration. */
const LEGACY_KEY_FILES = [join(SITE_ROOT, "dist", ".secrets", "bank.key"), join(SITE_ROOT, ".secrets", "bank.key")];

function decodeKey(value: string, source: string): Buffer {
  const k = Buffer.from(value.trim(), "base64");
  if (k.length !== 32) {
    throw new Error(`${source} must be base64 of exactly 32 bytes (got ${k.length})`);
  }
  return k;
}

async function readKeyFile(path: string): Promise<Buffer> {
  return decodeKey(await readFile(path, "utf8"), `bank key file ${path}`);
}

/** Provision a fresh 32-byte key at the stable path (mkdir -p, chmod 600). */
async function provisionKeyFile(): Promise<Buffer> {
  await mkdir(dirname(STABLE_KEY_FILE), { recursive: true, mode: 0o700 });
  const generated = randomBytes(32).toString("base64");
  await writeFile(STABLE_KEY_FILE, generated + "\n", { mode: 0o600 });
  await chmod(STABLE_KEY_FILE, 0o600);
  return Buffer.from(generated, "base64");
}

async function migrateLegacyKey(path: string): Promise<void> {
  try {
    await mkdir(dirname(STABLE_KEY_FILE), { recursive: true, mode: 0o700 });
    await copyFile(path, STABLE_KEY_FILE);
    await chmod(STABLE_KEY_FILE, 0o600);
  } catch { /* caller falls back to reading the legacy file directly */ }
}

export async function loadBankKey(): Promise<Buffer> {
  const env = process.env.BANK_ENCRYPTION_KEY;
  if (env) return decodeKey(env, "BANK_ENCRYPTION_KEY");
  const envFile = process.env.BANK_ENCRYPTION_KEY_FILE;
  if (envFile) {
    try { return await readKeyFile(envFile); } catch (err) {
      throw new Error(`BANK_ENCRYPTION_KEY_FILE ${envFile} is not readable: ${String(err)}`);
    }
  }
  try {
    return await readKeyFile(STABLE_KEY_FILE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  for (const legacy of LEGACY_KEY_FILES) {
    try {
      const key = await readKeyFile(legacy);
      await migrateLegacyKey(legacy);
      return key;
    } catch { /* try the next legacy location */ }
  }
  return provisionKeyFile();
}

/** Encrypt a bank value (routing / account number). Returns the "v1.…"
 *  envelope. Never log the plaintext or the ciphertext in a way that links to
 *  the value's meaning. */
export async function encryptBankValue(value: string): Promise<string> {
  const key = await loadBankKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${encrypted.toString("base64")}`;
}

/** Reverse of encryptBankValue. Throws on a wrong key (GCM tag mismatch), a
 *  malformed envelope, or tampered ciphertext — callers surface that as a
 *  generic error rather than leaking anything. */
export async function decryptBankValue(value: string): Promise<string> {
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Unrecognized encrypted bank value format");
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const key = await loadBankKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  return plain.toString("utf8");
}
