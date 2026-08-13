// DB safety (2026-08-12): org deletes guarded by assertQaOrg — see src/data/db-guard.ts + /home/team/shared/db-safety-rules.md.
// Hermetic completion-flow tests (2026-08-11, milestone "completion flow",
// owner-directed Web Payments design): the "Finish up" gate — customer
// signature (PNG → B2) + survey REQUIRED before final-complete (photos stay a
// hard invariant), and the OPTIONAL tip charged through the OWNER's Square
// account with the card tokenized CLIENT-SIDE (Square Web Payments SDK) and
// charged SERVER-SIDE via POST /v2/payments (Bearer token, idempotency key
// tip-<job>-<driver>-<attempt>) with the attribution row in completion_tips
// (org/job/driver/amount/Square payment id) so tips reconcile to the specific
// driver. Covers: signature+survey gate, tip success + attribution +
// idempotent replay, tip decline still completes, payment failure →
// retry/decline and NEVER blocks completion, photos invariant, role gating
// (only the assigned driver can finish), public-only Square config.
//
// Real network calls never happen: Square + B2 + Towbook all take an injectable
// fetchImpl (mock Square with an idempotency-key → payment map like the real
// API; B2 with an in-memory object store; Towbook photos POST + calls PUT/GET).
// DB-backed against throwaway QA orgs (emails qa-*-<tag>@lightning.test — never
// touches real lightroad29 data), deleted at the end (zero rows left anywhere).
//   DATABASE_URL=... bun completion-flow.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
// Test key for THIS process only (env-first resolution overrides the stable
// key file — same pattern as the other suites).
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 9).toString("base64");
const { loadSquareConfig, loadSquarePublicConfig, createCardPayment, squareIdempotencyKey } = await import("./src/data/square-client.ts");
const {
  captureCompletionCore,
  chargeTipCore,
  declineTipCore,
  getSquareWebPaymentsConfigCore,
  completionCaptureForJob,
  isSquareConfiguredCore,
} = await import("./src/data/completion-core.ts");
const { uploadJobPhotoCore, setVehicleMatchCore, completeJobCore } = await import("./src/data/driver-photos-core.ts");
const { encryptSession } = await import("./src/data/towbook-key.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

const TAG = randomUUID().slice(0, 8);
const ORG = `qa-cf-${TAG}`;             // success path: capture → tip paid → complete
const ORG2 = `qa-cf2-${TAG}`;           // photos invariant + decline → complete (no tip)
const ORG3 = `qa-cf3-${TAG}`;           // payment failure → retry/decline; never blocks
const OWNER = `qa-cf-owner-${TAG}`;
const OWNER2 = `qa-cf2-owner-${TAG}`;
const OWNER3 = `qa-cf3-owner-${TAG}`;
const DRIVER = `qa-cf-driver-${TAG}`;
const DRIVER2 = `qa-cf2-driver-${TAG}`;
const DRIVER3 = `qa-cf3-driver-${TAG}`;
const OTHER = `qa-cf-other-${TAG}`;     // in ORG, not assigned to the job
const CONF = {
  [ORG]: { userId: DRIVER, tbDriver: "35", tbUser: "135", job: "tb-447011", call: "447011" },
  [ORG2]: { userId: DRIVER2, tbDriver: "36", tbUser: "136", job: "tb-447012", call: "447012" },
  [ORG3]: { userId: DRIVER3, tbDriver: "37", tbUser: "137", job: "tb-447013", call: "447013" },
};
const PICKUP = { lat: 41.2, lng: -73.2 };

const SIDES = ["front", "driver_side", "passenger_side", "rear"];
const PHASES = ["pre_arrival", "service", "final"];
const rawCall = (callId, driverId) => ({
  id: Number(callId),
  callNumber: Number(callId),
  status: { id: 4 },
  waypoints: [{ address: "70 Pitt Street", zip: "06606", latitude: PICKUP.lat, longitude: PICKUP.lng }],
  assets: [{ id: 603482, name: "QA Driver", driver: { id: driverId } }],
  account: { company: "QA Customer" },
});

const resp = (status, { json, bytes } = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  async text() { return json != null ? JSON.stringify(json) : ""; },
  async json() { return json != null ? JSON.parse(JSON.stringify(json)) : {}; },
  async arrayBuffer() { return bytes != null ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : new ArrayBuffer(0); },
});

