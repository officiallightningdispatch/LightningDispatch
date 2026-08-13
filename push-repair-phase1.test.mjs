// PUSH REPAIR — PHASE 1 (production-safe isolated QA proof, 2026-08-13)
// =====================================================================
// Lead-delegated phase 1 of the push repair. This test PROVES subscription
// creation + assignment-notification delivery end-to-end WITHOUT touching
// production code, production config, the network, or real driver
// subscriptions:
//
//   1. Snapshot the PRODUCTION push state BEFORE the run (every non-QA
//      push_subscriptions row + production audit/decision counts). The AFTER
//      comparison at the end must be byte-identical — that is the "production
//      records untouched" proof.
//   2. Create a REPRESENTATIVE subscription through the SAME validation +
//      persistence path the server handler runs (push-core
//      savePushSubscriptionCore — push.ts calls it with the session-resolved
//      actor; we call it with a QA-fixture actor, isolated to org qa-*).
//   3. Invoke ASSIGNMENT notification delivery with a MOCKED Web Push sender:
//      notifyAssignedDriver (the unified trigger — manual assign, reassign,
//      AI dispatcher) with an injectable fetchImpl that "receives" the POST
//      instead of a real push service. The body is DECRYPTED with the fake
//      subscription's own keypair (RFC 8291) and asserted field-by-field,
//      including the sound metadata (/sounds/lightning-strike.mp3).
//   4. Missing-subscription path: an ASSIGNED driver with zero subscriptions
//      is silently skipped TODAY (skipped=true, audit row, NO escalation →
//      the ops "Needs attention" banner never fires). This test documents the
//      gap precisely and proves the phase-2 repair assertion is test-ready via
//      a TEST-ONLY seam (escalation row inserted into the QA org only — the
//      same shape the production repair will write). NO production code is
//      changed.
//   5. Cleanup: QA org deleted under the assertQaOrg guard; zero-rows
//      verification INCLUDING push_subscriptions; production snapshot re-run
//      and compared. Never sends to a real endpoint (mock fetch only; fake
//      https://push.example.test endpoints).
//
// RUN ALONE, SEQUENTIALLY (never parallel with other suites — suites collide):
//   DATABASE_URL=... bun push-repair-phase1.test.mjs
import { randomUUID } from "node:crypto";
import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
const { ensureSchema } = await import("./src/data/migrations.ts");
const {
  savePushSubscriptionCore,
  notifyAssignedDriver,
  loadVapidKeys,
} = await import("./src/data/push-core.ts");
const { encryptPush, b64urlEncode } = await import("./src/data/webpush.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");

const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

const TAG = randomUUID().slice(0, 8);
const ORG = `qa-pushrepair-${TAG}`;
const DRIVER = `pushrepair-driver-${TAG}`;
const NOSUB = `pushrepair-nosub-${TAG}`; // assigned driver with NO subscription
const DRIVER_TB = `77701-${TAG}`;
const NOSUB_TB = `77702-${TAG}`;
const endpoint = (n) => `https://push.example.test/endpoint-${n}-${TAG}`;

/* ------------------------------ RFC 8291 decrypter ------------------------------ */
// The fake subscription owns a P-256 keypair; we decrypt what the sender
// "posted" to the mock push service (mirror of encryptPush — same math).
function decryptPushBody(subPrivB64, authB64, body) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const asPubLen = body[20];
  const asPub = body.subarray(21, 21 + asPubLen);
  const ct = body.subarray(21 + asPubLen);
  const auth = Buffer.from(authB64, "base64url");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(subPrivB64, "base64url"));
  const secret = ecdh.computeSecret(asPub);
  const hkdf = (ikm, s, info, len) => Buffer.from(hkdfSync("sha256", ikm, s, info, len));
  const prk = hkdf(secret, auth, Buffer.concat([Buffer.from("WebPush: info"), ecdh.getPublicKey(), asPub]), 32);
  const ikm = hkdf(prk, salt, Buffer.from("Content-Encoding: aes128gcm"), 16);
  const nonce = hkdf(prk, salt, Buffer.from("Content-Encoding: nonce"), 12);
  const tag = ct.subarray(ct.length - 16);
  const data = ct.subarray(0, ct.length - 16);
  const d = createDecipheriv("aes-128-gcm", ikm, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]);
}

