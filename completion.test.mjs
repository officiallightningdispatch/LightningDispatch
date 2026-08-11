// Hermetic completion-flow tests (2026-08-11, milestone "completion flow"):
// the customer completion capture — signature PNG → B2, survey (rating 1-5 +
// comment), optional Square tip link (Create Payment Link API, Bearer token,
// driver-attributed line item) — plus the new completeJobCore rail
// (completion_capture_required until the capture is on file; the tip is never
// required). Real network calls never happen: Square + B2 + Towbook paths all
// take an injectable fetchImpl (mock Square/B2 with an in-memory object store,
// Towbook photos POST + calls PUT/GET). DB-backed against throwaway QA orgs
// deleted at the end (zero rows left anywhere).
//   DATABASE_URL=... bun completion.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
// Test key for THIS process only (env-first resolution overrides the stable
// key file — same pattern as the other suites).
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 9).toString("base64");
const { loadSquareConfig, createPaymentLink } = await import("./src/data/square-client.ts");
const {
  captureCompletionCore,
  createTipLinkCore,
  completionCaptureForJob,
  isSquareConfiguredCore,
  allCompletionCapturesCore,
} = await import("./src/data/completion-core.ts");
const { uploadJobPhotoCore, setVehicleMatchCore, completeJobCore, decodeDataUrl } = await import("./src/data/driver-photos-core.ts");
const { encryptSession } = await import("./src/data/towbook-key.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

const ORG = `qa-completion-${randomUUID()}`;      // full flow: capture → tip → complete
const ORG2 = `qa-completion2-${randomUUID()}`;    // Square not configured: capture + complete without tip
const OWNER = `qa-completion-owner-${randomUUID()}`;
const OWNER2 = `qa-completion-owner2-${randomUUID()}`;
const DRIVER = `qa-completion-driver-${randomUUID()}`;
const DRIVER2 = `qa-completion-driver2-${randomUUID()}`;
const OTHER = `qa-completion-other-${randomUUID()}`; // not assigned to any job
const CONF = {
  [ORG]: { userId: DRIVER, tbDriver: "15", tbUser: "115", job: "tb-445005", call: "445005" },
  [ORG2]: { userId: DRIVER2, tbDriver: "16", tbUser: "116", job: "tb-446006", call: "446006" },
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
 *  an in-memory object store), Towbook photos POST / calls PUT+GET, and the
 *  Square Create Payment Link API. Records every call. */
function makeFetch({ callId, getStatusId = 5 } = {}) {
  const calls = [];
  const squareCalls = [];
  const objects = new Map(); // s3 key → bytes
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
    if (u.startsWith("https://connect.squareup.com/v2/online-checkout/payment-links") && method === "POST") {
      squareCalls.push({ url: u, body: init.body, headers: init.headers });
      return resp(200, { json: { payment_link: { id: "pl_test_123", url: "https://square.link/u/qa-tip" } } });
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
  return { fetchImpl, calls, squareCalls, objects };
}

const photoDataUrl = (marker) => `data:image/jpeg;base64,${marker.repeat(1500)}`;
// A real (minimal) PNG with a unique marker suffix — the signature path checks
// the PNG magic bytes, so the payload must actually be a PNG.
const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const sigDataUrl = (marker) => `data:image/png;base64,${Buffer.concat([PNG_1x1, Buffer.from(marker.repeat(100))]).toString("base64")}`;
const userFor = (orgId) => ({ orgId, id: CONF[orgId].userId, role: "contractor", towbookDriverId: CONF[orgId].tbDriver });

async function setup() {
  await ensureSchema();
  for (const [org, owner, driver, tbDriver, tbUser, job, callId] of [
    [ORG, OWNER, DRIVER, "15", "115", "tb-445005", "445005"],
    [ORG2, OWNER2, DRIVER2, "16", "116", "tb-446006", "446006"],
  ]) {
    await q`INSERT INTO organizations(id, name) VALUES(${org}, 'qa completion-flow')`;
    await q`INSERT INTO users(id, name, email, password_hash) VALUES(${owner}, 'QA Completion Owner', ${`completion-owner-${randomUUID()}@qa.local`}, 'x')`;
    await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${org}, ${owner}, 'owner')`;
    await q`INSERT INTO users(id, name, email, password_hash, towbook_driver_id, towbook_user_id) VALUES(${driver}, 'QA Completion Driver', ${`completion-driver-${randomUUID()}@qa.local`}, 'x', ${tbDriver}, ${tbUser})`;
    await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${org}, ${driver}, 'contractor')`;
    await q`INSERT INTO towbook_sessions(org_id, encrypted_session, status, session_kind, towbook_driver_id)
      VALUES(${org}, ${await encryptSession(JSON.stringify({ cookies: "xtl=fake", baseUrl: "https://app.towbook.com" }))}, 'connected', 'driver', ${tbDriver})`;
    await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, towbook_job_id, pickup, towbook_status, raw_json, pickup_lat, pickup_lng)
      VALUES(${job}, ${org}, 'QA Customer', '', 0, 0, 'Bridgeport', 'flatbed_tow', 'arrived', NOW(), '', ${callId}, '70 Pitt Street', '4', ${JSON.stringify(rawCall(callId, Number(tbDriver)))}::jsonb, ${PICKUP.lat}, ${PICKUP.lng})`;
    await q`INSERT INTO org_settings(org_id, geofence_radius_meters, photos_required) VALUES(${org}, 150, FALSE)`;
  }
  // An unassigned driver in ORG (wrong-driver rail).
  await q`INSERT INTO users(id, name, email, password_hash, towbook_driver_id) VALUES(${OTHER}, 'QA Completion Other', ${`completion-other-${randomUUID()}@qa.local`}, 'x', '99')`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${OTHER}, 'contractor')`;
}

// B2 + Square env for THIS process (env-first resolution; restored per-test where needed).
const SAVED = {
  k: process.env.B2_KEY_ID, a: process.env.B2_APPLICATION_KEY, b: process.env.B2_BUCKET_NAME,
  s: process.env.SQUARE_ACCESS_TOKEN, l: process.env.SQUARE_LOCATION_ID,
};
process.env.B2_KEY_ID = "004testkeyid";
process.env.B2_APPLICATION_KEY = "testsecret";
process.env.B2_BUCKET_NAME = "qa-bucket";
process.env.SQUARE_ACCESS_TOKEN = "test-square-token";
process.env.SQUARE_LOCATION_ID = "loc_test";

await setup();
// ONE mock fetch for ORG across all sections — the in-memory B2 object store
// must hold the photos the completion later reads back (same instance).
const orgFetch = makeFetch({ callId: CONF[ORG].call });

/* ============================ 1) Square config resolution ============================ */
{
  const cfg = await loadSquareConfig();
  check("env-first Square config", cfg.accessToken === "test-square-token" && cfg.locationId === "loc_test", JSON.stringify(cfg));
  const saved = { s: process.env.SQUARE_ACCESS_TOKEN, l: process.env.SQUARE_LOCATION_ID };
  delete process.env.SQUARE_ACCESS_TOKEN; delete process.env.SQUARE_LOCATION_ID;
  let threw = false;
  try { await loadSquareConfig({}, { stableDir: `/tmp/square-missing-${Date.now()}` }); } catch (e) { threw = String(e).includes("Square is not configured") && String(e).includes("SQUARE_ACCESS_TOKEN"); }
  check("missing Square creds → clear structured error", threw);
  check("decodeDataUrl accepts PNG (signature)", decodeDataUrl(sigDataUrl("S"))?.mime === "image/png");
  process.env.SQUARE_ACCESS_TOKEN = saved.s; process.env.SQUARE_LOCATION_ID = saved.l;
  check("isSquareConfiguredCore true with env set", (await isSquareConfiguredCore()) === true);
}

/* ============ 2) capture gate: complete without capture → completion_capture_required ============ */
{
  const c = CONF[ORG];
  const { fetchImpl, calls } = orgFetch;
  const user = userFor(ORG);
  // Full 12 photos, but NO customer capture.
  for (const phase of PHASES) for (let i = 0; i < SIDES.length; i++) {
    await uploadJobPhotoCore(user, { jobId: c.call, phase, side: SIDES[i], dataUrl: photoDataUrl("A") }, { fetchImpl });
  }
  await setVehicleMatchCore(user, { jobId: c.call, confirmed: true });
  const r = await completeJobCore(user, { jobId: c.call }, { fetchImpl });
  check("complete without capture → completion_capture_required", r.ok === false && r.code === "completion_capture_required", JSON.stringify(r));
  const j = await q`SELECT status FROM dispatch_jobs WHERE id=${c.job}`;
  check("job STAYS arrived (no complete without capture)", String(j[0].status) === "arrived");
  check("no Towbook PUT after capture-required", !calls.some((x) => x.method === "PUT" && x.url.endsWith(`/api/calls/${c.call}`)));
  const cap = await completionCaptureForJob(ORG, c.job);
  check("capture status none", cap.status === "none" && cap.signatureCaptured === false && cap.tip === null, JSON.stringify(cap));
}

/* ============ 3) survey validation + signature save + retake (upsert) ============ */
{
  const c = CONF[ORG];
  const { fetchImpl, calls } = orgFetch;
  const user = userFor(ORG);
  const bad = [
    { rating: 0 }, { rating: 6 }, { rating: 3.5 }, { rating: "5" }, {},
  ];
  for (const survey of bad) {
    const r = await captureCompletionCore(user, { jobId: c.call, signatureDataUrl: sigDataUrl("B"), survey }, { fetchImpl });
    check(`survey rejected: ${JSON.stringify(survey)}`, r.ok === false && r.code === "invalid_input", JSON.stringify(r));
  }
  const noSig = await captureCompletionCore(user, { jobId: c.call, signatureDataUrl: "data:image/png;base64,AAAA", survey: { rating: 5 } }, { fetchImpl });
  check("non-image signature rejected (no PNG magic)", noSig.ok === false && noSig.code === "invalid_input", JSON.stringify(noSig));
  const emptySig = await captureCompletionCore(user, { jobId: c.call, signatureDataUrl: "data:image/png;base64,", survey: { rating: 5 } }, { fetchImpl });
  check("empty signature rejected", emptySig.ok === false && emptySig.code === "invalid_input", JSON.stringify(emptySig));
  const sigPuts = calls.filter((x) => x.method === "PUT" && String(x.url).includes("completion/signature.png"));
  check("no B2 PUT for rejected signatures", sigPuts.length === 0, JSON.stringify(sigPuts));

  const r1 = await captureCompletionCore(user, { jobId: c.call, signatureDataUrl: sigDataUrl("C"), survey: { rating: 5, comment: "Great service" } }, { fetchImpl });
  check("capture saved", r1.ok === true && r1.completion.status === "captured" && r1.completion.survey?.rating === 5, JSON.stringify(r1));
  const key1 = `ld-photos/${ORG}/${c.job}/completion/signature.png`;
  const sigPuts2 = calls.filter((x) => x.method === "PUT" && String(x.url).includes("completion/signature.png"));
  check("signature PNG stored in B2 at the completion key", sigPuts2.length === 1 && sigPuts2[0].url.includes(key1), JSON.stringify(sigPuts2.map((x) => x.url)));
  const row1 = await q`SELECT signature_storage_key, survey, tip FROM job_completions WHERE org_id=${ORG} AND job_id=${c.job}`;
  check("row upserted with key + survey", row1.length === 1 && String(row1[0].signature_storage_key) === key1 && Number(row1[0].survey.rating) === 5 && String(row1[0].survey.comment) === "Great service", JSON.stringify(row1));
  check("capture read status captured", (await completionCaptureForJob(ORG, c.job)).status === "captured");

  // Wrong driver rail.
  const other = { orgId: ORG, id: OTHER, role: "contractor", towbookDriverId: "99" };
  const denied = await captureCompletionCore(other, { jobId: c.call, signatureDataUrl: sigDataUrl("D"), survey: { rating: 5 } }, { fetchImpl });
  check("wrong driver → unauthorized", denied.ok === false && denied.code === "unauthorized", JSON.stringify(denied));

  // Retake: same key/row updated, one row only.
  const r2 = await captureCompletionCore(user, { jobId: c.call, signatureDataUrl: sigDataUrl("E"), survey: { rating: 4, comment: "Updated" } }, { fetchImpl });
  check("retake saved", r2.ok === true && r2.completion.survey?.rating === 4, JSON.stringify(r2));
  const row2 = await q`SELECT COUNT(*)::int AS n FROM job_completions WHERE org_id=${ORG} AND job_id=${c.job}`;
  check("retake upserts (one row)", Number(row2[0].n) === 1);
  const row2b = await q`SELECT survey FROM job_completions WHERE org_id=${ORG} AND job_id=${c.job}`;
  check("retake updates survey", Number(row2b[0].survey.rating) === 4, JSON.stringify(row2b));
}

/* ============ 4) tip link creation (Square, driver-attributed) ============ */
{
  const c = CONF[ORG];
  const { fetchImpl, squareCalls } = orgFetch;
  const user = userFor(ORG);
  const t = await createTipLinkCore(user, { jobId: c.call, amountCents: 500 }, { fetchImpl });
  check("tip link created", t.ok === true && t.paymentLinkUrl === "https://square.link/u/qa-tip" && t.amountCents === 500, JSON.stringify(t));
  check("one Square POST with Bearer token", squareCalls.length === 1 && String(squareCalls[0].headers?.authorization) === "Bearer test-square-token", JSON.stringify(squareCalls.map((x) => x.headers)));
  const body = JSON.parse(String(squareCalls[0].body));
  check("idempotency key present", typeof body.idempotency_key === "string" && body.idempotency_key.length > 8);
  check("location id in order", body.order?.location_id === "loc_test", JSON.stringify(body.order));
  const item = body.order?.line_items?.[0];
  check("line item name carries driver + job attribution", String(item?.name).includes("QA Completion Driver") && String(item?.name).includes("job 445005"), JSON.stringify(item));
  check("line item amount + currency", item?.quantity === "1" && item?.base_price_money?.amount === 500 && item?.base_price_money?.currency === "USD", JSON.stringify(item));
  const row = await q`SELECT tip FROM job_completions WHERE org_id=${ORG} AND job_id=${c.job}`;
  const tip = row[0].tip;
  check("tip row stored (link_created, amount, link id, driver)", tip && tip.status === "link_created" && tip.amount_cents === 500 && tip.currency === "USD" && tip.square_payment_link_id === "pl_test_123" && tip.driver_towbook_id === "15", JSON.stringify(tip));
  const cap = await completionCaptureForJob(ORG, c.job);
  check("capture status tip_link_created", cap.status === "tip_link_created" && cap.tip?.amountCents === 500, JSON.stringify(cap));

  // Signature retake AFTER a tip must NOT wipe the tip.
  const r = await captureCompletionCore(user, { jobId: c.call, signatureDataUrl: sigDataUrl("F"), survey: { rating: 5 } }, { fetchImpl });
  check("retake after tip ok", r.ok === true);
  const row2 = await q`SELECT tip FROM job_completions WHERE org_id=${ORG} AND job_id=${c.job}`;
  check("tip survives a signature retake", row2[0].tip?.status === "link_created" && row2[0].tip?.amount_cents === 500, JSON.stringify(row2[0].tip));

  // Amount validation.
  const badAmt = await createTipLinkCore(user, { jobId: c.call, amountCents: 50 }, { fetchImpl });
  check("tip amount below $1 rejected", badAmt.ok === false, JSON.stringify(badAmt));
}

/* ============ 5) complete end-to-end after capture (12 photos + capture, tip present) ============ */
{
  const c = CONF[ORG];
  const { fetchImpl, calls } = orgFetch;
  const user = userFor(ORG);
  const done = await completeJobCore(user, { jobId: c.call }, { fetchImpl });
  check("completion ok with capture + tip", done.ok === true && done.photosUploaded === 12 && done.towbookCompleted === true && done.changed === true, JSON.stringify(done));
  const puts = calls.filter((x) => x.method === "PUT" && x.url.endsWith(`/api/calls/${c.call}`));
  check("Towbook PUT status 5 happened", puts.length === 1 && JSON.parse(puts[0].body).status.id === 5);
  const j = await q`SELECT status, completed_at FROM dispatch_jobs WHERE id=${c.job}`;
  check("platform job completed + completed_at", String(j[0].status) === "completed" && j[0].completed_at != null, JSON.stringify(j));
  const aud = await q`SELECT action FROM audit_log WHERE org_id=${ORG} AND action='job_capture_saved'`;
  check("capture audited", aud.length >= 1, JSON.stringify(aud));
}

/* ============ 6) Square not configured → capture + complete still fine (no tip) ============ */
{
  const c = CONF[ORG2];
  const { fetchImpl, squareCalls } = makeFetch({ callId: c.call });
  const user = userFor(ORG2);
  // Hermetic: point the file fallback at a nonexistent dir AND clear the env
  // vars (env-first) so this passes even when real .secrets files exist here.
  const noSquareDir = `/tmp/square-missing-${Date.now()}`;
  const savedSq = { s: process.env.SQUARE_ACCESS_TOKEN, l: process.env.SQUARE_LOCATION_ID };
  delete process.env.SQUARE_ACCESS_TOKEN; delete process.env.SQUARE_LOCATION_ID;
  const noTip = await createTipLinkCore(user, { jobId: c.call, amountCents: 500 }, { fetchImpl, squareStableDir: noSquareDir });
  process.env.SQUARE_ACCESS_TOKEN = savedSq.s; process.env.SQUARE_LOCATION_ID = savedSq.l;
  check("tip without Square creds → square_not_configured", noTip.ok === false && noTip.code === "square_not_configured", JSON.stringify(noTip));
  check("no Square POST fired", squareCalls.length === 0, JSON.stringify(squareCalls));

  const cap = await captureCompletionCore(user, { jobId: c.call, signatureDataUrl: sigDataUrl("G"), survey: { rating: 5 } }, { fetchImpl });
  check("capture fine without Square", cap.ok === true && cap.completion.status === "captured", JSON.stringify(cap));

  // (g) tip absent is fine: full 12 photos + capture → complete.
  for (const phase of PHASES) for (let i = 0; i < SIDES.length; i++) {
    await uploadJobPhotoCore(user, { jobId: c.call, phase, side: SIDES[i], dataUrl: photoDataUrl("H") }, { fetchImpl });
  }
  await setVehicleMatchCore(user, { jobId: c.call, confirmed: true });
  const done = await completeJobCore(user, { jobId: c.call }, { fetchImpl });
  check("complete ok without tip (capture only)", done.ok === true && done.photosUploaded === 12 && done.towbookCompleted === true, JSON.stringify(done));
  const row = await q`SELECT tip FROM job_completions WHERE org_id=${ORG2} AND job_id=${c.job}`;
  check("tip remains absent", row[0].tip == null, JSON.stringify(row));
  const statuses = await allCompletionCapturesCore(ORG2);
  check("allCompletionCapturesCore lists the captured job", statuses.length === 1 && statuses[0].status === "captured", JSON.stringify(statuses));
}

/* ================================ summary + cleanup ================================ */
const failed = checks.filter(([, ok]) => !ok);
console.log(`completion.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }
// Prove cleanup: deleting the QA orgs cascades every row they created.
for (const org of [ORG, ORG2]) await q`DELETE FROM organizations WHERE id=${org}`.catch(() => {});
for (const u of [OWNER, OWNER2, DRIVER, DRIVER2, OTHER]) await q`DELETE FROM users WHERE id=${u}`.catch(() => {});
const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM job_completions jc JOIN organizations o ON o.id=jc.org_id WHERE o.name='qa completion-flow') AS completions,
  (SELECT COUNT(*)::int FROM job_photos p JOIN organizations o ON o.id=p.org_id WHERE o.name='qa completion-flow') AS photos,
  (SELECT COUNT(*)::int FROM dispatch_jobs j JOIN organizations o ON o.id=j.org_id WHERE o.name='qa completion-flow') AS jobs,
  (SELECT COUNT(*)::int FROM status_events e JOIN organizations o ON o.id=e.org_id WHERE o.name='qa completion-flow') AS events,
  (SELECT COUNT(*)::int FROM audit_log a JOIN organizations o ON o.id=a.org_id WHERE o.name='qa completion-flow') AS audit,
  (SELECT COUNT(*)::int FROM towbook_sessions s JOIN organizations o ON o.id=s.org_id WHERE o.name='qa completion-flow') AS sessions,
  (SELECT COUNT(*)::int FROM org_settings s JOIN organizations o ON o.id=s.org_id WHERE o.name='qa completion-flow') AS settings,
  (SELECT COUNT(*)::int FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name='qa completion-flow') AS members,
  (SELECT COUNT(*)::int FROM users u WHERE u.id IN (${OWNER}, ${OWNER2}, ${DRIVER}, ${DRIVER2}, ${OTHER})) AS users`;
const z = Object.values(leftover[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) { console.error("FAIL: QA cleanup left rows behind"); process.exit(1); }
console.log("completion.test.mjs: cleanup verified — zero QA rows left");