/** Mock fetch for the WHOLE completion surface: B2 authorize + S3 PUT/GET (with
 *  an in-memory object store), Towbook photos POST + calls PUT/GET, and the
 *  Square Payments API — /v2/payments behaves like the real API for
 *  idempotency: the FIRST call with an idempotency_key creates a payment id and
 *  any replay of the SAME key returns the SAME payment (never a second charge).
 *  payments mode: 'ok' (200 always) | 'fail-once' (first 400, then 200) |
 *  'always-fail' (400 always) | 'terminal' (200 with payment.status FAILED). */
function makeFetch({ callId, getStatusId = 5, payments = "ok" } = {}) {
  const calls = [];
  const squareCalls = [];
  const paymentIds = new Map(); // idempotency_key → payment id
  const objects = new Map();    // s3 key → bytes
  let failCount = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    calls.push({ method, url: u, body: init.body, headers: init.headers });
    if (u.startsWith("https://api.backblazeb2.com/")) {
      return resp(200, { json: { apiInfo: { s3ApiUrl: "https://s3.us-west-004.backblazeb2.com" }, allowed: { bucketName: "qa-bucket" } } });
    }
    if (u.startsWith("https://s3.us-west-004.backblazeb2.com/")) {
      const path = u.split("/").slice(3).join("/"); // bucket/key
      if (method === "PUT") { objects.set(path, Buffer.from(init.body)); return resp(200, { json: { ok: true } }); }
      if (method === "GET") { return objects.has(path) ? resp(200, { bytes: new Uint8Array(objects.get(path)) }) : resp(404, {}); }
    }
    if (u.startsWith("https://connect.squareup.com/v2/payments") && method === "POST") {
      const body = JSON.parse(String(init.body));
      squareCalls.push({ url: u, body, headers: init.headers });
      const mode = payments === "fail-once" && failCount === 0 ? "fail" : payments;
      failCount += 1;
      if (mode === "fail" || mode === "always-fail") {
        return resp(400, { json: { errors: [{ code: "CARD_DECLINED", detail: "The card was declined." }] } });
      }
      // Real-Square idempotency: replaying a key returns the SAME payment.
      if (!paymentIds.has(body.idempotency_key)) paymentIds.set(body.idempotency_key, `pymt_${paymentIds.size + 1}`);
      const paymentId = paymentIds.get(body.idempotency_key);
      if (mode === "terminal") return resp(200, { json: { payment: { id: paymentId, status: "FAILED", receipt_url: null } } });
      return resp(200, { json: { payment: { id: paymentId, status: "COMPLETED", receipt_url: `https://square.link/receipt/${paymentId}` } } });
    }
    if (u.includes(`/api/calls/${callId}/photos`) && method === "POST") {
      return resp(201, { json: { ok: true } });
    }
    if (u.endsWith(`/api/calls/${callId}`) && method === "PUT") {
      return resp(200, { json: { id: Number(callId), status: { id: 5 } } });
    }
    if (u.endsWith(`/api/calls/${callId}`) && method === "GET") {
      return resp(200, { json: { id: Number(callId), status: { id: getStatusId } } });
    }
    throw new Error(`unexpected call: ${method} ${u}`);
  };
  return { fetchImpl, calls, squareCalls, paymentIds, objects };
}

const photoDataUrl = (marker) => `data:image/jpeg;base64,${marker.repeat(1500)}`;
const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const sigDataUrl = (marker) => `data:image/png;base64,${Buffer.concat([PNG_1x1, Buffer.from(marker.repeat(100))]).toString("base64")}`;
const userFor = (orgId) => ({ orgId, id: CONF[orgId].userId, role: "contractor", towbookDriverId: CONF[orgId].tbDriver });