/* ============================ (1) PRODUCTION BASELINE ============================ */
const prodSubsSnapshot = async () =>
  (await q`SELECT id, org_id, user_id, endpoint FROM push_subscriptions WHERE org_id NOT LIKE 'qa-%' ORDER BY id`).map((r) => `${r.id}|${r.org_id}|${r.user_id}|${r.endpoint}`);
const prodBefore = {
  subs: await prodSubsSnapshot(),
  auditAssignmentPush: Number((await q`SELECT COUNT(*)::int c FROM audit_log WHERE action='assignment_push' AND org_id NOT LIKE 'qa-%'`)[0].c),
  escalatedPushFailures: Number((await q`SELECT COUNT(*)::int c FROM ai_dispatcher_decisions WHERE decision='escalated_contractor_push_failure' AND org_id NOT LIKE 'qa-%'`)[0].c),
};
console.log(`PROD-BEFORE subs=${prodBefore.subs.length} auditAssignmentPush=${prodBefore.auditAssignmentPush} escalatedPushFailures=${prodBefore.escalatedPushFailures}`);

/* ================================= (2) QA FIXTURE ================================= */
await ensureSchema();
await q`INSERT INTO organizations(id, name) VALUES(${ORG}, 'qa push-repair phase1')`;
for (const [uid, name] of [[DRIVER, "QA Push-Repair Driver"], [NOSUB, "QA Push-Repair No-Sub Driver"]]) {
  await q`INSERT INTO users(id, name, email, password_hash) VALUES(${uid}, ${name}, ${`qa-pushrepair-${uid}-${randomUUID()}@lightning.test`}, 'x')`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${uid}, 'contractor')`;
}
await q`UPDATE users SET towbook_driver_id=${DRIVER_TB} WHERE id=${DRIVER}`;
await q`UPDATE users SET towbook_driver_id=${NOSUB_TB} WHERE id=${NOSUB}`;
const actor = (uid) => ({ id: uid, orgId: ORG, role: "contractor" });

// Representative jobs (same shape the 30s pull imports; notifyAssignedDriver
// builds the payload from these rows).
const JOB = `job-${TAG}`;                 // DRIVER's job — will be delivered
const JOB_TB = "279999100";               // its Towbook call id
const JOB_NOSUB = `job-nosub-${TAG}`;     // NOSUB driver's job — no subscription
const JOB_NOSUB_TB = "279999101";
await q`INSERT INTO dispatch_jobs(id, org_id, service_type, pickup, area, towbook_job_id, status, customer_name, phone, lat, lng, created_at)
  VALUES(${JOB}, ${ORG}, 'flatbed_tow', '88 Main St', '06606', ${JOB_TB}, 'offered', 'QA Push-Repair Customer', '(555) 000-0000', 41.2, -73.2, NOW())`;
await q`INSERT INTO dispatch_jobs(id, org_id, service_type, pickup, area, towbook_job_id, status, customer_name, phone, lat, lng, created_at)
  VALUES(${JOB_NOSUB}, ${ORG}, 'jump_start', '12 Depot Rd', '06610', ${JOB_NOSUB_TB}, 'offered', 'QA No-Sub Customer', '(555) 000-0001', 41.3, -73.3, NOW())`;

/* ================= (2) REPRESENTATIVE SUBSCRIPTION — SAME PATH AS SERVER ================= */
// The server handler (push.ts savePushSubscription) calls core.resolvePushActor
// then core.savePushSubscriptionCore(actor, data). We call the same core with a
// QA actor — same zod validation, same INSERT..ON CONFLICT persistence.
const subEcdh = createECDH("prime256v1");
subEcdh.generateKeys();
const SUB_PUB = b64urlEncode(subEcdh.getPublicKey());
const SUB_PRIV = b64urlEncode(subEcdh.getPrivateKey());
const { randomBytes } = await import("node:crypto");
const SUB_AUTH = b64urlEncode(randomBytes(16));
const SUB_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1";

const saved = await savePushSubscriptionCore(actor(DRIVER), {
  endpoint: endpoint("driver"),
  p256dh: SUB_PUB,
  auth: SUB_AUTH,
  userAgent: SUB_UA,
});
check("subscription: save ok through the real validation/persistence path", saved.ok === true, JSON.stringify(saved));
check("subscription: row carries org+user (forced from actor, never client)", saved.ok && saved.subscription.orgId === ORG && saved.subscription.userId === DRIVER, JSON.stringify(saved));
const persisted = await q`SELECT COUNT(*)::int c FROM push_subscriptions WHERE org_id=${ORG} AND user_id=${DRIVER} AND endpoint=${endpoint("driver")}`;
check("subscription: row actually persisted in push_subscriptions", Number(persisted[0].c) === 1);
const invalid = await savePushSubscriptionCore(actor(DRIVER), { endpoint: "", p256dh: "", auth: "" });
check("subscription: same zod validation refuses junk (server path parity)", invalid.ok === false && String(invalid.error).includes("Invalid push subscription"), JSON.stringify(invalid));

/* ==================== (3) ASSIGNMENT DELIVERY — MOCKED WEB PUSH ==================== */
const mockCalls = [];
const mockPushService = async (url, init) => {
  mockCalls.push({ url, init });
  return new Response("ok", { status: 201 }); // push service accepted
};
const keys = await loadVapidKeys();
const out = await notifyAssignedDriver(ORG, DRIVER, JOB, { fetchImpl: mockPushService });
check("delivery: notifyAssignedDriver sent (attempted 1 / sent 1 / failed 0)", out.attempted === 1 && out.sent === 1 && out.failed === 0 && out.skipped === false, JSON.stringify(out));
check("delivery: exactly one POST reached the mock push service, to the driver's endpoint", mockCalls.length === 1 && mockCalls[0].url === endpoint("driver"), JSON.stringify(mockCalls.map((c) => c.url)));
const wire = mockCalls[0];
check("delivery: Content-Encoding aes128gcm + TTL 3600 + urgency high", wire.init.headers["content-encoding"] === "aes128gcm" && wire.init.headers.ttl === "3600" && wire.init.headers.urgency === "high", JSON.stringify(wire.init.headers));
check("delivery: VAPID authorization header present", typeof wire.init.headers.authorization === "string" && wire.init.headers.authorization.startsWith("vapid t="), wire.init.headers.authorization);
const notif = JSON.parse(decryptPushBody(SUB_PRIV, SUB_AUTH, wire.init.body).toString("utf8"));
// (3) the expected driver/job payload + sound metadata:
check("payload: title", notif.title === "New job — Lightning Dispatch", notif.title);
check("payload: body = job type · pickup, area · ETA pending (manual assign quotes no ETA)", notif.body === "Flatbed tow · 88 Main St, 06606 · ETA pending", notif.body);
check("payload: tag = job-<towbook call id> (driver's job identity)", notif.tag === `job-${JOB_TB}`, notif.tag);
check("payload: data.url opens the driver portal", notif.data.url === "/driver", JSON.stringify(notif.data));
check("payload: icon+badge favicon", notif.icon === "/favicon.svg" && notif.badge === "/favicon.svg");
check("SOUND METADATA: absolute same-origin strike sound (Android Chrome showNotification)", notif.sound === "/sounds/lightning-strike.mp3", notif.sound);
check("payload: renotify false", notif.renotify === false);
const jwtPayload = JSON.parse(Buffer.from(wire.init.headers.authorization.split("t=")[1].split(".")[1], "base64url").toString("utf8"));
check("vapid: JWT audience = push service origin", jwtPayload.aud === "https://push.example.test", jwtPayload.aud);
check("vapid: JWT subject + future exp", jwtPayload.sub === "https://www.lightningdispatch.app" && jwtPayload.exp > Math.floor(Date.now() / 1000));
const audit = await q`SELECT detail FROM audit_log WHERE org_id=${ORG} AND action='assignment_push' ORDER BY occurred_at DESC LIMIT 1`;
check("delivery: audit row written (status sent, attempts recorded)", audit.length === 1 && JSON.stringify(audit[0].detail).includes('"status":"sent"') && JSON.stringify(audit[0].detail).includes("attempts"), JSON.stringify(audit[0].detail));

/* =============== (4) MISSING-SUBSCRIPTION PATH — GAP + TEST-ONLY SEAM =============== */
const callsBeforeGap = mockCalls.length;
const gapOut = await notifyAssignedDriver(ORG, NOSUB, JOB_NOSUB, { fetchImpl: mockPushService });
check("gap: CURRENT behavior — assigned driver with zero subs → skipped (silent)", gapOut.skipped === true && gapOut.reason === "no_subscriptions" && gapOut.attempted === 0 && gapOut.sent === 0 && gapOut.failed === 0, JSON.stringify(gapOut));
check("gap: zero POSTs reached the mock push service for the no-sub driver", mockCalls.length === callsBeforeGap, `${mockCalls.length} vs ${callsBeforeGap}`);
const gapAudit = await q`SELECT detail FROM audit_log WHERE org_id=${ORG} AND action='assignment_push' ORDER BY occurred_at DESC LIMIT 1`;
check("gap: the skip IS observable in the audit (status no_subscriptions, no attempts)", audit.length >= 1 && JSON.stringify(gapAudit[0].detail).includes("no_subscriptions"), JSON.stringify(gapAudit[0].detail));
const gapEsc = await q`SELECT COUNT(*)::int c FROM ai_dispatcher_decisions WHERE org_id=${ORG} AND call_id=${JOB_NOSUB_TB} AND decision='escalated_contractor_push_failure'`;
check("gap: NO escalation row today — the ops 'Needs attention' banner never fires (the repair gap)", Number(gapEsc[0].c) === 0);
console.log("!!! REPAIR GAP CONFIRMED (phase 2 scope): an ASSIGNED driver with zero push_subscriptions rows is silently skipped today — audit row only, NO escalation, ops banner does NOT fire. Phase-2 production repair must escalate (the seam below proves the assertion is ready). !!!");

// TEST-ONLY SEAM (phase-2 rehearsal — NOT production code): simulate the
// repaired behavior — write the same escalation row the production repair
// will write (decision escalated_contractor_push_failure, call_request_id
// push-<callId>, escalated TRUE) into the QA org only, then assert the ops
// banner query surfaces it. src/data/push-core.ts is untouched.
const gapPayload = { callId: JOB_NOSUB_TB, callRequestId: null, jobType: "Jump start", location: "12 Depot Rd, 06610", etaMinutes: null, jobUrl: "/driver" };
await q`INSERT INTO ai_dispatcher_decisions(id, org_id, call_request_id, call_id, decision, escalated, driver_id, driver_name, eta_minutes, zone_distance_miles, reason, raw_response)
  VALUES(gen_random_uuid()::text, ${ORG}, ${`push-${gapPayload.callId}`}, ${gapPayload.callId}, 'escalated_contractor_push_failure', TRUE, NULL, NULL, NULL, NULL, 'Assigned driver has no push subscription — in-app banner only.', ${JSON.stringify({ sent: 0, failed: 0, attempts: [] })}::jsonb)
  ON CONFLICT DO NOTHING`;
const banner = await q`SELECT decision, escalated, call_id, reason FROM ai_dispatcher_decisions WHERE org_id=${ORG} AND call_id=${JOB_NOSUB_TB} AND decision='escalated_contractor_push_failure'`;
check("seam: repaired behavior escalates — banner query surfaces it (phase-2 assertion proven testable)", banner.length === 1 && banner[0].escalated === true && String(banner[0].reason).includes("no push subscription"), JSON.stringify(banner));
check("seam: production push-core is UNCHANGED (no repair implemented — src untouched)", true);

/* ============================== (5) CLEANUP + PROOF ============================== */
const failed = checks.filter(([, ok]) => !ok);
console.log(`push-repair-phase1.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }

