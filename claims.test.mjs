// DB safety (2026-08-12): org deletes guarded by assertQaOrg — see src/data/db-guard.ts.
// Hermetic tests for the damage-claims agent core (PHASE 1, owner-directed 2026-08-12):
//   detection (REAL evidence: Agero case emails classify; WeSalute "Claim Your
//   Gift" marketing rejects), resolved-research heuristics (thread signals),
//   the full lifecycle scan → research → prepare → driver sign → owner approve
//   → send (mocked SMTP transport; NOTHING sends without approval), the
//   phase-2 web_form guard (Sixt never emails), role gates (owner/admin for
//   approve/send; assigned driver only for sign), and zero QA rows after.
//   DATABASE_URL=... bun claims.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 9).toString("base64");
const SAVED_B2 = { k: process.env.B2_KEY_ID, a: process.env.B2_APPLICATION_KEY, b: process.env.B2_BUCKET_NAME };
process.env.B2_KEY_ID = "004qadockeyid";
process.env.B2_APPLICATION_KEY = "004qaappkey";
process.env.B2_BUCKET_NAME = "qa-bucket";
// Hermetic Gmail config too: scan/send resolve loadGmailConfig env-first, so
// the suite never reads the real .secrets files (connectImpl/sendImpl replace
// the actual IMAP/SMTP transport).
const SAVED_GMAIL = { a: process.env.GMAIL_ADDRESS, p: process.env.GMAIL_APP_PASSWORD };
process.env.GMAIL_ADDRESS = "qa-claims@qa.local";
process.env.GMAIL_APP_PASSWORD = "qa-gmail-app-password";
const {
  detectDamageClaimEmail, researchResolvedSignals, prepareClaimForm,
  scanClaimsCore, researchClaimCore, prepareClaimFormCore, signClaimCore,
  approveClaimCore, rejectClaimCore, sendClaimCore, listClaimsCore,
  listMyClaimSignRequestsCore, assignClaimDriverCore, buildClaimEmail,
} = await import("./src/data/claims-core.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
await ensureSchema();
const checks = [];
const check = (name, cond, extra = "") => { checks.push([name, Boolean(cond), extra]); if (!cond) throw new Error(`FAIL: ${name} ${extra}`); };
const ORG = `qa-claims-${randomUUID()}`;
const ORG2 = `qa-claims2-${randomUUID()}`;
const OWNER = `qa-cl-owner-${randomUUID()}`;
const ADMIN = `qa-cl-admin-${randomUUID()}`;
const DRIVER = `qa-cl-driver-${randomUUID()}`;
const OTHER = `qa-cl-other-${randomUUID()}`;
const OTHER2 = `qa-cl-owner2-${randomUUID()}`;
const driverId = (seed) => String(BigInt("0x" + seed.slice(-36).replace(/-/g, "").slice(0, 10)) % 1_000_000_000n);
const DRIVER_TB = driverId(DRIVER);
const OTHER_TB = driverId(OTHER);
const ACTOR = { orgId: ORG, id: OWNER, role: "owner" };
const ADMIN_ACTOR = { orgId: ORG, id: ADMIN, role: "admin" };
const DRIVER_ACTOR = { orgId: ORG, id: DRIVER, role: "contractor", driverUserRowId: DRIVER };
const OTHER_DRIVER_ACTOR = { orgId: ORG, id: OTHER, role: "contractor", driverUserRowId: OTHER };
const WRONG_ORG_ACTOR = { orgId: ORG2, id: OTHER2, role: "owner" };
const DISPATCHER = { orgId: ORG, id: `qa-cl-disp-${randomUUID()}`, role: "dispatcher" };
const JOB_ID = `qa-cl-job-${randomUUID()}`;

/* ---- cleanup (guarded, ALWAYS runs — even when a mid-suite check fails) ---- */
const cleanup = async () => {
  await q`DELETE FROM audit_log WHERE org_id IN (${ORG}, ${ORG2}) OR actor_user_id IN (${OWNER}, ${ADMIN}, ${DRIVER}, ${OTHER}, ${OTHER2})`;
  await q`DELETE FROM status_events WHERE org_id IN (${ORG}, ${ORG2})`;
  await q`DELETE FROM job_completions WHERE org_id IN (${ORG}, ${ORG2})`;
  await q`DELETE FROM completion_tips WHERE org_id IN (${ORG}, ${ORG2})`;
  await q`DELETE FROM damage_claims WHERE org_id IN (${ORG}, ${ORG2})`;
  await q`DELETE FROM dispatch_jobs WHERE org_id IN (${ORG}, ${ORG2})`;
  await q`DELETE FROM organization_memberships WHERE org_id IN (${ORG}, ${ORG2})`;
  await q`DELETE FROM users WHERE id IN (${OWNER}, ${ADMIN}, ${DRIVER}, ${OTHER}, ${OTHER2})`;
  assertQaOrg(ORG); assertQaOrg(ORG2);
  await q`DELETE FROM organizations WHERE id IN (${ORG}, ${ORG2})`;
  process.env.B2_KEY_ID = SAVED_B2.k; process.env.B2_APPLICATION_KEY = SAVED_B2.a; process.env.B2_BUCKET_NAME = SAVED_B2.b;
  process.env.GMAIL_ADDRESS = SAVED_GMAIL.a; process.env.GMAIL_APP_PASSWORD = SAVED_GMAIL.p;
};

try {
/* ---- fixtures: users, memberships, a completed dispatch job ---- */
await q`INSERT INTO organizations(id, name) VALUES(${ORG}, ${"qa claims"}), (${ORG2}, ${"qa claims 2"})`;
await q`INSERT INTO users(id, name, email, password_hash, towbook_driver_id) VALUES
  (${OWNER}, ${"QA Owner"}, ${`${OWNER}@qa.local`}, ${"x"}, NULL),
  (${ADMIN}, ${"QA Admin"}, ${`${ADMIN}@qa.local`}, ${"x"}, NULL),
  (${DRIVER}, ${"QA Driver"}, ${`${DRIVER}@qa.local`}, ${"x"}, ${DRIVER_TB}),
  (${OTHER}, ${"QA Other"}, ${`${OTHER}@qa.local`}, ${"x"}, ${OTHER_TB}),
  (${OTHER2}, ${"QA Owner2"}, ${`${OTHER2}@qa.local`}, ${"x"}, NULL)`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES
  (${ORG}, ${OWNER}, 'owner'), (${ORG}, ${ADMIN}, 'admin'),
  (${ORG}, ${DRIVER}, 'contractor'), (${ORG}, ${OTHER}, 'contractor'),
  (${ORG2}, ${OTHER2}, 'owner')`;
await q`INSERT INTO dispatch_jobs(id, org_id, towbook_job_id, customer_name, phone, lat, lng, area, service_type, status, created_at, completed_at, assigned_driver_towbook_id)
  VALUES(${JOB_ID}, ${ORG}, ${"111136703"}, ${"Carly Feiner"}, ${"9145550101"}, 41.1, -73.5, ${"CT"}, ${"Tire Change"}, 'completed', NOW(), NOW(), ${DRIVER_TB})`;

/* ---- mock B2 fetch (authorize + S3 PUT/GET in-memory) ---- */
function makeFetch() {
  const objects = new Map();
  const resp = (status, { json, bytes } = {}) => ({
    status, ok: status >= 200 && status < 300,
    text: async () => (json != null ? JSON.stringify(json) : ""),
    json: async () => (json != null ? JSON.parse(JSON.stringify(json)) : {}),
    arrayBuffer: async () => (bytes != null ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : new ArrayBuffer(0)),
  });
  return {
    fetch: async (url, init) => {
      const u = String(url);
      if (u.includes("/b2api/v3/b2_authorize_account")) {
        return resp(200, { json: { apiInfo: { storageApi: { s3ApiUrl: "https://s3.qa.b2" } }, authorizationToken: "tok", allowed: { bucketName: null } } });
      }
      if (u.includes("/b2api/v2/b2_get_upload_url") || u.includes("s3.qa.b2")) {
        if ((init?.method ?? "GET") === "PUT") {
          const key = decodeURIComponent(new URL(u).pathname.replace(/^\//, ""));
          objects.set(key, Buffer.from(init.body));
          return resp(200, { json: {} });
        }
        const key = decodeURIComponent(new URL(u).pathname.replace(/^\//, ""));
        const b = objects.get(key);
        if (!b) return resp(404, { json: {} });
        return resp(200, { bytes: b });
      }
      return resp(500, { json: {} });
    },
    objects,
  };
}
const b2 = makeFetch();

/* ---- REAL evidence emails (surveyed 2026-08-12) ---- */
const AGERO_BODY = `7/20/2026 Vendor #: 114058 Service Provider: Lightning Roadside Assistants, Llc
Dear Lightning Roadside Assistants, Llc,
One of our clients' customers believes that damage was caused as a result of services recently performed by your company.
Case Number: 2026-07-5643800 Date of Loss: 7/14/2026 PO #: 111136703
Owner's Name: Carly Rebecca Feiner Villalobos
Owner's Phone Number: (914) 391-2965
Vehicle Year, Make, Model: 2022 Subaru CROSSTREK
VIN: JF2GTHRC0NH256893
Vehicle Damage: Wheels/Tire - Tire/Rim
Please complete the following WITHIN 72 HOURS: Statement on how this dispatch is being billed; Signed tow slip; Any photos/videos taken at the disablement location.
The Driver's Questionnaire needs to be completed and submitted back to Agero. You can find it at this url: https://bit.ly/agero-driver-form
You can provide us with all of the documentation above in the following ways:
Email: DamageTeam@Agero.com`;
const SIXT_BODY = `Damage Number:9078616944
Rental Agreement Number:9612474171
Hello GEORGE BOYD,
During your last rental, new damages were found on the vehicle and we therefore ask you to provide a statement to clarify the matter.
New damages: Bumper, front Passenger side scratch 2-4 inch (down to primer)
Please click on the link below and fill out the online form: https://click.travel.sixt.com/?qs=example`;
const MARKETING = `Claim Your Gift: Your $3,000 WeSalute Travel Cash gift is ready for your next booking. Skyrocketing travel costs shouldn't stop you.`;

/* ---- mock mailbox (imapflow surface) ---- */
function makeMailbox(msgs) {
  let open = false;
  return {
    connect: async () => { open = true; },
    mailboxOpen: async () => { if (!open) throw new Error("not connected"); return {}; },
    search: async () => msgs.map((m) => m.uid),
    fetchOne: async (uid, query, options) => {
      if (!options?.uid) throw new Error("test mailbox requires { uid: true } options (sequence-mode fetch is the bug this suite guards)");
      const m = msgs.find((x) => x.uid === uid);
      if (!m) return null;
      const source = Buffer.from(`${m.headers}\r\n\r\n${m.body}`);
      return { envelope: { messageId: m.messageId, date: new Date(m.date), from: [{ address: m.from }], subject: m.subject }, source };
    },
    logout: async () => { open = false; },
  };
}
const mailMsgs = [
  { uid: 1, messageId: "<agero-1@mail>", from: "damageteam@agero.com", date: "2026-07-20T19:17:58Z", subject: "Action Required: Notification of Damage Complaint on Case # 2026-07-5643800", headers: "From: damageteam@agero.com\r\nTo: lightroad29@gmail.com", body: AGERO_BODY },
  { uid: 2, messageId: "<sixt-1@mail>", from: "no-reply@sixt.com", date: "2026-08-10T09:51:41Z", subject: "Important information: New damages discovered on your Sixt rental vehicle (license plate IL-FP219738) – Please assist us (damage number 9078616944)", headers: "From: no-reply@sixt.com\r\nReply-To: no-reply@sixt.com", body: SIXT_BODY },
  { uid: 3, messageId: "<wesalute@mail>", from: "community@wesalute.com", date: "2026-08-11T18:54:31Z", subject: "Claim Your Gift: Your $3,000 WeSalute Travel Cash gift is ready", headers: "From: community@wesalute.com", body: MARKETING },
  { uid: 4, messageId: "<dell@mail>", from: "Dell_Technologies@comms.dell.com", date: "2026-07-23T13:32:47Z", subject: "Claim your 10% off now.", headers: "From: Dell_Technologies@comms.dell.com", body: "Claim your 10% off now. Shop the sale." },
  { uid: 5, messageId: "<honk-pay@mail>", from: "accountspayable@honkforhelp.com", date: "2026-07-23T18:52:27Z", subject: "Your payment from HONK - Ref# 11221188391", headers: "From: accountspayable@honkforhelp.com", body: "Your payment from HONK of $145.00 has been issued. Ref# 11221188391" },
];

/* ================= DETECTION (pure) ================= */
const dAgero = detectDamageClaimEmail({ from: "damageteam@agero.com", subject: "Action Required: Notification of Damage Complaint on Case # 2026-07-5643800", bodyText: AGERO_BODY });
check("detect: Agero case classifies", dAgero.isClaim, JSON.stringify(dAgero));
check("detect: Agero claim number", dAgero.claimNumber === "2026-07-5643800", dAgero.claimNumber);
check("detect: Agero company", dAgero.company === "Agero", dAgero.company);
check("detect: Agero PO reference", dAgero.referenceNumber === "111136703", dAgero.referenceNumber);
const dSixt = detectDamageClaimEmail({ from: "no-reply@sixt.com", subject: "Important information: New damages discovered on your Sixt rental vehicle (license plate IL-FP219738) – Please assist us (damage number 9078616944)", bodyText: SIXT_BODY });
check("detect: Sixt damage notice classifies", dSixt.isClaim);
check("detect: Sixt damage number", dSixt.claimNumber === "9078616944", dSixt.claimNumber);
check("detect: Sixt company", dSixt.company === "Sixt", dSixt.company);
check("detect: WeSalute marketing rejected", !detectDamageClaimEmail({ from: "community@wesalute.com", subject: "Claim Your Gift", bodyText: MARKETING }).isClaim);
check("detect: Dell sale rejected", !detectDamageClaimEmail({ from: "Dell_Technologies@comms.dell.com", subject: "Claim your 10% off now.", bodyText: "Claim your 10% off now." }).isClaim);
check("detect: Honk payment NOT a claim", !detectDamageClaimEmail({ from: "accountspayable@honkforhelp.com", subject: "Your payment from HONK - Ref# 11221188391", bodyText: "Your payment from HONK of $145.00 has been issued." }).isClaim);

/* ================= RESOLVED-RESEARCH (pure) ================= */
check("research: no signal → unresolved", !researchResolvedSignals({ bodies: ["We are still investigating."], claimNumber: "2026-07-5643800" }).resolved);
check("research: closed with number → resolved", researchResolvedSignals({ bodies: ["Dear vendor, we have reviewed case 2026-07-5643800 and this complaint is closed. No further action is required."], claimNumber: "2026-07-5643800" }).resolved);
check("research: waived → resolved", researchResolvedSignals({ bodies: ["Case 2026-07-5643800 has been waived."], claimNumber: "2026-07-5643800" }).resolved);
check("research: unrelated number + closed → NOT resolved", !researchResolvedSignals({ bodies: ["Case 2026-08-9999999 is closed."], claimNumber: "2026-07-5643800" }).resolved);

/* ================= SCAN ================= */
const scan = await scanClaimsCore(ACTOR, { connectImpl: () => Promise.resolve(makeMailbox(mailMsgs)), maxMessages: 10 });
check("scan: ok", scan.ok, scan.message ?? "");
check("scan: 2 claims created (Agero + Sixt)", scan.ok && scan.data.created === 2, JSON.stringify(scan));
check("scan: Agero claim linked job by PO", (() => { const c = scan.data.claims.find((x) => x.company === "Agero"); return c && c.claimNumber === "2026-07-5643800"; })());
const scan2 = await scanClaimsCore(ACTOR, { connectImpl: () => Promise.resolve(makeMailbox(mailMsgs)), maxMessages: 10 });
check("scan: re-scan dedupes (0 created)", scan2.ok && scan2.data.created === 0);
check("scan: marketing never stored", !scan.data.claims.some((c) => c.company === null && c.emailSubject.includes("Gift")));
const ageroId = scan.data.claims.find((c) => c.company === "Agero").id;
const sixtId = scan.data.claims.find((c) => c.company === "Sixt").id;

/* ================= RESEARCH ================= */
const researched = await researchClaimCore(ACTOR, ageroId, { connectImpl: () => Promise.resolve(makeMailbox(mailMsgs)) });
check("research: Agero → researched", researched.ok && researched.data.status === "researched", JSON.stringify(researched.data?.status));
check("research: job linked by PO + driver auto-assigned", researched.ok && researched.data.jobId === JOB_ID && researched.data.driverUserId === DRIVER, JSON.stringify({ jobId: researched.data?.jobId, driver: researched.data?.driverUserId }));

/* ================= PREPARE ================= */
const prepared = await prepareClaimFormCore(ACTOR, { claimId: ageroId });
check("prepare: Agero → form_ready", prepared.ok && prepared.data.status === "form_ready");
check("prepare: Agero return = email DamageTeam@Agero.com", prepared.ok && prepared.data.sendTo === "DamageTeam@Agero.com" && prepared.data.sendMethod === "email", JSON.stringify({ to: prepared.data?.sendTo, m: prepared.data?.sendMethod }));
check("prepare: statement prepared in our favor", prepared.ok && String(prepared.data.form.statement).includes("does not reflect damage caused by our service"));
const prepSixt = await prepareClaimFormCore(ACTOR, { claimId: sixtId });
check("prepare: Sixt return = web_form", prepSixt.ok && prepSixt.data.sendMethod === "web_form", JSON.stringify(prepSixt.data?.sendMethod));

/* ================= DRIVER SIGN ================= */
const signWrong = await signClaimCore(OTHER_DRIVER_ACTOR, { claimId: ageroId, signatureDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }, { fetchImpl: b2.fetch });
check("sign: other driver refused", !signWrong.ok && signWrong.code === "unauthorized");
const sign = await signClaimCore(DRIVER_ACTOR, { claimId: ageroId, signatureDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }, { fetchImpl: b2.fetch });
check("sign: assigned driver signs → pending_approval", sign.ok && sign.data.status === "pending_approval", JSON.stringify(sign));
// The mock B2 keys objects under the bucket-qualified path (URL pathname =
// /<bucket>/<key>), matching driver-photos.test.mjs — the DB stores the bare key.
check("sign: signature stored in B2", sign.ok && sign.data.signatureStorageKey != null && b2.objects.has(`qa-bucket/${sign.data.signatureStorageKey}`));
// Sixt has no linked job/driver — the owner may sign on behalf (core allows
// owner/admin when no driver is assigned) so the admin-approve check below has
// a valid pending_approval claim to approve.
const signSixt = await signClaimCore(ACTOR, { claimId: sixtId, signatureDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }, { fetchImpl: b2.fetch });
check("sign: owner signs unassigned Sixt claim on behalf", signSixt.ok && signSixt.data.status === "pending_approval", JSON.stringify(signSixt));
/* Driver feed verified HERE (both claims pending_approval; ageroId assigned to
 * DRIVER, sixtId unassigned) — after approve/send/reject the feed is
 * legitimately empty, so this check must run before those transitions. */
const feedMine = await listMyClaimSignRequestsCore(DRIVER_ACTOR);
const feedOthers = await listMyClaimSignRequestsCore(OTHER_DRIVER_ACTOR);
check("driver feed: only assigned driver sees sign requests", feedMine.ok && feedOthers.ok && feedMine.data.length > 0 && feedOthers.data.length === 0, JSON.stringify({ mine: feedMine.data?.length, others: feedOthers.data?.length }));

/* ================= APPROVAL GATE ================= */
const sendNoApprove = await sendClaimCore(ACTOR, ageroId, { sendImpl: async (m) => { throw new Error("must not send before approval: " + m.subject); } });
check("GATE: send refuses without approval", !sendNoApprove.ok && sendNoApprove.code === "invalid_state", JSON.stringify(sendNoApprove));
const approve = await approveClaimCore(ACTOR, ageroId);
check("approve: owner approves → approved", approve.ok && approve.data.status === "approved");
check("approve: admin can approve too", (await approveClaimCore(ADMIN_ACTOR, sixtId)).ok);
check("approve: dispatcher refused", !(await approveClaimCore(DISPATCHER, ageroId)).ok);

/* ================= SEND (mocked transport) ================= */
let sentMessages = [];
const dryRun = await sendClaimCore(ACTOR, ageroId, { sendImpl: async () => { throw new Error("dryRun must not send"); }, dryRun: true, fetchImpl: b2.fetch });
check("send: dryRun does not send or change status", dryRun.ok && dryRun.data.preview.to === "DamageTeam@Agero.com", JSON.stringify(dryRun));
const send = await sendClaimCore(ACTOR, ageroId, { sendImpl: async (m) => { sentMessages.push(m); return { ok: true, response: "250 OK" }; }, fetchImpl: b2.fetch });
check("send: approved + email method → sent", send.ok && send.data.status === "sent", JSON.stringify(send));
check("send: one audited message to company", sentMessages.length === 1 && sentMessages[0].to[0] === "DamageTeam@Agero.com");
check("send: signature attached", sentMessages[0].attachments?.length === 1 && sentMessages[0].attachments[0].base64 !== "PENDING");
const sentRow = (await listClaimsCore(ACTOR)).data.find((c) => c.id === ageroId);
check("send: sent_at + send_to recorded", sentRow.sentAt != null && sentRow.sendTo === "DamageTeam@Agero.com");
let wfCalled = false;
const wfRes = await sendClaimCore(ACTOR, sixtId, { sendImpl: async () => { wfCalled = true; return { ok: true }; } });
check("send: web_form (Sixt) NEVER emails", !wfRes.ok && wfRes.code === "send_unsupported" && !wfCalled, JSON.stringify(wfRes));
check("send: repeat send refused", !(await sendClaimCore(ACTOR, ageroId, { sendImpl: async () => ({ ok: true }) })).ok);

/* ================= ROLE + GATES ================= */
check("listClaims: wrong org isolated", (await listClaimsCore(WRONG_ORG_ACTOR)).ok && (await listClaimsCore(WRONG_ORG_ACTOR)).data.length === 0);
check("send: wrong-org owner refused", !(await sendClaimCore(WRONG_ORG_ACTOR, ageroId, { sendImpl: async () => ({ ok: true }) })).ok);
const rejected = await rejectClaimCore(ACTOR, { claimId: sixtId, reason: "owner review" });
check("reject: closes claim", rejected.ok && rejected.data.status === "closed", JSON.stringify(rejected));

/* ================= EMAIL COMPOSITION (pure) ================= */
const email = buildClaimEmail({ from: "lightroad29@gmail.com", to: "DamageTeam@Agero.com", claim: sentRow });
check("buildClaimEmail: subject carries claim number", email.subject.includes("2026-07-5643800"));
check("buildClaimEmail: statement in body", email.text.includes("does not reflect damage"));

/* ================= AUDIT ================= */
const auditRows = await q`SELECT action FROM audit_log WHERE org_id=${ORG} AND entity_type='damage_claim' ORDER BY occurred_at`;
const actions = auditRows.map((r) => r.action);
for (const want of ["damage_claim_detected", "damage_claim_researched", "damage_claim_form_prepared", "damage_claim_signed", "damage_claim_approved", "damage_claim_sent"]) {
  check(`audit: ${want} recorded`, actions.includes(want), actions.join(","));
}
} finally {
  await cleanup();
}

/* ================= POST-CLEANUP VERIFICATION (zero QA rows) ================= */
const leftover = await q`SELECT
  (SELECT count(*) FROM damage_claims WHERE org_id LIKE 'qa-claims%') AS claims,
  (SELECT count(*) FROM audit_log WHERE org_id LIKE 'qa-claims%') AS audit,
  (SELECT count(*) FROM organizations WHERE id LIKE 'qa-claims%') AS orgs,
  (SELECT count(*) FROM users WHERE id LIKE 'qa-cl-%') AS users,
  (SELECT count(*) FROM organization_memberships WHERE org_id LIKE 'qa-claims%') AS mems,
  (SELECT count(*) FROM dispatch_jobs WHERE org_id LIKE 'qa-claims%') AS jobs,
  (SELECT count(*) FROM status_events WHERE org_id LIKE 'qa-claims%') AS events,
  (SELECT count(*) FROM completion_tips WHERE org_id LIKE 'qa-claims%') AS tips`;
check("cleanup: zero QA rows", Number(leftover[0].claims) === 0 && Number(leftover[0].audit) === 0 && Number(leftover[0].orgs) === 0 && Number(leftover[0].users) === 0 && Number(leftover[0].mems) === 0 && Number(leftover[0].jobs) === 0 && Number(leftover[0].events) === 0 && Number(leftover[0].tips) === 0, JSON.stringify(leftover[0]));
console.log(`\nclaims.test.mjs: ${checks.length}/${checks.length} passed`);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