async function uploadAllPhotos(orgId, fetchImpl, marker) {
  const c = CONF[orgId];
  const user = userFor(orgId);
  for (const phase of PHASES) for (let i = 0; i < SIDES.length; i++) {
    await uploadJobPhotoCore(user, { jobId: c.call, phase, side: SIDES[i], dataUrl: photoDataUrl(marker) }, { fetchImpl });
  }
  await setVehicleMatchCore(user, { jobId: c.call, confirmed: true });
}

async function setup() {
  await ensureSchema();
  for (const [org, owner, driver, tbDriver, tbUser, job, callId] of [
    [ORG, OWNER, DRIVER, "35", "135", "tb-447011", "447011"],
    [ORG2, OWNER2, DRIVER2, "36", "136", "tb-447012", "447012"],
    [ORG3, OWNER3, DRIVER3, "37", "137", "tb-447013", "447013"],
  ]) {
    await q`INSERT INTO organizations(id, name) VALUES(${org}, 'qa completion-flow wp')`;
    await q`INSERT INTO users(id, name, email, password_hash) VALUES(${owner}, 'QA CF Owner', ${`qa-cf-owner-${randomUUID()}@lightning.test`}, 'x')`;
    await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${org}, ${owner}, 'owner')`;
    await q`INSERT INTO users(id, name, email, password_hash, towbook_driver_id, towbook_user_id) VALUES(${driver}, 'QA CF Driver', ${`qa-cf-driver-${randomUUID()}@lightning.test`}, 'x', ${tbDriver}, ${tbUser})`;
    await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${org}, ${driver}, 'contractor')`;
    await q`INSERT INTO towbook_sessions(org_id, encrypted_session, status, session_kind, towbook_driver_id)
      VALUES(${org}, ${await encryptSession(JSON.stringify({ cookies: "xtl=fake", baseUrl: "https://app.towbook.com" }))}, 'connected', 'driver', ${tbDriver})`;
    await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, towbook_job_id, pickup, towbook_status, raw_json, pickup_lat, pickup_lng)
      VALUES(${job}, ${org}, 'QA Customer', '', 0, 0, 'Bridgeport', 'flatbed_tow', 'arrived', NOW(), '', ${callId}, '70 Pitt Street', '4', ${JSON.stringify(rawCall(callId, Number(tbDriver)))}::jsonb, ${PICKUP.lat}, ${PICKUP.lng})`;
    await q`INSERT INTO org_settings(org_id, geofence_radius_meters, photos_required) VALUES(${org}, 150, FALSE)`;
  }
  // An unassigned driver in ORG (wrong-driver rails).
  await q`INSERT INTO users(id, name, email, password_hash, towbook_driver_id) VALUES(${OTHER}, 'QA CF Other', ${`qa-cf-other-${randomUUID()}@lightning.test`}, 'x', '99')`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${OTHER}, 'contractor')`;
}

// Square + B2 env for THIS process (env-first resolution).
process.env.B2_KEY_ID = "004testkeyid";
process.env.B2_APPLICATION_KEY = "testsecret";
process.env.B2_BUCKET_NAME = "qa-bucket";
process.env.SQUARE_ACCESS_TOKEN = "test-square-token";
process.env.SQUARE_LOCATION_ID = "loc_test";
process.env.SQUARE_APPLICATION_ID = "app_test";

await setup();

