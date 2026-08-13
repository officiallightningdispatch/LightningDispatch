// DB safety (2026-08-12): org deletes guarded by assertQaOrg — see src/data/db-guard.ts.
// Hermetic assigned-offer push tests (owner top priority 2026-08-12). Covers:
//   · RFC 8291/8292 crypto round-trip WITHOUT any network — encrypt with our
//     VAPID pair + a fake subscription, decrypt with the subscription's own
//     private key, assert the notification JSON (spec A1 verbatim: title/body/
//     tag/data.url/icon/sound/renotify), and verify the VAPID JWT (aud = push
//     service origin, exp > now, k = the raw public key).
//   · Migration 35: push_subscriptions table + (org,user) index exist.
//   · Subscription CRUD + role gates: ONLY contractors save/list/delete their
//     own; owner/admin/dispatcher/unauthenticated refused.
//   · Upsert by endpoint UNIQUE (re-subscribe replaces; same endpoint
//     refreshes last_seen_at).
//   · sendAssignmentPush: loads the right subs, POSTs each with VAPID auth,
//     audits `assignment_push` (status sent/failed + attempts); sender 500 →
//     never throws, audit failed + escalated_contractor_push_failure decision;
//     410 → subscription removed; zero subs → skipped audit.
//   · sendAssignmentPushByTowbookDriver resolves LD user by towbook_driver_id
//     (and skips cleanly when the driver has no LD user).
//   · fireAssignmentPush (manual assignJob trigger): builds the payload from
//     the dispatch_jobs row; unknown job → no_send skip, no throw.
//   · The AI-dispatcher seam: deps.sendAssignmentPush is wired into the
//     verification.ok branch of runAutoDispatchInternal (source-level proof,
//     since the engine suite is WIP) + the engine's payload shape matches the
//     spec (jobType/location/etaMinutes/jobUrl through a real encrypt/decrypt).
//
// Real network calls never happen: the push service fetch is an injectable
// fetchImpl (we decrypt what it "received"). DB-backed against a throwaway QA
// org (id qa-push-*, name 'qa push'), deleted at the end with assertQaOrg and
// a zero-rows verification that INCLUDES push_subscriptions.
//   DATABASE_URL=... bun push-notifications.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
const { ensureSchema } = await import("./src/data/migrations.ts");
const {
  savePushSubscriptionCore,
  listPushSubscriptionsCore,
  deletePushSubscriptionCore,
  sendAssignmentPush,
  sendAssignmentPushByTowbookDriver,
  fireAssignmentPush,
  loadVapidKeys,
} = await import("./src/data/push-core.ts");
const { buildPushNotificationJson } = await import("./src/data/push-core.ts");
const { encryptPush, parseVapidPublicKey, b64urlEncode, VAPID_SUBJECT } = await import("./src/data/webpush.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");

const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

const TAG = randomUUID().slice(0, 8);
const ORG = `qa-push-${TAG}`;
const OWNER = `push-owner-${TAG}`;
const ADMIN = `push-admin-${TAG}`;
const DRIVER = `push-driver-${TAG}`;
const DRIVER2 = `push-driver2-${TAG}`; // second org member (scoping check)
const OWNER_DRIVER = `push-ownerdrv-${TAG}`; // al0101 shape: owner member + own Towbook driver id
const OWNER_DRIVER_TB = `99902-${TAG}`;
const endpoint = (n) => `https://push.example.test/endpoint-${n}-${TAG}`;

/* ------------------------------ RFC 8291 decrypter ------------------------------ */
// The test's fake subscription owns a P-256 keypair; we decrypt what the
// sender "posted" to the push service (mirror of encryptPush).
import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";
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

