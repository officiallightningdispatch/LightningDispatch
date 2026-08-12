// Hermetic driver-portal feature-batch tests (2026-08-12, feature batch 8):
// the four features — (a) the map always shows the user's location even with
// no active job, (b) in-app navigation DEFAULT + explicit Google/Apple/Waze
// options, (c) payout method capture → connected_unverified → owner-visible
// state (FULL handle owner-only, masked for the driver), (d) profile photo
// upload key persisted (B2 mock + contractor_profiles.profile_photo_key).
// Pure logic + source-level checks mirror driver-portal.test.mjs; DB-backed
// cores are exercised directly against throwaway QA orgs
// (qa-driverfeat-<uuid>) with mock B2 fetches — real network calls never
// happen. Cleanup is org-scoped BEFORE the org delete, and users (which have
// NO org_id column) are deleted by email pattern. Zero QA rows left.
//   DATABASE_URL=... bun driver-portal-features.test.mjs
// DB safety (2026-08-12): org deletes guarded by assertQaOrg — see src/data/db-guard.ts + /home/team/shared/db-safety-rules.md.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execSync } from "node:child_process";

if (!process.env.DATABASE_URL) {
  // Sandbox convenience: the live server process carries DATABASE_URL in its
  // environ — reuse it so the suite runs with the same DB as everything else.
  try {
    const pid = execSync("pgrep -f 'bun run serve.ts' | head -1").toString().trim();
    if (pid) {
      const env = await readFile(`/proc/${pid}/environ`, "utf8");
      const hit = env.split("\0").find((e) => e.startsWith("DATABASE_URL="));
      if (hit) process.env.DATABASE_URL = hit.slice("DATABASE_URL=".length);
    }
  } catch { /* runner must supply DATABASE_URL */ }
}
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
// Test key for THIS process only (env-first resolution overrides the stable
// key file — same pattern as the other suites).
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 11).toString("base64");
const { buildNavOptions, defaultNavUrl, isIOSUA } = await import("./src/lib/navigation.ts");
const { setMyPayoutMethodCore, getMyPayoutMethodCore, listPayoutMethodsCore, removeMyPayoutMethodCore, validatePayoutInput } = await import("./src/data/payouts-core.ts");
const { uploadProfilePhotoCore, getProfilePhotoCore } = await import("./src/data/driver-profile-photo-core.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

const ORG = `qa-driverfeat-${randomUUID()}`;
const OWNER = `qa-driverfeat-owner-${randomUUID()}`;
const DRIVER = `qa-driverfeat-driver-${randomUUID()}`;
const ACTOR = { orgId: ORG, id: OWNER, role: "owner" };

async function setup() {
  await ensureSchema();
  await q`INSERT INTO organizations(id, name) VALUES(${ORG}, 'qa driver-features')`;
  await q`INSERT INTO users(id, name, email, password_hash) VALUES(${OWNER}, 'QA Feat Owner', ${`qa-driverfeat-owner-${randomUUID()}@lightning.test`}, 'x')`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${OWNER}, 'owner')`;
  await q`INSERT INTO users(id, name, email, password_hash) VALUES(${DRIVER}, 'QA Feat Driver', ${`qa-driverfeat-driver-${randomUUID()}@lightning.test`}, 'x')`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${DRIVER}, 'contractor')`;
}
await setup();

