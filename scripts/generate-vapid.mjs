#!/usr/bin/env bun
// Generate the Web-Push VAPID keypair for the assigned-offer push notification
// (owner top priority 2026-08-12). Writes TWO files next to the other runtime
// secrets at <site-root-parent>/.secrets/ (i.e. /home/team/shared/.secrets/),
// which scripts/prepare-secrets.sh copies into dist/.secrets on every build:
//   push-vapid-public.key   — base64url of the RAW 65-byte uncompressed P-256
//                              point (0x04 || X || Y). This exact string is what
//                              the browser needs as `applicationServerKey` and
//                              what the VAPID JWT `k` parameter carries.
//   push-vapid-private.key  — base64url of the 32-byte private scalar d.
// The keypair is generated ONCE and persisted; re-running is a no-op when both
// files already exist (never rotate under live subscriptions).
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const secretsDir = join(dirname(siteRoot), ".secrets");
const pubFile = join(secretsDir, "push-vapid-public.key");
const privFile = join(secretsDir, "push-vapid-private.key");

if (existsSync(pubFile) && existsSync(privFile)) {
  console.log("generate-vapid: keypair already present — nothing to do.");
  process.exit(0);
}

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pubJwk = publicKey.export({ format: "jwk" }); // x, y as base64url
const privJwk = privateKey.export({ format: "jwk" }); // d as base64url
const b64 = (v) => Buffer.from(v, "base64url");
const rawPub = Buffer.concat([Buffer.from([0x04]), b64(pubJwk.x), b64(pubJwk.y)]);

await mkdir(secretsDir, { recursive: true, mode: 0o700 });
await writeFile(pubFile, rawPub.toString("base64url") + "\n", { mode: 0o600 });
await writeFile(privFile, privJwk.d + "\n", { mode: 0o600 });
console.log(
  `generate-vapid: wrote ${pubFile}\n  and ${privFile}\n` +
  `  public key (base64url, ${rawPub.length} bytes raw): ${rawPub.toString("base64url").slice(0, 24)}…`,
);
