/**
 * Minimal standards-compliant Web Push sender (server-only; owner top priority
 * 2026-08-12 — assigned-offer push). No external provider account needed: the
 * browser's PushManager gives us the push-service endpoint; this module speaks
 * the two wire protocols the push services speak:
 *
 *   1. VAPID (RFC 8292) — an ES256 JWT signed with the locally-generated P-256
 *      keypair, sent in the `Authorization: vapid t=…, k=…` header so the push
 *      service accepts messages from our origin without any signup.
 *   2. Message encryption (RFC 8188 aes128gcm + RFC 8291) — the payload is
 *      AES-128-GCM encrypted with a key derived via ECDH (P-256) between our
 *      ephemeral keypair and the subscription's `p256dh` public key, plus HKDF
 *      from the subscription's `auth` secret. The push service stores the
 *      ciphertext and hands it to the browser, which decrypts with its private
 *      key.
 *
 * Everything here is PURE (no DB, no fetch) so the hermetic suite can verify
 * it with a self-decrypt round-trip. Deliberately dependency-free (hand-rolled
 * instead of the `web-push` npm package): the stack stays lightweight and the
 * test can prove the crypto end-to-end.
 */
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from "node:crypto";

export const VAPID_SUBJECT = "https://www.lightningdispatch.app";
/** Payload TTL (seconds) — the spec A0 contract: 3600. */
export const PUSH_TTL_SECONDS = 3600;
/** aes128gcm record size — Chrome/Android, Firefox autopush, Apple all accept
 *  4096; a single unpadded record is legal for payloads < rs - 16 (RFC 8188
 *  §2.3: only intermediate records are padded). */
const RS = 4096;

const b64urlDecode = (v: string): Buffer => Buffer.from(v, "base64url");
export const b64urlEncode = (v: Buffer | Uint8Array): string => Buffer.from(v).toString("base64url");

function hkdf(ikm: Buffer, salt: Buffer, info: Buffer, len: number): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, salt, info, len));
}

/** Decode a VAPID public-key file (base64url of the raw 65-byte point). */
export function parseVapidPublicKey(value: string): { x: string; y: string; raw: Buffer } {
  const raw = b64urlDecode(value.trim());
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error("VAPID public key must be base64url of the 65-byte uncompressed P-256 point");
  }
  return { x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33, 65).toString("base64url"), raw };
}

/** Build a VAPID Authorization header value: `vapid t=<jwt>, k=<pubkey>`. */
export function buildVapidAuthorization(
  endpoint: string,
  publicKeyB64url: string,
  privateKeyB64url: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const { x, y, raw } = parseVapidPublicKey(publicKeyB64url);
  const aud = new URL(endpoint).origin; // push-service audience = endpoint origin
  const header = b64urlEncode(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64urlEncode(
    Buffer.from(JSON.stringify({ aud, exp: nowSeconds + 12 * 3600, sub: VAPID_SUBJECT })),
  );
  const signingInput = `${header}.${payload}`;
  const key = createPrivateKey({
    key: { kty: "EC", crv: "P-256", x, y, d: privateKeyB64url.trim() },
    format: "jwk",
  });
  // ES256 JWT signature = IEEE P1363 (r || s, 64 bytes) — exactly what
  // crypto.sign emits with dsaEncoding 'ieee-p1363'.
  const sig = sign("sha256", Buffer.from(signingInput, "utf8"), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${signingInput}.${b64urlEncode(sig)}, k=${b64urlEncode(raw)}`;
}

export type WebPushSubscription = { endpoint: string; p256dh: string; auth: string };

export type EncryptedPush = {
  body: Buffer;
  headers: Record<string, string>;
};

/**
 * Encrypt a payload for a subscription (RFC 8291) and return the POST body +
 * headers. Throws on malformed keys — callers treat that as a per-subscription
 * send failure (audited, never fatal).
 */
export function encryptPush(
  sub: WebPushSubscription,
  payload: string | Buffer,
  keys: { publicKey: string; privateKey: string },
): EncryptedPush {
  const uaPublic = b64urlDecode(sub.p256dh);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error("subscription p256dh is not a P-256 point");
  const auth = b64urlDecode(sub.auth);
  if (auth.length !== 16) throw new Error("subscription auth must be 16 bytes");

  const { x, y, d } = {
    x: undefined as string | undefined,
    y: undefined as string | undefined,
    d: keys.privateKey.trim(),
  };
  // The private-key file stores only the 32-byte scalar; rebuild the ephemeral
  // keypair FROM it so the public point matches the JWT k param exactly.
  const parsed = parseVapidPublicKey(keys.publicKey);
  void x; void y; // (kept for symmetry with buildVapidAuthorization)
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(b64urlDecode(d));
  const asPublic = ecdh.getPublicKey(); // 65-byte uncompressed — must equal parsed.raw
  if (!asPublic.equals(parsed.raw)) {
    throw new Error("VAPID private key does not match the public key file");
  }
  const secret = ecdh.computeSecret(uaPublic);
  const salt = randomBytes(16);

  const prk = hkdf(secret, auth, Buffer.concat([Buffer.from("WebPush: info", "utf8"), uaPublic, asPublic]), 32);
  const ikm = hkdf(prk, salt, Buffer.from("Content-Encoding: aes128gcm", "utf8"), 16);
  const nonce = hkdf(prk, salt, Buffer.from("Content-Encoding: nonce", "utf8"), 12);

  const plain = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const cipher = createCipheriv("aes-128-gcm", ikm, nonce);
  const ct = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);

  const body = Buffer.concat([
    salt,
    Buffer.from([(RS >>> 24) & 0xff, (RS >>> 16) & 0xff, (RS >>> 8) & 0xff, RS & 0xff]),
    Buffer.from([asPublic.length]),
    asPublic,
    ct,
  ]);

  return {
    body,
    headers: {
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(PUSH_TTL_SECONDS),
      urgency: "high",
      authorization: buildVapidAuthorization(sub.endpoint, keys.publicKey, keys.privateKey),
    },
  };
}