/* ============ 1) Square config: full triple required; public-only client config ============ */
{
  const cfg = await loadSquareConfig();
  check("env-first Square config (token + location + app id)", cfg.accessToken === "test-square-token" && cfg.locationId === "loc_test" && cfg.applicationId === "app_test", JSON.stringify(cfg));
  const pub = await loadSquarePublicConfig();
  check("public config carries ONLY application id + location id (no token)", pub.applicationId === "app_test" && pub.locationId === "loc_test" && !("accessToken" in pub), JSON.stringify(pub));
  check("isSquareConfiguredCore true with env set", (await isSquareConfiguredCore()) === true);
  const g = await getSquareWebPaymentsConfigCore();
  check("getSquareWebPaymentsConfigCore → public ids only", g.ok === true && g.applicationId === "app_test" && g.locationId === "loc_test", JSON.stringify(g));
  // Missing any part → square_not_configured, never a fake success.
  const saved = { s: process.env.SQUARE_ACCESS_TOKEN, l: process.env.SQUARE_LOCATION_ID, a: process.env.SQUARE_APPLICATION_ID };
  delete process.env.SQUARE_ACCESS_TOKEN; delete process.env.SQUARE_LOCATION_ID; delete process.env.SQUARE_APPLICATION_ID;
  let threw = false;
  try { await loadSquareConfig({}, { stableDir: `/tmp/square-missing-${Date.now()}` }); } catch (e) { threw = String(e).includes("Square is not configured") && String(e).includes("SQUARE_ACCESS_TOKEN") && String(e).includes("SQUARE_APPLICATION_ID"); }
  check("missing Square creds → clear structured error", threw);
  const g2 = await getSquareWebPaymentsConfigCore({ stableDir: `/tmp/square-missing-${Date.now()}` });
  check("public config without creds → square_not_configured", g2.ok === false && g2.code === "square_not_configured", JSON.stringify(g2));
  process.env.SQUARE_ACCESS_TOKEN = saved.s; process.env.SQUARE_LOCATION_ID = saved.l; process.env.SQUARE_APPLICATION_ID = saved.a;
}

/* ============ 2) ORG — signature+survey gate: complete without capture → completion_capture_required ============ */
const orgFetch = makeFetch({ callId: CONF[ORG].call }); // ONE mock fetch for ORG (B2 object store shared across sections)
{
  const c = CONF[ORG];
  const { fetchImpl, calls } = orgFetch;
  const user = userFor(ORG);
  await uploadAllPhotos(ORG, fetchImpl, "A");
  const r = await completeJobCore(user, { jobId: c.call }, { fetchImpl });
  check("complete without capture → completion_capture_required", r.ok === false && r.code === "completion_capture_required", JSON.stringify(r));
  const j = await q`SELECT status FROM dispatch_jobs WHERE id=${c.job}`;
  check("job STAYS arrived (no complete without capture)", String(j[0].status) === "arrived");
  check("no Towbook PUT after capture-required", !calls.some((x) => x.method === "PUT" && x.url.endsWith(`/api/calls/${c.call}`)));
}

/* ============ 3) ORG — capture (signature + survey) ============ */
{
  const c = CONF[ORG];
  const { fetchImpl } = orgFetch;
  const user = userFor(ORG);
  const r = await captureCompletionCore(user, { jobId: c.call, signatureDataUrl: sigDataUrl("C"), survey: { rating: 5, comment: "Great" } }, { fetchImpl });
  check("capture saved (signature + survey)", r.ok === true && r.completion.status === "captured" && r.completion.survey?.rating === 5, JSON.stringify(r));
  const cap = await completionCaptureForJob(ORG, c.job);
  check("capture read: signatureCaptured + survey", cap.signatureCaptured === true && cap.survey?.rating === 5, JSON.stringify(cap));
}

