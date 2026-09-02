/**
 * Apple Push Notification service (APNs) sender — SERVER-ONLY. Token-based
 * (JWT) provider authentication against the PRODUCTION APNs endpoint, which is
 * what TestFlight and App Store builds receive pushes through (development
 * builds use the sandbox; we do not send to the sandbox).
 *
 * Credentials come from the three owner-provided secrets:
 *   APNS_AUTH_KEY_P8  — the full .p8 private key (PKCS#8 "BEGIN PRIVATE KEY")
 *   APNS_KEY_ID       — the 10-char Key ID from the key's page in Apple Developer
 *   APNS_TEAM_ID      — the team id (J55SPG373Q)
 *
 * All functions FAIL CLOSED and never throw: a missing credential, an invalid
 * key, or an HTTP error resolves to `{ ok: false, reason }`. Push problems must
 * never fail or slow assignment — the in-app banner is the guaranteed path.
 */
import { createPrivateKey, sign } from "node:crypto";
import { connect, type ClientHttp2Session, type ClientHttp2Stream } from "node:http2";

export const APNS_PRODUCTION_HOST = "api.push.apple.com";
export const APNS_TOPIC = "com.lightningroadside.lightningdispatch";

export type ApnsCredentials = {
  keyId: string;
  teamId: string;
  privateKeyP8: string;
};

/** Read the APNs credentials from the environment. Returns null (never throws)
 *  when any of the three values is missing or blank. */
export function loadApnsCredentials(
  env: Record<string, string | undefined> = process.env,
): ApnsCredentials | null {
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = env.APNS_TEAM_ID?.trim();
  const privateKeyP8 = env.APNS_AUTH_KEY_P8?.trim();
  if (!keyId || !teamId || !privateKeyP8) return null;
  return { keyId, teamId, privateKeyP8 };
}

const b64url = (b: Buffer): string => b.toString("base64url");

/**
 * Normalize the owner-pasted .p8 private key into a strict PEM block. The
 * Secrets store (and some editors) collapse the key's newlines into spaces and
 * put the whole key on one line; OpenSSL rejects that ("NO_START_LINE"). This
 * recovers the exact base64 body (strip ALL whitespace, re-wrap at 64 chars)
 * and reassembles the canonical -----BEGIN/END PRIVATE KEY----- block.
 */
function normalizePem(pem: string): string {
  const m = pem.trim().match(/-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/);
  const b64 = (m ? m[1] : pem).replace(/[\s\r\n]+/g, "");
  const wrapped = b64.match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----\n`;
}

/**
 * Build the ES256 JWT APNs uses for bearer auth. Header `{ alg: ES256, kid }`;
 * claims `{ iss: teamId, iat: nowSeconds }`. The signature is P1363 (r || s,
 * 64 bytes) — the exact encoding APNs requires for ES256.
 *
 * Pure and hermetic (no network, no DB) so the suite can assert the structure
 * and signature without hitting Apple.
 */
export function buildApnsJwt(
  creds: ApnsCredentials,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "ES256", kid: creds.keyId })));
  const claims = b64url(Buffer.from(JSON.stringify({ iss: creds.teamId, iat: nowSeconds })));
  const signingInput = `${header}.${claims}`;
  const key = createPrivateKey({ key: normalizePem(creds.privateKeyP8), format: "pem" });
  const sig = sign("sha256", Buffer.from(signingInput, "utf8"), { key, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${b64url(sig)}`;
}

export type ApnsAlertPayload = {
  title: string;
  body: string;
  /** Optional in-app route the push opens (serialized under `data.url`). */
  url?: string;
  /** Tag → APNs `thread-id` so repeats replace rather than stack. */
  tag?: string;
};

export type ApnsSendResult =
  | { ok: true; status: number }
  | { ok: false; reason: string; status?: number };

/**
 * Send one alert notification to one device token over HTTP/2 to PRODUCTION
 * APNs. NEVER throws — resolves `{ ok:false, reason }` on every failure path
 * (missing credentials, bad key, connect error, non-200 response, timeout).
 */
export async function sendApnsNotification(
  deviceToken: string,
  alert: ApnsAlertPayload,
  creds: ApnsCredentials | null = loadApnsCredentials(),
): Promise<ApnsSendResult> {
  if (!creds) return { ok: false, reason: "APNs credentials are not configured (APNS_AUTH_KEY_P8/APNS_KEY_ID/APNS_TEAM_ID)." };
  if (!/^[0-9a-fA-F]{64}$/.test(deviceToken)) return { ok: false, reason: "Invalid APNs device token." };

  let jwt: string;
  try {
    jwt = buildApnsJwt(creds);
  } catch (err) {
    return { ok: false, reason: `Could not sign APNs JWT: ${String(err).slice(0, 160)}` };
  }

  const body = JSON.stringify({
    aps: {
      alert: { title: alert.title, body: alert.body },
      sound: "default",
      ...(alert.tag ? { "thread-id": alert.tag } : {}),
    },
    ...(alert.url ? { data: { url: alert.url } } : {}),
  });

  return await new Promise<ApnsSendResult>((resolve) => {
    let session: ClientHttp2Session | null = null;
    let settled = false;
    const finish = (r: ApnsSendResult) => {
      if (settled) return;
      settled = true;
      try { session?.close(); } catch { /* ignore */ }
      resolve(r);
    };

    const timer = setTimeout(() => finish({ ok: false, reason: "APNs request timed out." }), 10_000);

    try {
      session = connect(`https://${APNS_PRODUCTION_HOST}`);
    } catch (err) {
      clearTimeout(timer);
      finish({ ok: false, reason: `Could not connect to APNs: ${String(err).slice(0, 160)}` });
      return;
    }

    session.on("error", (err) => {
      clearTimeout(timer);
      finish({ ok: false, reason: `APNs connection error: ${String(err).slice(0, 160)}` });
    });

    let stream: ClientHttp2Stream;
    try {
      stream = session.request({
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt}`,
        "apns-topic": APNS_TOPIC,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
    } catch (err) {
      clearTimeout(timer);
      finish({ ok: false, reason: `Could not open APNs request: ${String(err).slice(0, 160)}` });
      return;
    }

    stream.on("response", (headers) => {
      clearTimeout(timer);
      const status = Number(headers[":status"] ?? 0);
      if (status >= 200 && status < 300) finish({ ok: true, status });
      else finish({ ok: false, status, reason: `APNs rejected the push (HTTP ${status}).` });
    });
    stream.on("error", (err) => {
      clearTimeout(timer);
      finish({ ok: false, reason: `APNs request error: ${String(err).slice(0, 160)}` });
    });
    stream.end(body);
  });
}
