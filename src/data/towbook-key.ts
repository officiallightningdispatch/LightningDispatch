import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Towbook session encryption key provisioning.
 *
 * Resolution order (first match wins):
 *   1. TOWBOOK_SESSION_KEY env var — base64 of exactly 32 bytes (validated).
 *   2. Persisted key file at <site>/.secrets/towbook.key — base64 of exactly
 *      32 bytes, auto-generated with crypto.randomBytes(32) on first use
 *      (mkdir -p .secrets, chmod 600). The directory is gitignored.
 *   3. (covered by 2) — the file is created if missing, so connect never
 *      hard-fails on a missing key.
 *
 * The key value itself is never logged and never written to any tracked file.
 */

// Resolves to the site root whether this module runs from src/ (source) or from
// the build output (dist/server or dist/server/assets), so the key file always
// lives at <site>/.secrets/towbook.key regardless of process cwd.
const SITE_ROOT = new URL("../../", import.meta.url);
const SECRETS_DIR = new URL("../../.secrets/", import.meta.url);
const KEY_FILE = fileURLToPath(new URL(".secrets/towbook.key", SITE_ROOT));

function decodeKey(value: string, source: string): Buffer {
  const k = Buffer.from(value.trim(), "base64");
  if (k.length !== 32) {
    throw new Error(`${source} must be base64 of exactly 32 bytes (got ${k.length})`);
  }
  return k;
}

export async function loadSessionKey(): Promise<Buffer> {
  const env = process.env.TOWBOOK_SESSION_KEY;
  if (env) return decodeKey(env, "TOWBOOK_SESSION_KEY");
  let existing: string;
  try {
    existing = await readFile(KEY_FILE, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await mkdir(SECRETS_DIR, { recursive: true, mode: 0o700 });
    const generated = randomBytes(32).toString("base64");
    await writeFile(KEY_FILE, generated + "\n", { mode: 0o600 });
    await chmod(KEY_FILE, 0o600);
    return Buffer.from(generated, "base64");
  }
  return decodeKey(existing, `session key file ${KEY_FILE} (delete the file to regenerate)`);
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