/* ============ 4) ORG — tip success records attribution (completion_tips) ============ */
let firstPaymentId = null;
{
  const c = CONF[ORG];
  const { fetchImpl, squareCalls } = orgFetch;
  const user = userFor(ORG);
  const t = await chargeTipCore(user, { jobId: c.call, token: "cnonce-card-0001", amountCents: 500, attempt: 1 }, { fetchImpl });
  check("tip charged (attempt 1)", t.ok === true && t.amountCents === 500 && t.status === "COMPLETED" && typeof t.paymentId === "string", JSON.stringify(t));
  firstPaymentId = t.paymentId;
  check("one Square /v2/payments POST with Bearer token", squareCalls.length === 1 && String(squareCalls[0].headers?.authorization) === "Bearer test-square-token", JSON.stringify(squareCalls.map((x) => x.headers)));
  const body = squareCalls[0].body;
  check("idempotency key = deterministic tip-<sha1(job,driver,attempt)> ≤45 chars (Square limit)", body.idempotency_key === squareIdempotencyKey("tip-", c.job, "35", 1) && body.idempotency_key.startsWith("tip-") && body.idempotency_key.length <= 45, JSON.stringify(body.idempotency_key));
  check("source_id is the client token", body.source_id === "cnonce-card-0001", JSON.stringify(body.source_id));
  check("amount_money + location id in the payment request", body.amount_money?.amount === 500 && body.amount_money?.currency === "USD" && body.location_id === "loc_test", JSON.stringify(body));
  check("note carries driver attribution", String(body.note ?? "").includes("QA CF Driver") && String(body.note ?? "").includes("job 447011"), JSON.stringify(body.note));
  const rows = await q`SELECT org_id, job_id, driver_id, driver_towbook_id, amount_cents, currency, square_payment_id, status, attempt, idempotency_key FROM completion_tips WHERE org_id=${ORG} AND job_id=${c.job} AND status='paid'`;
  check("attribution row recorded (org/job/driver/amount/square payment id)",
    rows.length === 1 && rows[0].driver_id === DRIVER && rows[0].driver_towbook_id === "35" && Number(rows[0].amount_cents) === 500
    && rows[0].currency === "USD" && String(rows[0].square_payment_id).startsWith("pymt_") && Number(rows[0].attempt) === 1 && rows[0].idempotency_key === `tip-${c.job}-35-1`,
    JSON.stringify(rows));
  const jc = await q`SELECT tip FROM job_completions WHERE org_id=${ORG} AND job_id=${c.job}`;
  check("job_completions.tip reflects paid + payment id", jc[0].tip?.status === "paid" && jc[0].tip?.amount_cents === 500 && typeof jc[0].tip?.square_payment_id === "string", JSON.stringify(jc[0].tip));
  const cap = await completionCaptureForJob(ORG, c.job);
  check("capture status tip_paid + squarePaymentId surfaced", cap.status === "tip_paid" && cap.tip?.squarePaymentId != null && cap.tip?.amountCents === 500, JSON.stringify(cap));
  const aud = await q`SELECT action FROM audit_log WHERE org_id=${ORG} AND action='job_tip_charged'`;
  check("tip charged audited", aud.length >= 1, JSON.stringify(aud));
}

/* ============ 5) ORG — idempotent retry: replaying the same attempt can never double-record ============ */
{
  const c = CONF[ORG];
  const { fetchImpl, squareCalls } = orgFetch;
  const user = userFor(ORG);
  const before = squareCalls.length;
  const replay = await chargeTipCore(user, { jobId: c.call, token: "cnonce-card-0001", amountCents: 500, attempt: 1 }, { fetchImpl });
  check("replay of attempt 1 → Square returns the SAME payment (no second charge)", replay.ok === true && replay.paymentId === firstPaymentId, JSON.stringify(replay));
  check("replayed attempt reuses the same idempotency key", squareCalls[before].body.idempotency_key === `tip-${c.job}-35-1`, JSON.stringify(squareCalls[before].body.idempotency_key));
  const rows = await q`SELECT COUNT(*)::int AS n FROM completion_tips WHERE org_id=${ORG} AND job_id=${c.job} AND status='paid'`;
  check("replayed attempt → still exactly ONE paid attribution row", Number(rows[0].n) === 1, JSON.stringify(rows));
  // A NEW attempt uses a NEW idempotency key (the retry path after a failure).
  const t2 = await chargeTipCore(user, { jobId: c.call, token: "cnonce-card-0002", amountCents: 750, attempt: 2 }, { fetchImpl });
  check("attempt 2 → new idempotency key (tip-<job>-<driver>-2)", t2.ok === true && squareCalls.at(-1).body.idempotency_key === `tip-${c.job}-35-2`, JSON.stringify(squareCalls.at(-1).body.idempotency_key));
  const rows2 = await q`SELECT COUNT(*)::int AS n FROM completion_tips WHERE org_id=${ORG} AND job_id=${c.job} AND status='paid'`;
  check("attempt 2 records its own attribution row (paid)", Number(rows2[0].n) === 2, JSON.stringify(rows2));
}