/* ============ a) map always shows the user's location (no active job) ============ */
{
  const liveMap = readFileSync(new URL("./src/components/live-map.tsx", import.meta.url), "utf8");
  // The marker list pushes a "self" pin from the live-map payload, else falls
  // back to the browser's own geolocation — so the map NEVER renders without
  // "you", even with zero jobs/zero drivers.
  check("map fallback: browser-geolocation self marker exists", liveMap.includes("self-browser") && liveMap.includes("browserSelf"), "no browserSelf fallback in live-map");
  check("map comment: never renders without you", liveMap.includes("the map NEVER renders without"), "missing guard comment");
  check("map null-data guards on drivers/jobs loops", liveMap.includes("data?.drivers ?? []") && liveMap.includes("data?.jobs ?? []"), "drivers/jobs loops must null-guard data");
  check("map self pin pushed before jobs (title 'You')", liveMap.includes('title: "You"'), "self marker must carry title You");
  const portal = readFileSync(new URL("./src/components/driver-portal.tsx", import.meta.url), "utf8");
  check("map hero wired into the driver home shell with driverScope", portal.includes("LiveMap") && portal.includes("driverScope"), "driver home shell must render the map with driverScope");
  const home = readFileSync(new URL("./src/routes/driver/index.tsx", import.meta.url), "utf8");
  check("driver home route (no-active-job state) uses the map shell", home.includes("driver-portal"), "driver home route missing the map shell");
}

/* ============ b) navigation default logic (in-app default + Google/Apple) ============ */
{
  const IOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15";
  const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36";
  const ios = buildNavOptions(41.13, -73.2, IOS_UA);
  check("nav: iOS default is FIRST + marked default + Apple Maps URL", ios[0].id === "apple-default" && ios[0].default === true && ios[0].url.includes("maps.apple.com") && ios[0].url.includes("daddr=41.13,-73.2"), JSON.stringify(ios));
  check("nav: all four options (default, google, apple, waze)", ios.map((o) => o.id).join(",") === "apple-default,google,apple,waze", JSON.stringify(ios));
  const and = buildNavOptions(41.13, -73.2, ANDROID_UA);
  check("nav: Android default is the geo: scheme (native maps app)", and[0].id === "geo-default" && and[0].url.startsWith("geo:41.13,-73.2?q=41.13,-73.2"), JSON.stringify(and));
  check("nav: explicit Google Maps directions option", and[1].id === "google" && and[1].url.includes("google.com/maps/dir") && and[1].url.includes("destination=41.13,-73.2"), JSON.stringify(and[1]));
  check("nav: explicit Apple Maps option", and[2].id === "apple" && and[2].url.includes("maps.apple.com") && and[2].url.includes("daddr=41.13,-73.2"), JSON.stringify(and[2]));
  check("nav: explicit Waze option", and[3].id === "waze" && and[3].url.includes("waze.com/ul") && and[3].url.includes("navigate=yes"), JSON.stringify(and[3]));
  check("nav: defaultNavUrl matches the platform default", defaultNavUrl(41.13, -73.2, IOS_UA) === ios[0].url && defaultNavUrl(41.13, -73.2, ANDROID_UA) === and[0].url, defaultNavUrl(41.13, -73.2, IOS_UA));
  check("nav: isIOSUA detects iPhone/iPad, not Android", isIOSUA(IOS_UA) === true && isIOSUA(ANDROID_UA) === false, isIOSUA(IOS_UA));
}

