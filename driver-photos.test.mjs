// Hermetic driver-photos tests (2026-08-11, milestone #4): the 4+4+4 photo
// pipeline — B2 upload path (mocked S3, SigV4 asserted against the AWS docs
// vector), phase gating, soft/final/complete transitions, the Towbook PO
// upload on completion (mocked fetch: multipart field `file` + description),
// upload-failure escalation, and end-to-end cleanup proving zero QA rows.
// Real network calls never happen; every Towbook/B2-facing path takes an
// injectable fetchImpl. DB-backed against throwaway QA orgs deleted at the end.
//   DATABASE_URL=... bun driver-photos.test.mjs
// DB safety (2026-08-12): org deletes guarded by assertQaOrg — see src/data/db-guard.ts + /home/team/shared/db-safety-rules.md.
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
// Test key for THIS process only (env-first resolution overrides the stable
// key file). The QA session rows are encrypted with it; the running server is
// a separate process and never sees it.
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 9).toString("base64");
const {
  signV4,
  regionFromS3Url,
  loadB2Config,
} = await import("./src/data/b2-client.ts");
const {
  uploadJobPhotoCore,
  setVehicleMatchCore,
  softCompleteCore,
  finalCompleteCore,
  completeJobCore,
  jobPhotoRows,
  summarizePhotos,
  derivePhase,
  photoStatusForJob,
  photosCompleteForJob: _unused, // gate lives in driver-gps-core
} = await import("./src/data/driver-photos-core.ts");
const { getJobPhotoCore } = await import("./src/data/job-detail-core.ts");
const { captureCompletionCore } = await import("./src/data/completion-core.ts");
const { photosCompleteForJob, evaluateGeofence, getGeofenceSettings } = await import("./src/data/driver-gps-core.ts");
const { encryptSession } = await import("./src/data/towbook-key.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

const ORG = `qa-photos-${randomUUID()}`;          // pre-arrival gate + auto-arrive
const ORG2 = `qa-photos2-${randomUUID()}`;        // full completion flow
const ORG3 = `qa-photos3-${randomUUID()}`;        // Towbook photo-upload failure
const ORG4 = `qa-photos4-${randomUUID()}`;        // B2 creds missing
const OWNER = `qa-photos-owner-${randomUUID()}`;
const OWNER2 = `qa-photos-owner2-${randomUUID()}`;
const OWNER3 = `qa-photos-owner3-${randomUUID()}`;
const OWNER4 = `qa-photos-owner4-${randomUUID()}`;
const DRIVER = `qa-photos-driver-${randomUUID()}`;
const DRIVER2 = `qa-photos-driver2-${randomUUID()}`;
const DRIVER3 = `qa-photos-driver3-${randomUUID()}`;
const DRIVER4 = `qa-photos-driver4-${randomUUID()}`;
const OTHER = `qa-photos-other-${randomUUID()}`;  // not assigned to any job
// Per-run Towbook driver/user ids — fixed ids (11-14/15, 111-114) collide
// with leftover QA rows from crashed runs (both LD ids' unique indexes are global).
const tb = (seed) => String(BigInt("0x" + seed.slice(-36).replace(/-/g, "").slice(0, 10)) % 900_000_000n);
const tbu = (seed) => String(900_000_000n + BigInt("0x" + seed.slice(-36).replace(/-/g, "").slice(0, 10)) % 100_000_000n);
const TB1 = tb(DRIVER), TB2 = tb(DRIVER2), TB3 = tb(DRIVER3), TB4 = tb(DRIVER4), TBO = tb(OTHER);
const TBU1 = tbu(DRIVER), TBU2 = tbu(DRIVER2), TBU3 = tbu(DRIVER3), TBU4 = tbu(DRIVER4);
// Per-run Towbook call ids (9-digit) — job ids (`tb-<call>`) and towbook_job_id
// both derive from the org's own UUID so crashed runs can never collide on
// dispatch_jobs_pkey or the call-id resolution.
const cid = (seed) => String(100_000_000n + BigInt("0x" + seed.slice(-36).replace(/-/g, "").slice(0, 10)) % 90_000_000n);
const CONF = {
  [ORG]: { userId: DRIVER, owner: OWNER, tbDriver: TB1, tbUser: TBU1, job: `tb-${cid(ORG)}`, call: cid(ORG), status: "en_route" },
  [ORG2]: { userId: DRIVER2, owner: OWNER2, tbDriver: TB2, tbUser: TBU2, job: `tb-${cid(ORG2)}`, call: cid(ORG2), status: "arrived" },
  [ORG3]: { userId: DRIVER3, owner: OWNER3, tbDriver: TB3, tbUser: TBU3, job: `tb-${cid(ORG3)}`, call: cid(ORG3), status: "arrived" },
  [ORG4]: { userId: DRIVER4, owner: OWNER4, tbDriver: TB4, tbUser: TBU4, job: `tb-${cid(ORG4)}`, call: cid(ORG4), status: "arrived" },
};
const PICKUP = { lat: 41.2, lng: -73.2 };
const northMeters = (m) => PICKUP.lat + m / 111190;

const SIDES = ["front", "driver_side", "passenger_side", "rear"];
const PHASES = ["pre_arrival", "service", "final"];
const rawCall = (callId, driverId, statusId) => ({
  id: Number(callId),
  callNumber: Number(callId),
  status: { id: statusId },
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

/** Mock fetch for the WHOLE photo surface: B2 authorize + S3 PUT/GET (with an
 *  in-memory object store so completion forwards the exact uploaded bytes),
 *  and Towbook photos POST / calls PUT+GET. Records every call. */
function makeFetch({ callId, getStatusId = 5, failPhotosOn = -1, putStatus = 200 } = {}) {
  const calls = [];
  const objects = new Map(); // s3 key → bytes
  let photosPosts = 0;
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
    if (u.includes(`/api/calls/${callId}/photos`) && method === "POST") {
      photosPosts += 1;
      if (failPhotosOn === photosPosts) return resp(500, { json: { message: "boom" } });
      return resp(201, { json: { ok: true } });
    }
    if (u.endsWith(`/api/calls/${callId}`) && method === "PUT") {
      return resp(putStatus, { json: { id: Number(callId), status: { id: 5 } } });
    }
    if (u.endsWith(`/api/calls/${callId}`) && method === "GET") {
      return resp(200, { json: { id: Number(callId), status: { id: getStatusId } } });
    }
    throw new Error(`unexpected call: ${method} ${u}`);
  };
  return { fetchImpl, calls, objects };
}

const photoDataUrl = (marker) => `data:image/jpeg;base64,${marker.repeat(1500)}`;
// A real (minimal) PNG with a unique marker suffix — the signature path checks
// the PNG magic bytes, so the payload must actually be a PNG.
const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const sigDataUrl = (marker) => `data:image/png;base64,${Buffer.concat([PNG_1x1, Buffer.from(marker.repeat(100))]).toString("base64")}`;
const bytesOf = (marker) => Buffer.from(marker.repeat(1500), "base64");
const userFor = (orgId) => ({ orgId, id: CONF[orgId].userId, role: "contractor", towbookDriverId: CONF[orgId].tbDriver });

async function setup() {
  await ensureSchema();
  for (const org of [ORG, ORG2, ORG3, ORG4]) {
    const c = CONF[org];
    await q`INSERT INTO organizations(id, name) VALUES(${org}, 'qa driver-photos')`;
    await q`INSERT INTO users(id, name, email, password_hash) VALUES(${c.owner}, 'QA Photos Owner', ${`photos-owner-${randomUUID()}@qa.local`}, 'x')`;
    await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${org}, ${c.owner}, 'owner')`;
    await q`INSERT INTO users(id, name, email, password_hash, towbook_driver_id, towbook_user_id) VALUES(${c.userId}, 'QA Photos Driver', ${`photos-driver-${randomUUID()}@qa.local`}, 'x', ${c.tbDriver}, ${c.tbUser})`;
    await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${org}, ${c.userId}, 'contractor')`;
    await q`INSERT INTO towbook_sessions(org_id, encrypted_session, status, session_kind, towbook_driver_id)
      VALUES(${org}, ${await encryptSession(JSON.stringify({ cookies: "xtl=fake", baseUrl: "https://app.towbook.com" }))}, 'connected', 'driver', ${c.tbDriver})`;
    await q`INSERT INTO dispatch_jobs(id, org_id, customer_name, phone, lat, lng, area, service_type, status, created_at, note, towbook_job_id, pickup, towbook_status, raw_json, pickup_lat, pickup_lng)
      VALUES(${c.job}, ${org}, 'QA Customer', '', 0, 0, 'Bridgeport', 'flatbed_tow', ${c.status}, NOW(), '', ${c.call}, '70 Pitt Street', ${c.status === "en_route" ? "3" : "4"}, ${JSON.stringify(rawCall(c.call, Number(c.tbDriver), c.status === "en_route" ? 3 : 4))}::jsonb, ${PICKUP.lat}, ${PICKUP.lng})`;
    await q`INSERT INTO org_settings(org_id, geofence_radius_meters, photos_required) VALUES(${org}, 150, ${org === ORG})`;
  }
  // An unassigned driver in ORG2 (wrong-driver rail).
  await q`INSERT INTO users(id, name, email, password_hash, towbook_driver_id) VALUES(${OTHER}, 'QA Other Driver', ${`photos-other-${randomUUID()}@qa.local`}, 'x', ${TBO})`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG2}, ${OTHER}, 'contractor')`;
}

// B2 env for THIS process (env-first resolution; restored per-test where needed).
const SAVED = { k: process.env.B2_KEY_ID, a: process.env.B2_APPLICATION_KEY, b: process.env.B2_BUCKET_NAME };
process.env.B2_KEY_ID = "004testkeyid";
process.env.B2_APPLICATION_KEY = "testsecret";
process.env.B2_BUCKET_NAME = "qa-bucket";

/* The whole body runs inside try (setup included) so a failing check or thrown
 * error can NEVER skip the cleanup block below — a crashed run leaves zero QA
 * rows. */
let runError = null;
try {
await setup();
/* ============================ 1) SigV4 (pure) ============================ */
{
  // AWS documentation test vector (GET object with Range header) — the exact
  // signature B2's S3-compatible API expects from any conforming client.
  const s = signV4({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    method: "GET",
    host: "examplebucket.s3.amazonaws.com",
    path: "/test.txt",
    headers: { Range: "bytes=0-9" },
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    now: new Date("2013-05-24T00:00:00Z"),
  });
  check("sigv4 matches the AWS docs vector", s.authorization === "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41", s.authorization);
  check("region parsed from B2 s3 url", regionFromS3Url("https://s3.us-west-004.backblazeb2.com") === "us-west-004");
}

/* ======================== 2) B2 key resolution ======================== */
{
  const cfg = await loadB2Config();
  check("env-first B2 config", cfg.keyId === "004testkeyid" && cfg.applicationKey === "testsecret" && cfg.bucketName === "qa-bucket", JSON.stringify(cfg));
  const saved = { k: process.env.B2_KEY_ID, a: process.env.B2_APPLICATION_KEY, b: process.env.B2_BUCKET_NAME };
  delete process.env.B2_KEY_ID; delete process.env.B2_APPLICATION_KEY; delete process.env.B2_BUCKET_NAME;
  let threw = false;
  // Hermetic: point the file fallback at a nonexistent dir so the test passes
  // even when real .secrets files exist on this machine.
  try { await loadB2Config({}, { stableDir: `/tmp/b2-missing-${Date.now()}` }); } catch (e) { threw = String(e).includes("Backblaze B2 is not configured") && String(e).includes("B2_KEY_ID"); }
  check("missing B2 creds → clear structured error", threw);
  process.env.B2_KEY_ID = saved.k; process.env.B2_APPLICATION_KEY = saved.a; process.env.B2_BUCKET_NAME = saved.b;
}

/* ============ 3) pre-arrival uploads + gate + auto-arrive (ORG) ============ */
{
  const c = CONF[ORG];
  const { fetchImpl, calls, objects } = makeFetch({ callId: c.call });
  const user = userFor(ORG);
  for (let i = 0; i < SIDES.length; i++) {
    const marker = String.fromCharCode(65 + i); // A, B, C, D
    const r = await uploadJobPhotoCore(user, { jobId: c.call, phase: "pre_arrival", side: SIDES[i], dataUrl: photoDataUrl(marker) }, { fetchImpl });
    check(`pre-arrival ${SIDES[i]} upload ok`, r.ok && r.storageKey === `ld-photos/${ORG}/${c.job}/pre_arrival/${SIDES[i]}.jpg`, JSON.stringify(r));
  }
  const putCalls = calls.filter((x) => x.method === "PUT" && x.url.startsWith("https://s3.us-west-004.backblazeb2.com/"));
  check("B2 PUTs happened with SigV4 auth", putCalls.length === 4 && putCalls.every((x) => /AWS4-HMAC-SHA256 Credential=004testkeyid\/\d{8}\/us-west-004\/s3\/aws4_request/.test(x.headers?.authorization ?? "")), JSON.stringify(putCalls.map((x) => x.url)));
  check("B2 object keys + bytes written", objects.has(`qa-bucket/ld-photos/${ORG}/${c.job}/pre_arrival/front.jpg`) && Buffer.compare(objects.get(`qa-bucket/ld-photos/${ORG}/${c.job}/pre_arrival/front.jpg`), bytesOf("A")) === 0);
  const rows = await jobPhotoRows(ORG, c.job);
  const { counts, complete, matchConfirmed } = summarizePhotos(rows);
  check("4 pre-arrival rows, no match yet", counts.pre_arrival === 4 && complete.pre_arrival === true && matchConfirmed === false, JSON.stringify(counts));
  check("gate: 4 photos but no match → false", (await photosCompleteForJob(ORG, c.job)) === false);

  // Wrong driver: the unassigned OTHER driver in ORG2 cannot touch ORG's job.
  const other = { orgId: ORG, id: OTHER, role: "contractor", towbookDriverId: TBO };
  const denied = await uploadJobPhotoCore(other, { jobId: c.call, phase: "pre_arrival", side: "front", dataUrl: photoDataUrl("Z") }, { fetchImpl });
  check("wrong driver → unauthorized", denied.ok === false && denied.code === "unauthorized", JSON.stringify(denied));

  const conf = await setVehicleMatchCore(user, { jobId: c.call, confirmed: true });
  check("match confirmed", conf.ok === true && conf.matchConfirmed === true, JSON.stringify(conf));
  check("gate: 4 photos + match → true", (await photosCompleteForJob(ORG, c.job)) === true);

  // Retake resets the match confirmation (the new photo needs re-confirming).
  const retake = await uploadJobPhotoCore(user, { jobId: c.call, phase: "pre_arrival", side: "front", dataUrl: photoDataUrl("E") }, { fetchImpl });
  check("retake ok (same slot upsert)", retake.ok === true);
  const rows2 = await jobPhotoRows(ORG, c.job);
  check("retake keeps 4 rows but resets match", rows2.pre_arrival.front !== undefined && Object.keys(rows2.pre_arrival).length === 4 && summarizePhotos(rows2).matchConfirmed === false);
  await setVehicleMatchCore(user, { jobId: c.call, confirmed: true });

  // Auto-arrive fires once the gate passes (photos_required=true for ORG).
  // The core PUTs Towbook status 3 (On Scene) and verifies 3 (4 = Towing).
  const geoFetch = makeFetch({ callId: c.call, getStatusId: 3 });
  const out = await evaluateGeofence({ orgId: ORG, userId: c.userId, towbookDriverId: c.tbDriver, lat: PICKUP.lat, lng: PICKUP.lng, fetchImpl: geoFetch.fetchImpl });
  check("gate passed → geofence auto-arrives", out.action === "arrived" && out.towbookOk && out.verified, JSON.stringify(out));
  const st = await q`SELECT status FROM dispatch_jobs WHERE id=${c.job}`;
  check("job arrived after gate passed", String(st[0].status) === "arrived");
}

/* ================ 4) phase gating + soft/final/complete (ORG2) ================ */
{
  const c = CONF[ORG2];
  const { fetchImpl, calls: cc } = makeFetch({ callId: c.call });
  const user = userFor(ORG2);
  // Service photos before pre-arrival → locked.
  const early = await uploadJobPhotoCore(user, { jobId: c.call, phase: "service", side: "front", dataUrl: photoDataUrl("F") }, { fetchImpl });
  check("service before pre-arrival → phase_locked", early.ok === false && early.code === "phase_locked", JSON.stringify(early));
  // Soft complete with no pre-arrival → photos_incomplete.
  const soft0 = await softCompleteCore(user, { jobId: c.call });
  check("soft complete without photos → photos_incomplete", soft0.ok === false && soft0.code === "photos_incomplete", JSON.stringify(soft0));

  // 4 pre-arrival + match.
  for (let i = 0; i < SIDES.length; i++) {
    await uploadJobPhotoCore(user, { jobId: c.call, phase: "pre_arrival", side: SIDES[i], dataUrl: photoDataUrl(String.fromCharCode(70 + i)) }, { fetchImpl });
  }
  await setVehicleMatchCore(user, { jobId: c.call, confirmed: true });
  const soft = await softCompleteCore(user, { jobId: c.call });
  check("soft complete ok → service", soft.ok === true && soft.phase === "service", JSON.stringify(soft));
  // 3 service photos → final complete locked.
  for (let i = 0; i < 3; i++) {
    await uploadJobPhotoCore(user, { jobId: c.call, phase: "service", side: SIDES[i], dataUrl: photoDataUrl(String.fromCharCode(74 + i)) }, { fetchImpl });
  }
  const fin0 = await finalCompleteCore(user, { jobId: c.call });
  check("final complete with 3/4 service → photos_incomplete", fin0.ok === false && fin0.code === "photos_incomplete", JSON.stringify(fin0));
  await uploadJobPhotoCore(user, { jobId: c.call, phase: "service", side: "rear", dataUrl: photoDataUrl("N") }, { fetchImpl });
  const fin = await finalCompleteCore(user, { jobId: c.call });
  check("final complete ok → finalizing", fin.ok === true && fin.phase === "finalizing", JSON.stringify(fin));
  // Customer completion capture (completion flow): signature + survey on file
  // before complete — completeJobCore now hard-gates on it.
  // T10 (SUB A): before the capture is stored, completion refuses with
  // completion_capture_required (the signature/survey hard gate is unchanged).
  const noCapture = await completeJobCore(user, { jobId: c.call }, { fetchImpl });
  check("complete without customer capture → completion_capture_required", noCapture.ok === false && noCapture.code === "completion_capture_required", JSON.stringify(noCapture));
  const cap = await captureCompletionCore(user, { jobId: c.call, signatureDataUrl: sigDataUrl("Q"), survey: { rating: 5, comment: "QA" } }, { fetchImpl });
  check("customer capture saved (completion gate)", cap.ok === true && cap.completion.status === "captured", JSON.stringify(cap));
  // 3 final photos → completion locked.
  for (let i = 0; i < 3; i++) {
    await uploadJobPhotoCore(user, { jobId: c.call, phase: "final", side: SIDES[i], dataUrl: photoDataUrl(String.fromCharCode(79 + i)) }, { fetchImpl });
  }
  const comp0 = await completeJobCore(user, { jobId: c.call }, { fetchImpl });
  check("complete with 3/4 final → photos_incomplete", comp0.ok === false && comp0.code === "photos_incomplete", JSON.stringify(comp0));
  await uploadJobPhotoCore(user, { jobId: c.call, phase: "final", side: "rear", dataUrl: photoDataUrl("S") }, { fetchImpl });

  // THE completion: 12 photos → Towbook PO → PUT 5 verified → platform done.
  // Same mock instance as the uploads so the object store holds the bytes; its
  // defaults (PUT body status 5, GET verify getStatusId 5) match completion.
  const done = await completeJobCore(user, { jobId: c.call }, { fetchImpl });
  check("completion ok", done.ok === true && done.photosUploaded === 12 && done.towbookCompleted === true && done.changed === true, JSON.stringify(done));
  const posts = cc.filter((x) => x.method === "POST" && x.url.includes(`/api/calls/${c.call}/photos`));
  check("12 Towbook photo POSTs, verified 201", posts.length === 12 && posts.every((x) => String(x.body).includes('name="file"')), JSON.stringify(posts.map((x) => x.url)));
  const descs = posts.map((x) => decodeURIComponent(x.url.split("description=")[1]));
  const EXPECT = [];
  for (const phase of PHASES) for (const side of SIDES) EXPECT.push(`${phase === "pre_arrival" ? "Pre-arrival" : phase === "service" ? "Service" : "Final"} ${side === "driver_side" ? "Driver side" : side === "passenger_side" ? "Passenger side" : side === "front" ? "Front" : "Rear"}`);
  check("all 12 descriptions on the PO", EXPECT.every((d) => descs.includes(d)) && descs.length === new Set(descs).size, JSON.stringify(descs));
  check("photo bytes forwarded from B2 into the PO body", posts.some((x) => Buffer.from(x.body).includes(bytesOf("S"))));
  const puts = cc.filter((x) => x.method === "PUT" && x.url.endsWith(`/api/calls/${c.call}`));
  check("Towbook PUT status 5 happened (once)", puts.length === 1 && JSON.parse(puts[0].body).status.id === 5, JSON.stringify(puts.map((x) => x.body)));
  const j = await q`SELECT status, completed_at FROM dispatch_jobs WHERE id=${c.job}`;
  check("platform job completed + completed_at", String(j[0].status) === "completed" && j[0].completed_at != null, JSON.stringify(j));
  const ev = await q`SELECT from_status, to_status FROM status_events WHERE org_id=${ORG2} AND job_id=${c.job} ORDER BY occurred_at DESC LIMIT 1`;
  check("status_event arrived→completed", ev.length === 1 && String(ev[0].from_status) === "arrived" && String(ev[0].to_status) === "completed", JSON.stringify(ev));
  const aud = await q`SELECT action, detail FROM audit_log WHERE org_id=${ORG2} AND action='driver_job_complete' LIMIT 1`;
  check("audit driver_job_complete with photosUploaded=12", aud.length === 1 && Number(aud[0].detail.photosUploaded) === 12, JSON.stringify(aud));
  const status2 = await photoStatusForJob(ORG2, { id: c.job, status: "completed", towbookJobId: c.call, raw: null, assignedContractorId: null });
  check("derived phase completed", status2.phase === "completed" && derivePhase("completed", { pre_arrival: true, service: true, final: true }, true) === "completed");
}

/* ================ 5) Towbook photo-upload failure → escalation (ORG3) ================ */
{
  const c = CONF[ORG3];
  const { fetchImpl } = makeFetch({ callId: c.call });
  const user = userFor(ORG3);
  for (const phase of PHASES) for (let i = 0; i < SIDES.length; i++) {
    await uploadJobPhotoCore(user, { jobId: c.call, phase, side: SIDES[i], dataUrl: photoDataUrl("T") }, { fetchImpl });
  }
  await setVehicleMatchCore(user, { jobId: c.call, confirmed: true });
  const cap3 = await captureCompletionCore(user, { jobId: c.call, signatureDataUrl: sigDataUrl("W"), survey: { rating: 4 } }, { fetchImpl });
  check("ORG3 capture saved before failure test", cap3.ok === true, JSON.stringify(cap3));
  // The 3rd PO photo POST fails (500, retried once, still fails).
  const { fetchImpl: ff, calls: fc } = makeFetch({ callId: c.call, failPhotosOn: 3 });
  const r = await completeJobCore(user, { jobId: c.call }, { fetchImpl: ff });
  check("photo failure → photo_upload_failed + failures listed", r.ok === false && r.code === "photo_upload_failed" && Array.isArray(r.failures) && r.failures.length >= 1, JSON.stringify(r));
  const j = await q`SELECT status FROM dispatch_jobs WHERE id=${c.job}`;
  check("job STAYS arrived (no completion without photos)", String(j[0].status) === "arrived");
  check("no Towbook PUT status 5 after failure", !fc.some((x) => x.method === "PUT"), JSON.stringify(fc.map((x) => x.method)));
  const esc = await q`SELECT decision, escalated, reason FROM ai_dispatcher_decisions WHERE org_id=${ORG3}`;
  check("escalation escalated_photo_upload_failed recorded", esc.length === 1 && String(esc[0].decision) === "escalated_photo_upload_failed" && esc[0].escalated === true && String(esc[0].reason).includes("could not attach"), JSON.stringify(esc));
}

/* ================ 6) B2 creds missing → structured error (ORG4) ================ */
{
  const c = CONF[ORG4];
  const { fetchImpl } = makeFetch({ callId: c.call });
  const user = userFor(ORG4);
  // Upload-time missing creds: hard structured error, never fake success.
  const saved = { k: process.env.B2_KEY_ID, a: process.env.B2_APPLICATION_KEY, b: process.env.B2_BUCKET_NAME };
  delete process.env.B2_KEY_ID; delete process.env.B2_APPLICATION_KEY; delete process.env.B2_BUCKET_NAME;
  // Hermetic: point the file fallback at a nonexistent dir so this passes even
  // when real .secrets files exist on this machine.
  const noCredsDir = `/tmp/b2-missing-${Date.now()}`;
  const noCreds = await uploadJobPhotoCore(user, { jobId: c.call, phase: "pre_arrival", side: "front", dataUrl: photoDataUrl("U") }, { fetchImpl, b2StableDir: noCredsDir });
  check("upload without B2 creds → b2_not_configured", noCreds.ok === false && noCreds.code === "b2_not_configured" && noCreds.message.includes("Backblaze B2 is not configured"), JSON.stringify(noCreds));
  process.env.B2_KEY_ID = saved.k; process.env.B2_APPLICATION_KEY = saved.a; process.env.B2_BUCKET_NAME = saved.b;

  // Full 12-photo job, then creds removed at completion → fail loud + escalate.
  for (const phase of PHASES) for (let i = 0; i < SIDES.length; i++) {
    await uploadJobPhotoCore(user, { jobId: c.call, phase, side: SIDES[i], dataUrl: photoDataUrl("V") }, { fetchImpl });
  }
  await setVehicleMatchCore(user, { jobId: c.call, confirmed: true });
  // Customer capture saved WHILE creds are present (the completion gate needs it).
  const cap4 = await captureCompletionCore(user, { jobId: c.call, signatureDataUrl: sigDataUrl("R"), survey: { rating: 5 } }, { fetchImpl });
  check("ORG4 capture saved before creds removal", cap4.ok === true, JSON.stringify(cap4));
  delete process.env.B2_KEY_ID; delete process.env.B2_APPLICATION_KEY; delete process.env.B2_BUCKET_NAME;
  const r = await completeJobCore(user, { jobId: c.call }, { fetchImpl, b2StableDir: noCredsDir });
  process.env.B2_KEY_ID = saved.k; process.env.B2_APPLICATION_KEY = saved.a; process.env.B2_BUCKET_NAME = saved.b;
  check("completion without B2 → photo_upload_failed, no silent success", r.ok === false && r.code === "photo_upload_failed" && r.message.includes("Photo storage isn't connected"), JSON.stringify(r));
  const j = await q`SELECT status FROM dispatch_jobs WHERE id=${c.job}`;
  check("job stays arrived when B2 missing", String(j[0].status) === "arrived");
  const esc = await q`SELECT COUNT(*)::int AS n FROM ai_dispatcher_decisions WHERE org_id=${ORG4} AND decision='escalated_photo_upload_failed'`;
  check("B2-missing completion escalated", Number(esc[0].n) === 1);
}

/* ================ 7) owner/ops status read ================ */
{
  const rows = await jobPhotoRows(ORG2, CONF[ORG2].job);
  const st = summarizePhotos(rows);
  check("summary for completed org2 job (all 12)", st.counts.pre_arrival === 4 && st.counts.service === 4 && st.counts.final === 4, JSON.stringify(st.counts));
}

/* ============ 8) INCIDENT REGRESSION: synthetic photo persists in B2 +
 *      job_photos and is retrievable on the CORRECT PO (owner-display path,
 *      incident report 2026-08-13: "photos are not saving to POs") ============ */
{
  const c = CONF[ORG]; // tb-441001 call 441001 arrived (org already has its 4 pre-arrival photos from block 3)
  const { fetchImpl } = makeFetch({ callId: c.call });
  const user = userFor(ORG);
  const owner = { orgId: ORG, id: OWNER, role: "owner", towbookDriverId: "0" };
  // Base64-safe marker: photoDataUrl embeds marker.repeat(1500) raw as the
  // base64 payload, and upload validation decodes it (dashes would fail the
  // [A-Za-z0-9+/=] regex in decodeDataUrl — the earlier 'PHOTO-PO-ROUNDTRIP'
  // variant is why the committed run failed, not the production path).
  const marker = "PHOTOPOROUNDTRIP";
  // Block 3's retake reset the match flag — re-confirm so the service slot opens.
  await setVehicleMatchCore(user, { jobId: c.call, confirmed: true }, { fetchImpl });
  const sent = photoDataUrl(marker);
  const up = await uploadJobPhotoCore(user, { jobId: c.call, phase: "service", side: "front", dataUrl: sent }, { fetchImpl });
  check("regression: synthetic photo persists (B2 + job_photos row)", up.ok === true && up.storageKey === `ld-photos/${ORG}/${c.job}/service/front.jpg`, JSON.stringify(up));
  // Owner-display round-trip: getJobPhotoCore must return the EXACT SAME bytes
  // (data URL byte-equality) for the job — both via the LD id and via the
  // Towbook call id (PO linkage) — proving the photo is retrievable on the
  // correct PO, not orphaned on another row.
  for (const [label, jobId] of [["LD id", c.job], ["Towbook call id (PO)", c.call]]) {
    const got = await getJobPhotoCore(owner, { jobId, phase: "service", side: "front" }, { fetchImpl });
    check(`regression: photo retrievable via ${label} (exact bytes)`, got.ok === true && got.dataUrl === sent, JSON.stringify(got).slice(0, 120));
  }
  // Wrong-PO isolation: the same photo must NOT be retrievable on a different job.
  const wrong = await getJobPhotoCore(owner, { jobId: "tb-999999", phase: "service", side: "front" }, { fetchImpl });
  check("regression: photo not retrievable on a different PO", wrong.ok === false && wrong.code === "not_found", JSON.stringify(wrong));
  // Completion still pushes to the correct call's PO (block 3 verified the full
  // 12-photo set for this org — this block only re-proves the linkage contract).
  const rows = await jobPhotoRows(ORG, c.job);
  const st = summarizePhotos(rows);
  check("regression: pre-arrival + this service photo present on the PO job", st.counts.pre_arrival === 4 && st.counts.service === 1, JSON.stringify(st.counts));
}

/* ============ 9) T1 (SUB A): service/final photos capture while en_route ============ */
{
  const c = CONF[ORG];
  // Reset the job to en_route (it auto-arrived earlier) and clear photos so the
  // capture gates are exercised from a pre-arrival, not-yet-arrived state.
  await q`UPDATE dispatch_jobs SET status='en_route', arrived_at=NULL WHERE id=${c.job}`;
  await q`DELETE FROM job_photos WHERE org_id=${ORG} AND job_id=${c.job}`;
  const { fetchImpl } = makeFetch({ callId: c.call });
  const user = userFor(ORG);
  // Pre-arrival still accepted while en_route.
  for (let i = 0; i < SIDES.length; i++) {
    const r = await uploadJobPhotoCore(user, { jobId: c.call, phase: "pre_arrival", side: SIDES[i], dataUrl: photoDataUrl(String.fromCharCode(65 + i)) }, { fetchImpl });
    check(`T1: pre-arrival ${SIDES[i]} ok while en_route`, r.ok === true, JSON.stringify(r));
  }
  // Service photo accepted while en_route (pre-arrival complete, status NOT arrived).
  const svc = await uploadJobPhotoCore(user, { jobId: c.call, phase: "service", side: "front", dataUrl: photoDataUrl("W") }, { fetchImpl });
  check("T1: service upload accepted while en_route (status gate relaxed)", svc.ok === true && svc.phase === "service", JSON.stringify(svc));
  // Final photo accepted while en_route once all 4 service photos are present.
  for (let i = 0; i < SIDES.length; i++) {
    await uploadJobPhotoCore(user, { jobId: c.call, phase: "service", side: SIDES[i], dataUrl: photoDataUrl(String.fromCharCode(86 + i)) }, { fetchImpl });
  }
  const fin = await uploadJobPhotoCore(user, { jobId: c.call, phase: "final", side: "front", dataUrl: photoDataUrl("Y") }, { fetchImpl });
  check("T1: final upload accepted while en_route (status gate relaxed)", fin.ok === true && fin.phase === "final", JSON.stringify(fin));
}
} catch (e) { runError = e instanceof Error ? e : new Error(String(e)); }
/* ================================ summary + cleanup ================================ */
const failed = checks.filter(([, ok]) => !ok);
console.log(`driver-photos.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (runError) console.error(`driver-photos.test.mjs: ABORTED (${runError.name}): ${runError.message}`);
// Prove cleanup explicitly in FK-safe order. Do not swallow FK errors: a green
// suite must prove that every QA row was actually deleted.
const qaUsers = [OWNER, OWNER2, OWNER3, OWNER4, DRIVER, DRIVER2, DRIVER3, DRIVER4, OTHER];
const del = async (label, result) => {
  const rows = await result;
  if (!Array.isArray(rows)) throw new Error(`cleanup ${label}: delete did not return rows`);
  return rows.length;
};
// Every FK to users must be cleared before deleting a fixture user. Keep this
// exhaustive list in sync with the information_schema FK scan (the query used
// during the B6 gate); both directions are intentionally covered.
const deleteUserChildren = async (u) => {
  await del("academy_progress.user_id", q`DELETE FROM academy_progress WHERE user_id=${u} RETURNING *`);
  await del("audit_log.actor_user_id", q`DELETE FROM audit_log WHERE actor_user_id=${u} RETURNING *`);
  await del("battery_install_photo_overrides.actor_user_id", q`DELETE FROM battery_install_photo_overrides WHERE actor_user_id=${u} RETURNING *`);
  await del("battery_install_photos.uploaded_by", q`DELETE FROM battery_install_photos WHERE uploaded_by=${u} RETURNING *`);
  await del("battery_inventory_ledger.actor_user_id", q`DELETE FROM battery_inventory_ledger WHERE actor_user_id=${u} RETURNING *`);
  await del("battery_sales.battery_photo_override_by", q`DELETE FROM battery_sales WHERE battery_photo_override_by=${u} RETURNING *`);
  await del("battery_sales.contractor_user_id", q`DELETE FROM battery_sales WHERE contractor_user_id=${u} RETURNING *`);
  await del("battery_warranties.voided_by", q`DELETE FROM battery_warranties WHERE voided_by=${u} RETURNING *`);
  await del("contractor_doc_selfies.contractor_id", q`DELETE FROM contractor_doc_selfies WHERE contractor_id=${u} RETURNING *`);
  await del("contractor_doc_selfies.uploaded_by_user_id", q`DELETE FROM contractor_doc_selfies WHERE uploaded_by_user_id=${u} RETURNING *`);
  await del("contractor_documents.contractor_id", q`DELETE FROM contractor_documents WHERE contractor_id=${u} RETURNING *`);
  await del("contractor_documents.uploaded_by_user_id", q`DELETE FROM contractor_documents WHERE uploaded_by_user_id=${u} RETURNING *`);
  await del("contractor_form_docs.contractor_id", q`DELETE FROM contractor_form_docs WHERE contractor_id=${u} RETURNING *`);
  await del("contractor_form_submissions.contractor_id", q`DELETE FROM contractor_form_submissions WHERE contractor_id=${u} RETURNING *`);
  await del("contractor_form_submissions.section2_approved_by", q`DELETE FROM contractor_form_submissions WHERE section2_approved_by=${u} RETURNING *`);
  await del("contractor_profiles.user_id", q`DELETE FROM contractor_profiles WHERE user_id=${u} RETURNING *`);
  await del("contractor_schedules.updated_by_user_id", q`DELETE FROM contractor_schedules WHERE updated_by_user_id=${u} RETURNING *`);
  await del("contractor_schedules.user_id", q`DELETE FROM contractor_schedules WHERE user_id=${u} RETURNING *`);
  await del("driver_availability_log.user_id", q`DELETE FROM driver_availability_log WHERE user_id=${u} RETURNING *`);
  await del("driver_locations.driver_id", q`DELETE FROM driver_locations WHERE driver_id=${u} RETURNING *`);
  await del("job_photos.uploaded_by_user_id", q`DELETE FROM job_photos WHERE uploaded_by_user_id=${u} RETURNING *`);
  await del("organization_memberships.user_id", q`DELETE FROM organization_memberships WHERE user_id=${u} RETURNING *`);
  await del("payout_methods.contractor_id", q`DELETE FROM payout_methods WHERE contractor_id=${u} RETURNING *`);
  await del("payout_records.contractor_id", q`DELETE FROM payout_records WHERE contractor_id=${u} RETURNING *`);
  await del("payout_records.paid_by_user_id", q`DELETE FROM payout_records WHERE paid_by_user_id=${u} RETURNING *`);
  await del("push_subscriptions.user_id", q`DELETE FROM push_subscriptions WHERE user_id=${u} RETURNING *`);
  await del("sessions.user_id", q`DELETE FROM sessions WHERE user_id=${u} RETURNING *`);
  await del("status_events.actor_user_id", q`DELETE FROM status_events WHERE actor_user_id=${u} RETURNING *`);
  await del("tip_cashouts.contractor_id", q`DELETE FROM tip_cashouts WHERE contractor_id=${u} RETURNING *`);
  await del("tip_cashouts.paid_by_user_id", q`DELETE FROM tip_cashouts WHERE paid_by_user_id=${u} RETURNING *`);
  await del("tire_plug_transactions.contractor_user_id", q`DELETE FROM tire_plug_transactions WHERE contractor_user_id=${u} RETURNING *`);
  await del("users linked drivers", q`UPDATE users SET linked_driver_user_id=NULL WHERE linked_driver_user_id=${u} RETURNING *`);
};
// Include failed-run fixtures, but never broaden beyond the qa-cf-* namespace.
const qaOrgs = (await q`SELECT id FROM organizations WHERE id LIKE 'qa-photos%'`).map(({ id }) => id);
const qaUserRows = await q`SELECT id FROM users WHERE id LIKE 'qa-photos%'`;
const allQaUsers = [...new Set([...qaUsers, ...qaUserRows.map(({ id }) => id)])];
for (const org of qaOrgs) assertQaOrg(org);
// Every organization FK child, ordered deepest-first. This is intentionally
// exhaustive against the information_schema FK scan so new fixture data cannot
// survive cleanup unnoticed. Keep this list in sync when adding org FKs.
const orgDeletes = [
  ["battery_inventory_ledger", "org_id"],
  ["battery_install_photo_overrides", "org_id"],
  ["battery_install_photos", "org_id"],
  ["battery_sales", "org_id"],
  ["battery_warranties", "org_id"],
  ["battery_inventory", "org_id"],
  ["battery_products", "org_id"],
  ["battery_install_types", "org_id"],
  ["battery_compatibility", "org_id"],
  ["payout_records", "org_id"],
  ["pay_periods", "org_id"],
  ["completion_tips", "org_id"],
  ["job_completions", "org_id"],
  ["job_photos", "org_id"],
  ["status_events", "org_id"],
  ["audit_log", "org_id"],
  ["dispatch_jobs", "org_id"],
  ["ai_dispatcher_runs", "org_id"],
  ["contractor_doc_selfies", "org_id"],
  ["contractor_documents", "org_id"],
  ["contractor_form_docs", "org_id"],
  ["contractor_form_submissions", "org_id"],
  ["contractor_profiles", "org_id"],
  ["contractor_schedules", "org_id"],
  ["damage_claims", "org_id"],
  ["dispatch_contractors", "org_id"],
  ["dispatch_zones", "org_id"],
  ["driver_availability_log", "org_id"],
  ["driver_issues", "org_id"],
  ["driver_locations", "org_id"],
  ["driver_region_preferences", "org_id"],
  ["job_feedback", "org_id"],
  ["motor_club_cards", "org_id"],
  ["org_settings", "org_id"],
  ["organization_memberships", "org_id"],
  ["outbound_write_ledger", "org_id"],
  ["owner_notifications", "org_id"],
  ["payment_transactions", "org_id"],
  ["payout_methods", "org_id"],
  ["push_subscriptions", "org_id"],
  ["service_time_goals", "org_id"],
  ["sessions", "active_org_id"],
  ["tip_cashouts", "org_id"],
  ["tire_plug_transactions", "org_id"],
  ["towbook_report_snapshots", "org_id"],
  ["towbook_sessions", "org_id"],
];
for (const org of qaOrgs) {
  for (const [table, column] of orgDeletes) {
    await del(`${table}.${column}`, q.query(`DELETE FROM ${table} WHERE ${column} = $1 RETURNING *`, [org]));
  }
}
for (const u of allQaUsers) await deleteUserChildren(u);
for (const u of allQaUsers) await del("users", q`DELETE FROM users WHERE id=${u} RETURNING *`);
for (const org of qaOrgs) { assertQaOrg(org); await del("organizations", q`DELETE FROM organizations WHERE id=${org} RETURNING id`); }
const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM completion_tips WHERE org_id LIKE 'qa-photos%') AS tips,
  (SELECT COUNT(*)::int FROM job_completions WHERE org_id LIKE 'qa-photos%') AS completions,
  (SELECT COUNT(*)::int FROM job_photos WHERE org_id LIKE 'qa-photos%') AS photos,
  (SELECT COUNT(*)::int FROM dispatch_jobs WHERE org_id LIKE 'qa-photos%') AS jobs,
  (SELECT COUNT(*)::int FROM status_events WHERE org_id LIKE 'qa-photos%') AS events,
  (SELECT COUNT(*)::int FROM audit_log WHERE org_id LIKE 'qa-photos%') AS audit,
  (SELECT COUNT(*)::int FROM towbook_sessions WHERE org_id LIKE 'qa-photos%') AS sessions,
  (SELECT COUNT(*)::int FROM org_settings WHERE org_id LIKE 'qa-photos%') AS settings,
  (SELECT COUNT(*)::int FROM organization_memberships WHERE org_id LIKE 'qa-photos%') AS members,
  (SELECT COUNT(*)::int FROM ai_dispatcher_runs WHERE org_id LIKE 'qa-photos%') AS ai_runs,
  (SELECT COUNT(*)::int FROM battery_compatibility WHERE org_id LIKE 'qa-photos%') AS battery_compatibility,
  (SELECT COUNT(*)::int FROM battery_install_photo_overrides WHERE org_id LIKE 'qa-photos%') AS battery_install_photo_overrides,
  (SELECT COUNT(*)::int FROM battery_install_photos WHERE org_id LIKE 'qa-photos%') AS battery_install_photos,
  (SELECT COUNT(*)::int FROM battery_install_types WHERE org_id LIKE 'qa-photos%') AS battery_install_types,
  (SELECT COUNT(*)::int FROM battery_inventory WHERE org_id LIKE 'qa-photos%') AS battery_inventory,
  (SELECT COUNT(*)::int FROM battery_inventory_ledger WHERE org_id LIKE 'qa-photos%') AS battery_inventory_ledger,
  (SELECT COUNT(*)::int FROM battery_products WHERE org_id LIKE 'qa-photos%') AS battery_products,
  (SELECT COUNT(*)::int FROM battery_sales WHERE org_id LIKE 'qa-photos%') AS battery_sales,
  (SELECT COUNT(*)::int FROM battery_warranties WHERE org_id LIKE 'qa-photos%') AS battery_warranties,
  (SELECT COUNT(*)::int FROM contractor_doc_selfies WHERE org_id LIKE 'qa-photos%') AS contractor_doc_selfies,
  (SELECT COUNT(*)::int FROM contractor_doc_types WHERE org_id LIKE 'qa-photos%') AS contractor_doc_types,
  (SELECT COUNT(*)::int FROM contractor_documents WHERE org_id LIKE 'qa-photos%') AS contractor_documents,
  (SELECT COUNT(*)::int FROM contractor_form_docs WHERE org_id LIKE 'qa-photos%') AS contractor_form_docs,
  (SELECT COUNT(*)::int FROM contractor_form_submissions WHERE org_id LIKE 'qa-photos%') AS contractor_form_submissions,
  (SELECT COUNT(*)::int FROM contractor_profiles WHERE org_id LIKE 'qa-photos%') AS contractor_profiles,
  (SELECT COUNT(*)::int FROM contractor_schedules WHERE org_id LIKE 'qa-photos%') AS contractor_schedules,
  (SELECT COUNT(*)::int FROM damage_claims WHERE org_id LIKE 'qa-photos%') AS damage_claims,
  (SELECT COUNT(*)::int FROM dispatch_contractors WHERE org_id LIKE 'qa-photos%') AS dispatch_contractors,
  (SELECT COUNT(*)::int FROM dispatch_zones WHERE org_id LIKE 'qa-photos%') AS dispatch_zones,
  (SELECT COUNT(*)::int FROM driver_availability_log WHERE org_id LIKE 'qa-photos%') AS driver_availability_log,
  (SELECT COUNT(*)::int FROM driver_issues WHERE org_id LIKE 'qa-photos%') AS driver_issues,
  (SELECT COUNT(*)::int FROM driver_locations WHERE org_id LIKE 'qa-photos%') AS driver_locations,
  (SELECT COUNT(*)::int FROM driver_region_preferences WHERE org_id LIKE 'qa-photos%') AS driver_region_preferences,
  (SELECT COUNT(*)::int FROM job_feedback WHERE org_id LIKE 'qa-photos%') AS job_feedback,
  (SELECT COUNT(*)::int FROM motor_club_cards WHERE org_id LIKE 'qa-photos%') AS motor_club_cards,
  (SELECT COUNT(*)::int FROM outbound_write_ledger WHERE org_id LIKE 'qa-photos%') AS outbound_write_ledger,
  (SELECT COUNT(*)::int FROM owner_notifications WHERE org_id LIKE 'qa-photos%') AS owner_notifications,
  (SELECT COUNT(*)::int FROM pay_periods WHERE org_id LIKE 'qa-photos%') AS pay_periods,
  (SELECT COUNT(*)::int FROM payment_transactions WHERE org_id LIKE 'qa-photos%') AS payment_transactions,
  (SELECT COUNT(*)::int FROM payout_methods WHERE org_id LIKE 'qa-photos%') AS payout_methods,
  (SELECT COUNT(*)::int FROM payout_records WHERE org_id LIKE 'qa-photos%') AS payout_records,
  (SELECT COUNT(*)::int FROM push_subscriptions WHERE org_id LIKE 'qa-photos%') AS push_subscriptions,
  (SELECT COUNT(*)::int FROM service_time_goals WHERE org_id LIKE 'qa-photos%') AS service_time_goals,
  (SELECT COUNT(*)::int FROM sessions WHERE active_org_id LIKE 'qa-photos%') AS active_sessions,
  (SELECT COUNT(*)::int FROM tip_cashouts WHERE org_id LIKE 'qa-photos%') AS tip_cashouts,
  (SELECT COUNT(*)::int FROM tire_plug_transactions WHERE org_id LIKE 'qa-photos%') AS tire_plug_transactions,
  (SELECT COUNT(*)::int FROM towbook_report_snapshots WHERE org_id LIKE 'qa-photos%') AS towbook_report_snapshots,
  (SELECT COUNT(*)::int FROM users WHERE id LIKE 'qa-photos%') AS users,
  (SELECT COUNT(*)::int FROM organizations WHERE id LIKE 'qa-photos%') AS orgs`;
const z = Object.values(leftover[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) { console.error("FAIL: QA cleanup left rows behind"); process.exit(1); }
console.log("driver-photos.test.mjs: cleanup verified — zero QA rows left");
if (runError) { console.error(runError.stack ?? String(runError)); process.exit(1); }
if (failed.length) process.exit(1);