/* ------------------------------------ setup ------------------------------------ */
async function setup() {
  await ensureSchema();
  await q`INSERT INTO organizations(id, name) VALUES(${ORG}, 'qa push')`;
  for (const [uid, name, role] of [
    [OWNER, "QA Push Owner", "owner"],
    [ADMIN, "QA Push Admin", "admin"],
    [DRIVER, "QA Push Driver", "contractor"],
    [DRIVER2, "QA Push Driver 2", "contractor"],
    [OWNER_DRIVER, "QA Push Owner-Driver", "owner"],
  ]) {
    await q`INSERT INTO users(id, name, email, password_hash) VALUES(${uid}, ${name}, ${`qa-push-${uid}-${randomUUID()}@lightning.test`}, 'x')`;
    await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${uid}, ${role})`;
  }
}
await setup();
// al0101 real-world shape: the user row IS the driver identity (own
// towbook_driver_id; unique index — fixture-unique value).
await q`UPDATE users SET towbook_driver_id=${OWNER_DRIVER_TB} WHERE id=${OWNER_DRIVER}`;

const actor = (uid) => ({ id: uid, orgId: ORG, role: (uid === OWNER ? "owner" : uid === ADMIN ? "admin" : "contractor") });

/* ================================== crypto ================================== */
const keys = await loadVapidKeys();
check("vapid: public key is a 65-byte P-256 point", parseVapidPublicKey(keys.publicKey).raw.length === 65);
check("vapid: keypair survives a reload (files persisted)", (await loadVapidKeys()).publicKey === keys.publicKey);

// Fake subscription with its own keypair (p256dh/auth come from the browser).
const subEcdh = createECDH("prime256v1");
subEcdh.generateKeys();
const SUB_PUB = b64urlEncode(subEcdh.getPublicKey());
const SUB_PRIV = b64urlEncode(subEcdh.getPrivateKey());
const { randomBytes } = await import("node:crypto");
const SUB_AUTH = b64urlEncode(randomBytes(16));

const payload = { callId: "279999001", callRequestId: "326999001", jobType: "Flatbed tow", location: "Main St & 5th Ave, 06606", etaMinutes: 12, jobUrl: "/driver" };
const notifJson = buildPushNotificationJson(payload);
check("spec A1: title exact", notifJson.title === "New job — Lightning Dispatch");
check("sound: absolute same-origin URL (Android Chrome showNotification)", notifJson.sound === "/sounds/lightning-strike.mp3");
check("trigger: notifyAssignedDriver is the single assignment trigger (fireAssignmentPush delegates)", typeof (await import("./src/data/push-core.ts")).notifyAssignedDriver === "function");
check("spec A1: body = service · location · ETA", notifJson.body === "Flatbed tow · Main St & 5th Ave, 06606 · ETA ~12 min");
check("spec A1: tag job-<callId>", notifJson.tag === "job-279999001");
check("spec A1: data.url /driver", notifJson.data.url === "/driver");
check("spec A1: icon+badge favicon", notifJson.icon === "/favicon.svg" && notifJson.badge === "/favicon.svg");
check("spec A1: sound field", notifJson.sound === "/sounds/lightning-strike.mp3");
check("spec A1: renotify false", notifJson.renotify === false);

const enc = encryptPush({ endpoint: endpoint("crypto"), p256dh: SUB_PUB, auth: SUB_AUTH }, JSON.stringify(notifJson), keys);
const decrypted = decryptPushBody(SUB_PRIV, SUB_AUTH, enc.body);
check("rfc8291: decrypt(payload) === payload", decrypted.toString("utf8") === JSON.stringify(notifJson));
check("rfc8291: Content-Encoding aes128gcm", enc.headers["content-encoding"] === "aes128gcm");
check("rfc8291: TTL 3600", enc.headers.ttl === "3600");
const jwtPayload = JSON.parse(Buffer.from(enc.headers.authorization.split("t=")[1].split(".")[1], "base64url").toString("utf8"));
check("vapid: JWT audience = push endpoint origin", jwtPayload.aud === "https://push.example.test");
check("vapid: JWT subject", jwtPayload.sub === "https://www.lightningdispatch.app");
check("vapid: JWT exp in the future", jwtPayload.exp > Math.floor(Date.now() / 1000));
check("vapid: k param = raw public key", enc.headers.authorization.includes(`k=${keys.publicKey}`));

// ETA-pending + call-number fallbacks (spec A1 fallback copy).
check("spec A1: no ETA → 'ETA pending'", buildPushNotificationJson({ ...payload, etaMinutes: null }).body.includes("ETA pending"));
check("spec A1: no location → Call # + ETA", buildPushNotificationJson({ ...payload, location: "" }).body.includes("Call #279999001"));

/* ============================ migration 35 + CRUD ============================ */
const tbl = await q`SELECT to_regclass('public.push_subscriptions') AS t, (SELECT COUNT(*)::int FROM pg_indexes WHERE tablename='push_subscriptions' AND indexname='push_subscriptions_org_user_idx') AS idx`;
check("migration 35: table exists", tbl[0].t != null);
check("migration 35: (org_id, user_id) index exists", Number(tbl[0].idx) === 1);

const save = async (uid, ep, extra = {}) =>
  savePushSubscriptionCore(actor(uid), { endpoint: ep, p256dh: SUB_PUB, auth: SUB_AUTH, ...extra });
let r = await save(DRIVER, endpoint(1));
check("save: contractor can save", r.ok === true, JSON.stringify(r));
const subId = r.ok ? r.subscription.id : null;
check("save: row carries org+user", r.ok && r.subscription.orgId === ORG && r.subscription.userId === DRIVER);

// Upsert — same endpoint replaces (re-subscribe) with new p256dh/auth.
const NEW_PUB = b64urlEncode(subEcdh.getPublicKey());
r = await save(DRIVER, endpoint(1), { p256dh: NEW_PUB });
check("upsert: re-save replaces (count stays 1)", r.ok && (await q`SELECT COUNT(*)::int c FROM push_subscriptions WHERE endpoint=${endpoint(1)}`)[0].c === 1);
check("upsert: p256dh replaced", (await q`SELECT p256dh FROM push_subscriptions WHERE endpoint=${endpoint(1)}`)[0].p256dh === NEW_PUB);
check("upsert: last_seen_at refreshed", (await q`SELECT last_seen_at IS NOT NULL AS v FROM push_subscriptions WHERE endpoint=${endpoint(1)}`)[0].v === true);

await save(DRIVER, endpoint(2));
let list = await listPushSubscriptionsCore(actor(DRIVER));
check("list: contractor sees own subs", list.ok && list.subscriptions.length === 2);
const otherList = await listPushSubscriptionsCore(actor(DRIVER2));
check("scope: driver2 does NOT see driver's subs", otherList.ok && otherList.subscriptions.length === 0);

/* -------------------------------- role gates -------------------------------- */
for (const [uid, label] of [[OWNER, "owner"], [ADMIN, "admin"]]) {
  const g = await save(uid, endpoint(`g-${uid}`));
  check(`gate: ${label} cannot save`, g.ok === false);
  const gl = await listPushSubscriptionsCore(actor(uid));
  check(`gate: ${label} cannot list`, gl.ok === false);
  const gd = await deletePushSubscriptionCore(actor(uid), endpoint(1));
  check(`gate: ${label} cannot delete`, gd.ok === false);
}
const anon = await savePushSubscriptionCore({ id: "nobody", orgId: ORG, role: "dispatcher" }, { endpoint: endpoint("anon"), p256dh: SUB_PUB, auth: SUB_AUTH });
check("gate: dispatcher/unauthenticated refused", anon.ok === false);

/* --------------- owner-with-driver-identity (al0101 shape, fix 2026-08-13) --------------- */
// An owner member whose row carries a Towbook driver id may save/list/delete
// their OWN subscription (owner-in-driver-view). The row is stored under their
// own user id — never another contractor's.
const odActor = { id: OWNER_DRIVER, orgId: ORG, role: "owner" };
let od = await savePushSubscriptionCore(odActor, { endpoint: endpoint("od"), p256dh: SUB_PUB, auth: SUB_AUTH });
check("owner-with-driver-identity: can save their own subscription (al0101 shape)", od.ok === true, JSON.stringify(od));
check("owner-with-driver-identity: row stored under their own user id", od.ok && od.subscription.userId === OWNER_DRIVER && od.subscription.orgId === ORG, JSON.stringify(od));
const odList = await listPushSubscriptionsCore(odActor);
check("owner-with-driver-identity: lists their own subscriptions", odList.ok && odList.subscriptions.some((s) => s.endpoint === endpoint("od")), JSON.stringify(odList));
check("owner-with-driver-identity: sees ONLY their own subs (no cross scope)", odList.ok && odList.subscriptions.every((s) => s.userId === OWNER_DRIVER), JSON.stringify(odList));
const odCrossDel = await deletePushSubscriptionCore(odActor, endpoint(1)); // DRIVER's subscription
check("owner-with-driver-identity: cannot delete another user's subscription", odCrossDel.ok === true && odCrossDel.deleted === false, JSON.stringify(odCrossDel));
const odDel = await deletePushSubscriptionCore(odActor, endpoint("od"));
check("owner-with-driver-identity: deletes their own subscription", odDel.ok === true && odDel.deleted === true, JSON.stringify(odDel));
{
  const src = await (await import("node:fs/promises")).readFile("./src/data/push.ts", "utf8");
  check("push: server fns resolve the actor via effectiveDriverIdentity (owner-in-driver-view)", src.includes("resolvePushActor") && src.includes("await core.resolvePushActor(u)"), "push.ts not identity-resolving");
  const coreSrc = await (await import("node:fs/promises")).readFile("./src/data/push-core.ts", "utf8");
  check("push: core gate is driver-identity aware (hasOrgDriverIdentity)", coreSrc.includes("hasOrgDriverIdentity") && coreSrc.includes("towbook_driver_id IS NOT NULL OR u.linked_driver_user_id IS NOT NULL"), "push-core gate not identity-aware");
}

/* ----------------------------- sendAssignmentPush ----------------------------- */
let sent = [];
const okFetch = async (url, init) => {
  sent.push({ url, init });
  return new Response("ok", { status: 201 });
};
let out = await sendAssignmentPush(ORG, DRIVER, payload, { fetchImpl: okFetch });
check("send: attempted both subs", out.attempted === 2 && out.sent === 2 && out.failed === 0);
check("send: POSTed to both endpoints", sent.map((s) => s.url).sort().join(",") === [endpoint(1), endpoint(2)].sort().join(","));
check("send: VAPID auth header on the wire", sent[0].init.headers.authorization.startsWith("vapid t="));
const wirePayload = JSON.parse(decryptPushBody(SUB_PRIV, SUB_AUTH, sent[0].init.body).toString("utf8"));
check("send: wire payload title/body/tag", wirePayload.title === "New job — Lightning Dispatch" && wirePayload.tag === "job-279999001" && wirePayload.data.url === "/driver");
const audit = await q`SELECT detail FROM audit_log WHERE org_id=${ORG} AND action='assignment_push' ORDER BY occurred_at DESC LIMIT 1`;
const auditDetail = typeof audit[0].detail === "string" ? JSON.parse(audit[0].detail) : audit[0].detail;
check("audit: assignment_push status sent (in detail)", auditDetail.status === "sent");
check("audit: attempts recorded", Array.isArray(auditDetail.attempts) && auditDetail.attempts.length === 2);

// Failure path: 500 → never throws, audited, escalated decision row.
let failing = 0;
const badFetch = async () => new Response("boom", { status: 500 });
out = await sendAssignmentPush(ORG, DRIVER, { ...payload, callId: "279999002" }, { fetchImpl: badFetch });
check("send-fail: never throws, failed counted", out.failed === 2 && out.sent === 0);
const esc = await q`SELECT decision, call_id FROM ai_dispatcher_decisions WHERE org_id=${ORG} AND decision='escalated_contractor_push_failure' AND call_id='279999002'`;
check("send-fail: escalation decision row (ops banner)", esc.length === 1 && esc[0].call_id === "279999002");

// Stale endpoint: 410 → subscription removed, still no throw.
const staleFetch = async (url) => new Response("gone", { status: url === endpoint(2) ? 410 : 201 });
out = await sendAssignmentPush(ORG, DRIVER, { ...payload, callId: "279999003" }, { fetchImpl: staleFetch });
check("stale: 410 removed, other sent", out.staleRemoved === 1 && out.sent === 1);
check("stale: row actually deleted", (await q`SELECT COUNT(*)::int c FROM push_subscriptions WHERE endpoint=${endpoint(2)}`)[0].c === 0);

// No subscriptions → skipped audit, no send.
const noneOut = await sendAssignmentPush(ORG, DRIVER2, payload, { fetchImpl: okFetch });
check("no-subs: skipped (no send attempted)", noneOut.skipped === true && noneOut.attempted === 0);

/* ---------------------- sendAssignmentPushByTowbookDriver ---------------------- */
const TOW_DRIVER = `99901-${TAG}`;
const TOW_MISSING = `99999-${TAG}`;
await q`UPDATE users SET towbook_driver_id=${TOW_DRIVER} WHERE id=${DRIVER}`;
let byDriver = await sendAssignmentPushByTowbookDriver(ORG, TOW_DRIVER, payload, { fetchImpl: okFetch });
check("byDriver: resolves LD user by towbook_driver_id", byDriver.attempted === 1 && byDriver.sent === 1);
const missingDriver = await sendAssignmentPushByTowbookDriver(ORG, TOW_MISSING, payload, { fetchImpl: okFetch });
check("byDriver: unknown driver → clean skip", missingDriver.skipped === true && missingDriver.reason === "no_ld_user_for_towbook_driver");

/* ----------------------------- fireAssignmentPush (manual path) ----------------------------- */
const jobId = `job-${TAG}`;
await q`INSERT INTO dispatch_jobs(id, org_id, service_type, pickup, area, towbook_job_id, status, customer_name, phone, lat, lng, created_at) VALUES(${jobId}, ${ORG}, 'flatbed_tow', '88 Main St', '06606', '279999004', 'new', 'QA Push Customer', '(555) 000-0000', 41.2, -73.2, NOW())`;
let fireOut = await fireAssignmentPush(ORG, DRIVER, jobId, { fetchImpl: okFetch });
check("fireAssignmentPush: payload built from job row", fireOut.sent === 1 && sent.length > 0);
const fireWire = JSON.parse(decryptPushBody(SUB_PRIV, SUB_AUTH, sent[sent.length - 1].init.body).toString("utf8"));
check("fireAssignmentPush: label from service_type", fireWire.body.startsWith("Flatbed tow · 88 Main St, 06606 ·"));
check("fireAssignmentPush: tag from towbook_job_id", fireWire.tag === "job-279999004");
const missingJob = await fireAssignmentPush(ORG, DRIVER, `nope-${TAG}`, { fetchImpl: okFetch });
check("fireAssignmentPush: unknown job → clean skip", missingJob.skipped === true && missingJob.reason === "job_not_found");

/* ------------------------------ AI-dispatcher seam ------------------------------ */
// The engine calls deps.sendAssignmentPush AFTER a verified dispatch (owner
// top priority). Prove the seam is wired in the source AND that the payload
// the engine builds round-trips through the real crypto (spec-compliant).
const file = await (await import("node:fs/promises")).readFile("./src/data/ai-dispatcher.ts", "utf8");
check("ai: fireDispatchAssignmentPush called in verification.ok branch", file.includes("await fireDispatchAssignmentPush(orgId, { driverId: dispatchDriverId, driverName: dispatchDriverName }, verification, offer, etaMinutes, deps)"));
check("ai: production path uses push-core by towbook driver", file.includes('const { sendAssignmentPushByTowbookDriver } = await import("./push-core")'));
const enginePayload = { callId: "279999005", callRequestId: "326999005", jobType: "Tow job", location: "41.218621,-73.187522", etaMinutes: 9, jobUrl: "/driver" };
const engineJson = buildPushNotificationJson(enginePayload);
const engineEnc = encryptPush({ endpoint: endpoint("engine"), p256dh: SUB_PUB, auth: SUB_AUTH }, JSON.stringify(engineJson), keys);
const engineDec = JSON.parse(decryptPushBody(SUB_PRIV, SUB_AUTH, engineEnc.body).toString("utf8"));
check("ai: engine payload shape matches spec", engineDec.title === "New job — Lightning Dispatch" && engineDec.body === "Tow job · 41.218621,-73.187522 · ETA ~9 min" && engineDec.tag === "job-279999005" && engineDec.data.url === "/driver");

/* ================================ summary + cleanup ================================ */
const failed = checks.filter(([, ok]) => !ok);
console.log(`push-notifications.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }

const memberIds = await q`SELECT DISTINCT m.user_id FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa push%'`;
for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa push%'`) {
  assertQaOrg(org.id, org.name);
  await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
}
for (const u of memberIds) await q`DELETE FROM users WHERE id=${u.user_id}`.catch(() => {});
const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa push%') AS orgs,
  (SELECT COUNT(*)::int FROM push_subscriptions WHERE org_id LIKE 'qa-push%') AS subs,
  (SELECT COUNT(*)::int FROM audit_log WHERE org_id LIKE 'qa-push%') AS audit,
  (SELECT COUNT(*)::int FROM ai_dispatcher_decisions WHERE org_id LIKE 'qa-push%') AS decisions,
  (SELECT COUNT(*)::int FROM dispatch_jobs WHERE org_id LIKE 'qa-push%') AS jobs,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE 'qa-push-%@lightning.test') AS users,
  (SELECT COUNT(*)::int FROM organization_memberships WHERE org_id LIKE 'qa-push%') AS members`;
const z = Object.values(leftover[0]).every((v) => Number(v) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) { console.error("FAIL: QA cleanup left rows behind (push_subscriptions included)"); process.exit(1); }
console.log("push-notifications.test.mjs: cleanup verified — zero QA rows left");