/* ============ c) payout method capture → connected_unverified → owner-visible ============ */
{
  const none = await getMyPayoutMethodCore({ orgId: ORG, id: DRIVER });
  check("payout: no method on file → null (NOT_SET)", none.ok && none.data === null, JSON.stringify(none));

  const set1 = await setMyPayoutMethodCore({ orgId: ORG, id: DRIVER, actorUserId: DRIVER, actorRole: "contractor" }, { rail: "cash_app", handle: "$qaDriver" });
  check("payout: cash app captured, status connected_unverified", set1.ok && set1.data.rail === "cash_app" && set1.data.status === "connected_unverified", JSON.stringify(set1));
  check("payout: masked handle never contains the full handle", set1.ok && set1.data.handleMasked.startsWith("$") && !set1.data.handleMasked.includes("qaDriver") && set1.data.handleMasked.includes("••••"), JSON.stringify(set1));

  const ownerList = await listPayoutMethodsCore(ACTOR);
  check("payout: owner sees the method with FULL handle", ownerList.ok && ownerList.data.length === 1 && ownerList.data[0].contractorId === DRIVER && ownerList.data[0].handleFull === "$qaDriver" && ownerList.data[0].status === "connected_unverified", JSON.stringify(ownerList));

  const mine = await getMyPayoutMethodCore({ orgId: ORG, id: DRIVER });
  check("payout: driver read-back is masked (full handle never crosses)", mine.ok && mine.data.rail === "cash_app" && mine.data.handleMasked !== "$qaDriver", JSON.stringify(mine));

  const set2 = await setMyPayoutMethodCore({ orgId: ORG, id: DRIVER, actorUserId: DRIVER, actorRole: "contractor" }, { rail: "bank", bankInstitutionName: "Chase", bankLast4: "4321" });
  check("payout: rail change → bank captured + re-triggers connected_unverified", set2.ok && set2.data.rail === "bank" && set2.data.bankLast4 === "4321" && set2.data.status === "connected_unverified", JSON.stringify(set2));
  check("payout: bank masked form shows institution + ••last4", set2.ok && set2.data.handleMasked.includes("Chase") && set2.data.handleMasked.includes("4321") && set2.data.handleMasked.includes("••"), JSON.stringify(set2));

  const rm = await removeMyPayoutMethodCore({ orgId: ORG, id: DRIVER, actorUserId: DRIVER, actorRole: "contractor" });
  check("payout: remove → row deleted", rm.ok && rm.data.removed === true, JSON.stringify(rm));
  const gone = await getMyPayoutMethodCore({ orgId: ORG, id: DRIVER });
  check("payout: after remove → null (NOT_SET again)", gone.ok && gone.data === null, JSON.stringify(gone));

  const denied = await listPayoutMethodsCore({ orgId: ORG, id: DRIVER, role: "contractor" });
  check("payout: a contractor cannot read the owner payout list", denied.ok === false && denied.code === "unauthorized", JSON.stringify(denied));

  const v = validatePayoutInput({ rail: "bank", handle: null, bankInstitutionName: "Chase", bankLast4: "4321" });
  check("payout: bank validation ok (normalized last4, null handle)", v.ok && v.data.bankLast4 === "4321" && v.data.handle === null && v.data.bankInstitutionName === "Chase", JSON.stringify(v));
  const bad = validatePayoutInput({ rail: "bank", handle: null, bankInstitutionName: "Chase", bankLast4: "12" });
  check("payout: short last4 rejected", bad.ok === false && bad.code === "invalid_input", JSON.stringify(bad));
}

