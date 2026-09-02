import { describe, test, expect } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
// Hermetic APNs sender tests — no network, no DB, no Apple account. Proves the
// credential loader + the ES256 JWT structure (kid/iss/iat + a real signature).
const { buildApnsJwt, loadApnsCredentials, APNS_PRODUCTION_HOST, APNS_TOPIC } = await import("./src/data/apns.ts");

test("loadApnsCredentials fails closed on any missing/blank value", () => {
  expect(loadApnsCredentials({})).toBeNull();
  expect(loadApnsCredentials({ APNS_AUTH_KEY_P8: " ", APNS_KEY_ID: "A", APNS_TEAM_ID: "T" })).toBeNull();
  expect(loadApnsCredentials({ APNS_AUTH_KEY_P8: "K", APNS_KEY_ID: "", APNS_TEAM_ID: "T" })).toBeNull();
  expect(loadApnsCredentials({ APNS_AUTH_KEY_P8: "K", APNS_KEY_ID: "A", APNS_TEAM_ID: " " })).toBeNull();
  expect(loadApnsCredentials({ APNS_AUTH_KEY_P8: " K ", APNS_KEY_ID: " ABC123 ", APNS_TEAM_ID: " T " })).toEqual({
    keyId: "ABC123",
    teamId: "T",
    privateKeyP8: "K",
  });
});

test("buildApnsJwt signs an ES256 JWT with kid/iss/iat against PRODUCTION APNs", () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ format: "pem", type: "pkcs8" });
  const jwt = buildApnsJwt({ keyId: "KEY123", teamId: "TEAMX", privateKeyP8: pem }, 1_700_000_000);
  const [h, p, s] = jwt.split(".");
  expect(h).toBeTruthy();
  expect(p).toBeTruthy();
  expect(s).toBeTruthy();
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
  expect(header).toEqual({ alg: "ES256", kid: "KEY123" });
  const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  expect(claims).toEqual({ iss: "TEAMX", iat: 1_700_000_000 });
  // ES256 P1363 signature = 64 bytes → 86 base64url chars (no padding).
  expect(s.length).toBe(86);
  expect(APNS_PRODUCTION_HOST).toBe("api.push.apple.com");
  expect(APNS_TOPIC).toBe("com.lightningroadside.lightningdispatch");
});