/* ============ 6) ORG — role gating: only the assigned driver can finish ============ */
{
  const c = CONF[ORG];
  const { fetchImpl } = orgFetch;
  const other = { orgId: ORG, id: OTHER, role: "contractor", towbookDriverId: "99" };
  const deniedCharge = await chargeTipCore(other, { jobId: c.call, token: "cnonce-card-0003", amountCents: 500, attempt: 1 }, { fetchImpl });
  check("wrong driver tip charge → unauthorized", deniedCharge.ok === false && deniedCharge.code === "unauthorized", JSON.stringify(deniedCharge));
  const deniedComplete = await completeJobCore(other, { jobId: c.call }, { fetchImpl });
  check("wrong driver complete → unauthorized", deniedComplete.ok === false && deniedComplete.code === "unauthorized", JSON.stringify(deniedComplete));
  const deniedDecline = await declineTipCore(other, { jobId: c.call });
  check("wrong driver decline → unauthorized", deniedDecline.ok === false && deniedDecline.code === "unauthorized", JSON.stringify(deniedDecline));
}

/* ============ 7) ORG — complete with capture + tip → ok (photos invariant intact) ============ */
{
  const c = CONF[ORG];
  const { fetchImpl, calls } = orgFetch;
  const user = userFor(ORG);
  const done = await completeJobCore(user, { jobId: c.call }, { fetchImpl });
  check("completion ok with capture + paid tip", done.ok === true && done.photosUploaded === 12 && done.towbookCompleted === true && done.changed === true, JSON.stringify(done));
  const puts = calls.filter((x) => x.method === "PUT" && x.url.endsWith(`/api/calls/${c.call}`));
  check("Towbook PUT status 5 happened", puts.length === 1 && JSON.parse(puts[0].body).status.id === 5);
  const j = await q`SELECT status FROM dispatch_jobs WHERE id=${c.job}`;
  check("platform job completed", String(j[0].status) === "completed");
}

/* ============ 8) ORG2 — photos invariant + tip decline still completes ============ */
const org2Fetch = makeFetch({ callId: CONF[ORG2].call });
{
  const c = CONF[ORG2];
  const { fetchImpl } = org2Fetch;
  const user = userFor(ORG2);
  // Capture FIRST (so only the photos gate can stop completion).
  const cap = await captureCompletionCore(user, { jobId: c.call, signatureDataUrl: sigDataUrl("G"), survey: { rating: 4 } }, { fetchImpl });
  check("ORG2 capture saved", cap.ok === true, JSON.stringify(cap));
  // Only the 4 pre-arrival photos → photos_incomplete (the 12-photo invariant).
  for (let i = 0; i < SIDES.length; i++) {
    await uploadJobPhotoCore(user, { jobId: c.call, phase: "pre_arrival", side: SIDES[i], dataUrl: photoDataUrl("H") }, { fetchImpl });
  }
  await setVehicleMatchCore(user, { jobId: c.call, confirmed: true });
  const blocked = await completeJobCore(user, { jobId: c.call }, { fetchImpl });
  check("complete with capture but only 4/12 photos → photos_incomplete", blocked.ok === false && blocked.code === "photos_incomplete", JSON.stringify(blocked));
  const jb = await q`SELECT status FROM dispatch_jobs WHERE id=${c.job}`;
  check("job STAYS arrived (photos invariant)", String(jb[0].status) === "arrived");
  // Now the remaining 8 photos.
  for (const phase of ["service", "final"]) for (let i = 0; i < SIDES.length; i++) {
    await uploadJobPhotoCore(user, { jobId: c.call, phase, side: SIDES[i], dataUrl: photoDataUrl("H") }, { fetchImpl });
  }
  // Customer declines the tip → completion still proceeds.
  const d = await declineTipCore(user, { jobId: c.call });
  check("tip decline recorded", d.ok === true && d.declined === true, JSON.stringify(d));
  const drow = await q`SELECT status, error FROM completion_tips WHERE org_id=${ORG2} AND job_id=${c.job} AND status='declined'`;
  check("declined attribution row on file", drow.length === 1 && String(drow[0].error).includes("declined"), JSON.stringify(drow));
  const d2 = await declineTipCore(user, { jobId: c.call });
  check("repeat decline is idempotent (one declined row)", d2.ok === true && drow.length === 1, JSON.stringify(d2));
  const done = await completeJobCore(user, { jobId: c.call }, { fetchImpl });
  check("complete ok after tip decline (no tip)", done.ok === true && done.photosUploaded === 12, JSON.stringify(done));
  const trow = await q`SELECT tip FROM job_completions WHERE org_id=${ORG2} AND job_id=${c.job}`;
  check("no tip recorded for the declined job", trow[0].tip == null, JSON.stringify(trow));
}