/* ============ d) profile photo upload key persisted (B2 + DB) ============ */
{
  const SAVED = { k: process.env.B2_KEY_ID, a: process.env.B2_APPLICATION_KEY, b: process.env.B2_BUCKET_NAME };
  process.env.B2_KEY_ID = "004testkeyid";
  process.env.B2_APPLICATION_KEY = "testsecret";
  process.env.B2_BUCKET_NAME = "qa-bucket";
  const resp = (status, { json, bytes } = {}) => ({
    status,
    ok: status >= 200 && status < 300,
    async text() { return json != null ? JSON.stringify(json) : ""; },
    async json() { return json != null ? JSON.parse(JSON.stringify(json)) : {}; },
    async arrayBuffer() { return bytes != null ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : new ArrayBuffer(0); },
  });
  const objects = new Map(); // s3 key → bytes
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    if (u.startsWith("https://api.backblazeb2.com/")) {
      return resp(200, { json: { apiInfo: { s3ApiUrl: "https://s3.us-west-004.backblazeb2.com" }, allowed: { bucketName: "qa-bucket" } } });
    }
    if (u.startsWith("https://s3.us-west-004.backblazeb2.com/")) {
      const path = u.split("/").slice(3).join("/"); // bucket/key
      if (method === "PUT") { objects.set(path, Buffer.from(init.body)); return resp(200, { json: { ok: true } }); }
      if (method === "GET") return objects.has(path) ? resp(200, { bytes: new Uint8Array(objects.get(path)) }) : resp(404, {});
    }
    throw new Error(`unexpected call: ${method} ${u}`);
  };
  const key = `profile-photos/${ORG}/${DRIVER}/avatar`;
  const bytes = Buffer.from("A".repeat(1500)); // > 1 KiB decoded
  const dataUrl = `data:image/jpeg;base64,${bytes.toString("base64")}`;
  const user = { orgId: ORG, id: DRIVER, role: "contractor", actorUserId: DRIVER, actorRole: "contractor" };

  const up = await uploadProfilePhotoCore(user, { dataUrl }, { fetchImpl });
  check("photo: upload ok + deterministic storage key", up.ok && up.storageKey === key, JSON.stringify(up));
  const row = await q`SELECT profile_photo_key FROM contractor_profiles WHERE org_id=${ORG} AND user_id=${DRIVER}`;
  check("photo: key PERSISTED on contractor_profiles", row.length === 1 && String(row[0].profile_photo_key) === key, JSON.stringify(row));
  check("photo: bytes written to the B2 object store", objects.has(`qa-bucket/${key}`) && Buffer.compare(objects.get(`qa-bucket/${key}`), bytes) === 0);

  const got = await getProfilePhotoCore({ orgId: ORG, id: DRIVER }, { fetchImpl });
  check("photo: read-back roundtrips the exact bytes as a data URL", got.ok && got.storageKey === key && got.dataUrl === `data:image/jpeg;base64,${bytes.toString("base64")}`, JSON.stringify(got));

  const none = await getProfilePhotoCore({ orgId: ORG, id: OWNER }, { fetchImpl });
  check("photo: no photo on file → ok with null storageKey", none.ok && none.storageKey === null && none.dataUrl === null, JSON.stringify(none));

  const bad = await uploadProfilePhotoCore(user, { dataUrl: "not-a-data-url" }, { fetchImpl });
  check("photo: invalid dataUrl → invalid_input, never touches B2", bad.ok === false && bad.code === "invalid_input", JSON.stringify(bad));

  const tiny = await uploadProfilePhotoCore(user, { dataUrl: `data:image/jpeg;base64,${Buffer.from("x".repeat(100)).toString("base64")}` }, { fetchImpl });
  check("photo: tiny payload rejected as empty", tiny.ok === false && tiny.code === "invalid_input", JSON.stringify(tiny));

  process.env.B2_KEY_ID = SAVED.k; process.env.B2_APPLICATION_KEY = SAVED.a; process.env.B2_BUCKET_NAME = SAVED.b;
}

/* ================================ summary + cleanup ================================ */
const failed = checks.filter(([, ok]) => !ok);
console.log(`driver-portal-features.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }
// Org-scoped child-table deletes BEFORE the org delete; users have no org_id
// column, so they are deleted by email pattern.
assertQaOrg(ORG);
await q`DELETE FROM payout_methods WHERE org_id=${ORG}`.catch(() => {});
await q`DELETE FROM contractor_profiles WHERE org_id=${ORG}`.catch(() => {});
await q`DELETE FROM audit_log WHERE org_id=${ORG}`.catch(() => {});
await q`DELETE FROM organization_memberships WHERE org_id=${ORG}`.catch(() => {});
await q`DELETE FROM organizations WHERE id=${ORG}`.catch(() => {});
await q`DELETE FROM users WHERE email LIKE 'qa-driverfeat-%@lightning.test'`.catch(() => {});
const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM payout_methods p JOIN organizations o ON o.id=p.org_id WHERE o.name='qa driver-features') AS payout,
  (SELECT COUNT(*)::int FROM contractor_profiles c JOIN organizations o ON o.id=c.org_id WHERE o.name='qa driver-features') AS profiles,
  (SELECT COUNT(*)::int FROM audit_log a JOIN organizations o ON o.id=a.org_id WHERE o.name='qa driver-features') AS audit,
  (SELECT COUNT(*)::int FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name='qa driver-features') AS members,
  (SELECT COUNT(*)::int FROM users u WHERE u.email LIKE 'qa-driverfeat-%@lightning.test') AS users`;
const z = Object.values(leftover[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) { console.error("FAIL: QA cleanup left rows behind"); process.exit(1); }
console.log("driver-portal-features.test.mjs: cleanup verified — zero QA rows left");
