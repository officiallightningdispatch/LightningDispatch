import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Towbook session encryption key provisioning.
 *
 * PUBLISH-SAFE KEY RESOLUTION (fix 2026-08-11): the key must survive a clean
 * rebuild. The old resolver wrote the key relative to the BUNDLE location
 * (dist/.secrets/towbook.key), so any publish that cleaned dist/ silently
 * rotated the key and orphaned the stored session ("session unavailable" on
 * every sync until reconnect). The key now lives OUTSIDE the repo and outside
 * the build output, at <site-root-parent>/.secrets/towbook.key — i.e.
 * /home/team/shared/.secrets/towbook.key for this deployment — which a build
 * can never touch.
 *
 * Resolution order (first match wins):
 *   1. TOWBOOK_SESSION_KEY env var — base64 of exactly 32 bytes (validated).
 *   2. TOWBOOK_SESSION_KEY_FILE env var — explicit path to a key file.
 *   3. Stable key file at <site-root-parent>/.secrets/towbook.key (outside the
 *      repo and outside the build output) — auto-generated with
 *      crypto.randomBytes(32) on first use (mkdir -p, chmod 600).
 *   4. LEGACY one-time migration: a key file left behind by an older build at
 *      <site-root>/dist/.secrets/towbook.key, or the even older source-tree
 *      <site-root>/.secrets/towbook.key, is copied to the stable path (once)
 *      and used — so a pre-fix deployment's stored session keeps decrypting
 *      after upgrade without a manual reconnect.
 *
 * The site root is found by walking UP from this module's URL (from either the
 * source tree or the bundle, where it sits at dist/server/assets/) to the
 * directory that contains package.json — that is what makes the stable path
 * the SAME file for source runs, tests, and the published bundle.
 *
 * The key value itself is never logged and never written to any tracked file.
 */

function findSiteRoot(fromUrl: string): string {
  let dir = dirname(fileURLToPath(fromUrl));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: serve.ts always starts from the site root (publish.sh cds there).
  return process.cwd();
}

const SITE_ROOT = findSiteRoot(import.meta.url);
/** Stable, publish-proof key path: sibling of the site root, outside the repo. */
const STABLE_KEY_FILE = join(dirname(SITE_ROOT), ".secrets", "towbook.key");
/** Legacy pre-fix locations (build-output + source-tree) for one-time migration. */
const LEGACY_KEY_FILES = [join(SITE_ROOT, "dist", ".secrets", "towbook.key"), join(SITE_ROOT, ".secrets", "towbook.key")];

function decodeKey(value: string, source: string): Buffer {
  const k = Buffer.from(value.trim(), "base64");
  if (k.length !== 32) {
    throw new Error(`${source} must be base64 of exactly 32 bytes (got ${k.length})`);
  }
  return k;
}

async function readKeyFile(path: string): Promise<Buffer> {
  return decodeKey(await readFile(path, "utf8"), `session key file ${path}`);
}

/** Provision a fresh 32-byte key at the stable path (mkdir -p, chmod 600). */
async function provisionKeyFile(): Promise<Buffer> {
  await mkdir(dirname(STABLE_KEY_FILE), { recursive: true, mode: 0o700 });
  const generated = randomBytes(32).toString("base64");
  await writeFile(STABLE_KEY_FILE, generated + "\n", { mode: 0o600 });
  await chmod(STABLE_KEY_FILE, 0o600);
  return Buffer.from(generated, "base64");
}

/** One-time migration: copy a legacy (pre-fix) key to the stable path so the
 *  stored session keeps decrypting after upgrade. Best-effort — if the copy
 *  fails the legacy file is still used directly (the caller then falls back). */
async function migrateLegacyKey(path: string): Promise<void> {
  try {
    await mkdir(dirname(STABLE_KEY_FILE), { recursive: true, mode: 0o700 });
    await copyFile(path, STABLE_KEY_FILE);
    await chmod(STABLE_KEY_FILE, 0o600);
  } catch { /* caller falls back to reading the legacy file directly */ }
}

export async function loadSessionKey(): Promise<Buffer> {
  const env = process.env.TOWBOOK_SESSION_KEY;
  if (env) return decodeKey(env, "TOWBOOK_SESSION_KEY");
  const envFile = process.env.TOWBOOK_SESSION_KEY_FILE;
  if (envFile) {
    try { return await readKeyFile(envFile); } catch (err) {
      throw new Error(`TOWBOOK_SESSION_KEY_FILE ${envFile} is not readable: ${String(err)}`);
    }
  }
  try {
    return await readKeyFile(STABLE_KEY_FILE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  // Stable path missing: migrate a legacy key once, otherwise provision fresh.
  for (const legacy of LEGACY_KEY_FILES) {
    try {
      const key = await readKeyFile(legacy);
      await migrateLegacyKey(legacy);
      return key;
    } catch { /* try the next legacy location */ }
  }
  return provisionKeyFile();
}

export async function encryptSession(value: string): Promise<string> {
  const key = await loadSessionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${encrypted.toString("base64")}`;
}

/** Reverse of encryptSession. Throws on a wrong key (GCM tag mismatch), a
 *  malformed envelope, or tampered ciphertext — callers surface that as
 *  "session unavailable on this host, reconnect Towbook" rather than leaking
 *  anything. The value never touches logs. */
export async function decryptSession(value: string): Promise<string> {
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Unrecognized encrypted session format");
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const key = await loadSessionKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  return plain.toString("utf8");
}