/* ============ 9) ORG3 — payment failure → retry/decline; never blocks completion ============ */
{
  const c = CONF[ORG3];
  const failFetch = makeFetch({ callId: c.call, payments: "always-fail" });
  const { fetchImpl: f1, squareCalls: sq1 } = failFetch;
  const user = userFor(ORG3);
  const cap = await captureCompletionCore(user, { jobId: c.call, signatureDataUrl: sigDataUrl("K"), survey: { rating: 5 } }, { fetchImpl: f1 });
  check("ORG3 capture saved", cap.ok === true, JSON.stringify(cap));
  const bad = await chargeTipCore(user, { jobId: c.call, token: "cnonce-card-0009", amountCents: 500, attempt: 1 }, { fetchImpl: f1 });
  check("declined card → square_failed + retryable", bad.ok === false && bad.code === "square_failed" && bad.retryable === true, JSON.stringify(bad));
  check("Square 400 surfaced (CARD_DECLINED)", String(bad.message).includes("CARD_DECLINED"), bad.message);
  const frow = await q`SELECT status, error, attempt, idempotency_key FROM completion_tips WHERE org_id=${ORG3} AND job_id=${c.job} AND status='failed'`;
  check("failed attempt recorded in completion_tips (attempt 1 + key + error)",
    frow.length === 1 && Number(frow[0].attempt) === 1 && frow[0].idempotency_key === `tip-${c.job}-37-1` && String(frow[0].error).includes("CARD_DECLINED"), JSON.stringify(frow));
  const jc = await q`SELECT tip FROM job_completions WHERE org_id=${ORG3} AND job_id=${c.job}`;
  check("no tip recorded after failure", jc[0].tip == null, JSON.stringify(jc));

  // Retry path: a working Square now (new fetch; attempt 2) — completes the job.
  const okFetch = makeFetch({ callId: c.call, payments: "ok" });
  const { fetchImpl: f2, squareCalls: sq2 } = okFetch;
  const retry = await chargeTipCore(user, { jobId: c.call, token: "cnonce-card-0010", amountCents: 500, attempt: 2 }, { fetchImpl: f2 });
  check("retry (attempt 2) succeeds with a fresh key", retry.ok === true && sq2[0].body.idempotency_key === `tip-${c.job}-37-2`, JSON.stringify(retry));
  const paid = await q`SELECT COUNT(*)::int AS n FROM completion_tips WHERE org_id=${ORG3} AND job_id=${c.job} AND status='paid'`;
  check("retry records one paid row", Number(paid[0].n) === 1, JSON.stringify(paid));

  // "Never blocks": complete right after the failure/retry with full photos.
  await uploadAllPhotos(ORG3, f2, "M");
  const done = await completeJobCore(user, { jobId: c.call }, { fetchImpl: f2 });
  check("complete ok after payment failure + retry", done.ok === true && done.photosUploaded === 12, JSON.stringify(done));
}