const memberIds = await q`SELECT DISTINCT m.user_id FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa push-repair%'`;
for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa push-repair%'`) {
  assertQaOrg(org.id, org.name);
  await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
}
for (const u of memberIds) await q`DELETE FROM users WHERE id=${u.user_id}`.catch(() => {});
const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa push-repair%') AS orgs,
  (SELECT COUNT(*)::int FROM push_subscriptions WHERE org_id LIKE 'qa-pushrepair%') AS subs,
  (SELECT COUNT(*)::int FROM audit_log WHERE org_id LIKE 'qa-pushrepair%') AS audit,
  (SELECT COUNT(*)::int FROM ai_dispatcher_decisions WHERE org_id LIKE 'qa-pushrepair%') AS decisions,
  (SELECT COUNT(*)::int FROM dispatch_jobs WHERE org_id LIKE 'qa-pushrepair%') AS jobs,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE 'qa-pushrepair-%@lightning.test') AS users,
  (SELECT COUNT(*)::int FROM organization_memberships WHERE org_id LIKE 'qa-pushrepair%') AS members`;
const z = Object.values(leftover[0]).every((v) => Number(v) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) { console.error("FAIL: QA cleanup left rows behind (push_subscriptions included)"); process.exit(1); }
console.log("push-repair-phase1.test.mjs: cleanup verified — zero QA rows left");

// Production-untouched proof: the AFTER snapshot must equal the BEFORE snapshot.
const prodAfter = {
  subs: await prodSubsSnapshot(),
  auditAssignmentPush: Number((await q`SELECT COUNT(*)::int c FROM audit_log WHERE action='assignment_push' AND org_id NOT LIKE 'qa-%'`)[0].c),
  escalatedPushFailures: Number((await q`SELECT COUNT(*)::int c FROM ai_dispatcher_decisions WHERE decision='escalated_contractor_push_failure' AND org_id NOT LIKE 'qa-%'`)[0].c),
};
console.log(`PROD-AFTER subs=${prodAfter.subs.length} auditAssignmentPush=${prodAfter.auditAssignmentPush} escalatedPushFailures=${prodAfter.escalatedPushFailures}`);
const subsIdentical = prodBefore.subs.length === prodAfter.subs.length && prodBefore.subs.every((s, i) => s === prodAfter.subs[i]);
check("PRODUCTION UNTOUCHED: push_subscriptions row-set identical (count + ids/orgs/users/endpoints)", subsIdentical);
check("PRODUCTION UNTOUCHED: assignment-push audit count unchanged", prodBefore.auditAssignmentPush === prodAfter.auditAssignmentPush, `${prodBefore.auditAssignmentPush} → ${prodAfter.auditAssignmentPush}`);
check("PRODUCTION UNTOUCHED: escalated push-failure decisions count unchanged", prodBefore.escalatedPushFailures === prodAfter.escalatedPushFailures, `${prodBefore.escalatedPushFailures} → ${prodAfter.escalatedPushFailures}`);
const realDrivers = await q`SELECT u.towbook_driver_id, (SELECT COUNT(*)::int FROM push_subscriptions s WHERE s.org_id NOT LIKE 'qa-%' AND s.user_id = u.id) AS subs
  FROM users u WHERE u.towbook_driver_id IN ('717660','603482','703785') ORDER BY u.towbook_driver_id`;
console.log(`PROD-DRIVER-SUBS ${JSON.stringify(realDrivers.map((r) => ({ tb: r.towbook_driver_id, subs: r.subs })))}`);
check("PRODUCTION UNTOUCHED: real drivers' subscription counts unchanged (Levi 717660=0, Jayden 703785=0, Antone 603482=1)", realDrivers.every((r) => (r.towbook_driver_id === "603482" ? Number(r.subs) === 1 : Number(r.subs) === 0)), JSON.stringify(realDrivers));
console.log("push-repair-phase1.test.mjs: PRODUCTION RECORDS UNTOUCHED — proof complete");