/* ============ 10) ORG3 — Square not configured → chargeTip offline; completion proceeds ============ */
{
  const c = CONF[ORG3];
  const noSquareDir = `/tmp/square-missing-${Date.now()}`;
  const saved = { s: process.env.SQUARE_ACCESS_TOKEN, l: process.env.SQUARE_LOCATION_ID, a: process.env.SQUARE_APPLICATION_ID };
  delete process.env.SQUARE_ACCESS_TOKEN; delete process.env.SQUARE_LOCATION_ID; delete process.env.SQUARE_APPLICATION_ID;
  const user = userFor(ORG3);
  const { fetchImpl } = makeFetch({ callId: c.call, payments: "ok" });
  const noTip = await chargeTipCore(user, { jobId: c.call, token: "cnonce-card-0011", amountCents: 500, attempt: 1 }, { fetchImpl, squareStableDir: noSquareDir });
  process.env.SQUARE_ACCESS_TOKEN = saved.s; process.env.SQUARE_LOCATION_ID = saved.l; process.env.SQUARE_APPLICATION_ID = saved.a;
  check("chargeTip without creds → square_not_configured (never blocks)", noTip.ok === false && noTip.code === "square_not_configured", JSON.stringify(noTip));
  const cap = await completionCaptureForJob(ORG3, c.job);
  check("capture still intact (signature + survey)", cap.signatureCaptured === true && cap.survey?.rating === 5, JSON.stringify(cap));
}

/* ================================ summary + cleanup ================================ */
const failed = checks.filter(([, ok]) => !ok);
console.log(`completion-flow.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }
// Prove cleanup: deleting the QA orgs cascades every row they created.
for (const org of [ORG, ORG2, ORG3]) { assertQaOrg(org); await q`DELETE FROM organizations WHERE id=${org}`.catch(() => {}); }
for (const u of [OWNER, OWNER2, OWNER3, DRIVER, DRIVER2, DRIVER3, OTHER]) await q`DELETE FROM users WHERE id=${u}`.catch(() => {});
const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM completion_tips t JOIN organizations o ON o.id=t.org_id WHERE o.name='qa completion-flow wp') AS tips,
  (SELECT COUNT(*)::int FROM job_completions jc JOIN organizations o ON o.id=jc.org_id WHERE o.name='qa completion-flow wp') AS completions,
  (SELECT COUNT(*)::int FROM job_photos p JOIN organizations o ON o.id=p.org_id WHERE o.name='qa completion-flow wp') AS photos,
  (SELECT COUNT(*)::int FROM dispatch_jobs j JOIN organizations o ON o.id=j.org_id WHERE o.name='qa completion-flow wp') AS jobs,
  (SELECT COUNT(*)::int FROM status_events e JOIN organizations o ON o.id=e.org_id WHERE o.name='qa completion-flow wp') AS events,
  (SELECT COUNT(*)::int FROM audit_log a JOIN organizations o ON o.id=a.org_id WHERE o.name='qa completion-flow wp') AS audit,
  (SELECT COUNT(*)::int FROM towbook_sessions s JOIN organizations o ON o.id=s.org_id WHERE o.name='qa completion-flow wp') AS sessions,
  (SELECT COUNT(*)::int FROM org_settings s JOIN organizations o ON o.id=s.org_id WHERE o.name='qa completion-flow wp') AS settings,
  (SELECT COUNT(*)::int FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name='qa completion-flow wp') AS members,
  (SELECT COUNT(*)::int FROM users u WHERE u.id IN (${OWNER}, ${OWNER2}, ${OWNER3}, ${DRIVER}, ${DRIVER2}, ${DRIVER3}, ${OTHER})) AS users`;
const z = Object.values(leftover[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) { console.error("FAIL: QA cleanup left rows behind"); process.exit(1); }
console.log("completion-flow.test.mjs: cleanup verified — zero QA rows left");
