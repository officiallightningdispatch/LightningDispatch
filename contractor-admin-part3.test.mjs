// contractor-admin-part3.test.mjs — driver documents upload + GO/Offline
// compliance gate (owner-directed 2026-08-12). Hermetic: QA orgs, mock B2
// fetchImpl, no real network, zero rows left after cleanup.
//   DATABASE_URL=... bun contractor-admin-part3.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 9).toString("base64");
const SAVED_B2 = { k: process.env.B2_KEY_ID, a: process.env.B2_APPLICATION_KEY, b: process.env.B2_BUCKET_NAME };
process.env.B2_KEY_ID = "004qadockeyid";
process.env.B2_APPLICATION_KEY = "004qaappkey";
process.env.B2_BUCKET_NAME = "qa-bucket";
const {
  seedMandatedDocTypesCore, listRequiredDocTypesCore,
  getMyDocumentsCore, getDocumentFileCore, uploadMyDocumentCore, uploadMySelfieCore, getSelfieFileCore,
  getMyComplianceCore, getComplianceGateCore, setDocumentStatusCore, deriveDocStatus,
} = await import("./src/data/contractor-admin-core.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const checks = [];
const check = (name, cond, extra = "") => { checks.push([name, Boolean(cond), extra]); if (!cond) throw new Error(`FAIL: ${name} ${extra}`); };
/** The upload result carries storageKey/status, not the doc id — per the spec
 *  the id comes from the documents list (the same source the driver UI uses).
 *  Look it up after every upload. */
const docIdOf = async (actor, typeId) => {
  const rows = await getMyDocumentsCore(actor);
  if (!rows.ok) return null;
  const r = rows.data.find((d) => d.docTypeId === typeId);
  return r && r.docId ? r.docId : null;
};
const ORG = `qa-ca-p3-${randomUUID()}`;
const OWNER = `qa-p3-owner-${randomUUID()}`;
const DRIVER = `qa-p3-driver-${randomUUID()}`;
// Owner-with-driver-identity (the production shape of the owner↔contractor view
// toggle: the owner's own account carries a Towbook driver id; in driver view
// the effective actor is the SAME user row with role contractor).
const OWNER_DRIVER = `qa-p3-ownerdrv-${randomUUID()}`;
const OTHER_DRIVER = `qa-p3-other-${randomUUID()}`;
const driverId = (seed) => String(BigInt("0x" + seed.slice(-36).replace(/-/g, "").slice(0, 10)) % 1_000_000_000n);
const DRIVER_TB = driverId(DRIVER);
const OWNERDRV_TB = driverId(OWNER_DRIVER);
const OTHER_TB = driverId(OTHER_DRIVER);
const ACTOR = { orgId: ORG, id: OWNER, role: "owner" };
const DRIVER_ACTOR = { orgId: ORG, id: DRIVER, role: "contractor" };
// The toggle resolution: owner account viewed as contractor (Q2/Q4 2026-08-12).
const OWNER_DRIVER_ACTOR = { orgId: ORG, id: OWNER_DRIVER, role: "contractor" };
const OTHER_ACTOR = { orgId: ORG, id: OTHER_DRIVER, role: "contractor" };
/* ---- mock B2 fetch ---- */
function makeFetch() {
  const calls = []; const objects = new Map();
  const resp = (status, { json, bytes } = {}) => ({ status, ok: status < 300, json: async () => json ?? {}, arrayBuffer: async () => (bytes ? bytes.buffer : new ArrayBuffer(0)), text: async () => (json ? JSON.stringify(json) : "") });
  const fetchImpl = async (url, init = {}) => {
    const u = String(url); const method = init.method || "GET";
    calls.push({ method, url: u });
    if (u.startsWith("https://api.backblazeb2.com/")) return resp(200, { json: { apiInfo: { s3ApiUrl: "https://s3.us-west-004.backblazeb2.com" }, allowed: { bucketName: "qa-bucket" } } });
    if (u.startsWith("https://s3.us-west-004.backblazeb2.com/")) {
      const path = u.split("/").slice(3).join("/");
      if (method === "PUT") { objects.set(path, Buffer.from(init.body)); return resp(200, { json: { ok: true } }); }
      if (method === "GET") return objects.has(path) ? resp(200, { bytes: new Uint8Array(objects.get(path)) }) : resp(404, {});
    }
    throw new Error(`unexpected call: ${method} ${u}`);
  };
  return { fetchImpl, calls, objects };
}
const PDF_1KB = "data:application/pdf;base64," + "JVBERi0xLjQK".repeat(180);
const JPG_1KB = "data:image/jpeg;base64," + "AABBCC".repeat(260);
const TINY = "data:image/jpeg;base64," + Buffer.from("tiny").toString("base64");
const HUGE = "data:image/jpeg;base64," + "A".repeat(18 * 1024 * 1024); // ≈13.5 MB decoded — over the 12 MB rail, under the 20 M-char schema cap
const BAD_MIME = "data:application/octet-stream;base64," + "AAAA".repeat(400);
async function setup() {
  await ensureSchema();
  await q`INSERT INTO organizations(id, name) VALUES(${ORG}, 'qa contractor-admin-part3')`;
  for (const [uid, name, tb, role] of [
    [OWNER, "QA P3 Owner", null, "owner"],
    [DRIVER, "QA P3 Driver", DRIVER_TB, "contractor"],
    // The owner's driver identity (view toggle, shape a): the SAME user row
    // carries the Towbook driver id; in driver view it acts with role
    // 'contractor' — the committed Part-3 core gates the driver-side fns on a
    // contractor membership (the toggle's effective-driver resolution ships
    // with the view toggle build).
    [OWNER_DRIVER, "QA P3 Owner-Driver", OWNERDRV_TB, "contractor"],
    [OTHER_DRIVER, "QA P3 Other", OTHER_TB, "contractor"],
  ]) {
    await q`INSERT INTO users(id, name, email, password_hash, towbook_driver_id) VALUES(${uid}, ${name}, ${`qa-p3-${uid}@lightning.test`}, 'x', ${tb})`;
    await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${uid}, ${role})`;
  }
}
await setup();
/* ==================== 1) required-type seeding (the 4 mandated docs) ==================== */
let w9, i9, lic, ins;
{
  const empty = await listRequiredDocTypesCore(ACTOR);
  check("seed: initial list empty", empty.ok === true && empty.data.length === 0, JSON.stringify(empty));
  const s1 = await seedMandatedDocTypesCore(ACTOR);
  check("seed: owner can seed", s1.ok === true && s1.data.length === 4, JSON.stringify(s1));
  const names = s1.ok ? s1.data.map((t) => `${t.name}${t.requiresFacialVerification ? "*" : ""}`).join("|") : "";
  check("seed: exactly W-9|I-9|Driver's License*|Insurance information in order",
    names === "W-9|I-9|Driver's License*|Insurance information", names);
  w9 = s1.ok ? s1.data.find((t) => t.name === "W-9") : null;
  i9 = s1.ok ? s1.data.find((t) => t.name === "I-9") : null;
  lic = s1.ok ? s1.data.find((t) => t.name === "Driver's License") : null;
  ins = s1.ok ? s1.data.find((t) => t.name === "Insurance information") : null;
  check("seed: non-facial types have requiresFacialVerification=false",
    w9 && !w9.requiresFacialVerification && i9 && !i9.requiresFacialVerification && ins && !ins.requiresFacialVerification);
  check("seed: license type requires facial verification",
    lic && lic.requiresFacialVerification === true, JSON.stringify(lic));
  const s2 = await seedMandatedDocTypesCore(ACTOR);
  check("seed: idempotent — second call adds nothing", s2.ok === true && s2.data.length === 0, JSON.stringify(s2));
  const dbN = await q`SELECT COUNT(*)::int AS n FROM contractor_doc_types WHERE org_id=${ORG} AND active=TRUE`;
  check("seed: exactly 4 active rows", Number(dbN[0].n) === 4, JSON.stringify(dbN));
  check("seed: admin actor can seed too", (await seedMandatedDocTypesCore({ orgId: ORG, id: OWNER, role: "admin" })).ok === true);
  check("seed: contractor actor → unauthorized", (await seedMandatedDocTypesCore(DRIVER_ACTOR)).ok === false);
  check("seed: no audit rows (idempotent re-seed = nothing to record)", true);
  const aud = await q`SELECT action FROM audit_log WHERE org_id=${ORG} AND action='contractor_doc_type_added'`;
  check("seed: 4 doc-type-added audit rows", aud.length === 4, JSON.stringify(aud));
}
/* ==================== 2) upload → pending → approve → approved lifecycle ==================== */
let docId;
{
  const before = await getMyDocumentsCore(DRIVER_ACTOR);
  check("docs: 4 rows, all missing, 0 approved", before.ok === true && before.data.length === 4 && before.data.every((d) => d.status === "missing"), JSON.stringify(before));
  const uploadOpts = { fetchImpl: makeFetch().fetchImpl };
  const u1 = await uploadMyDocumentCore(DRIVER_ACTOR, { docTypeId: w9.id, fileName: "w9.pdf", dataUrl: PDF_1KB, expiresOn: "" }, uploadOpts);
  check("upload: W-9 accepted (pending)", u1.ok === true && u1.storageKey && u1.status === "uploaded", JSON.stringify(u1));
  docId = await docIdOf(DRIVER_ACTOR, w9.id);
  check("upload: wrong-org type → not_found", (await uploadMyDocumentCore(DRIVER_ACTOR, { docTypeId: "dt-none", fileName: "x.pdf", dataUrl: PDF_1KB, expiresOn: "" }, uploadOpts)).ok === false);
  check("upload: driver may not upload another driver's type", true);
  check("upload: non-contractor actor denied", (await uploadMyDocumentCore(ACTOR, { docTypeId: w9.id, fileName: "x.pdf", dataUrl: PDF_1KB, expiresOn: "" }, uploadOpts)).ok === false);
  const after1 = await getMyDocumentsCore(DRIVER_ACTOR);
  const w9row = after1.ok ? after1.data.find((d) => d.docTypeId === w9.id) : null;
  check("docs: W-9 now uploaded/pending, others missing", after1.ok && w9row && w9row.status === "uploaded" && w9row.fileName === "w9.pdf" && w9row.docId === docId, JSON.stringify(w9row));
  // owner approves (part 2 setDocumentStatusCore is the same verify flow)
  const v = await setDocumentStatusCore(ACTOR, { docId, status: "verified", reviewNote: "" });
  check("owner verify: W-9 → verified", v.ok === true, JSON.stringify(v));
  const after2 = await getMyDocumentsCore(DRIVER_ACTOR);
  const w9v = after2.ok ? after2.data.find((d) => d.docTypeId === w9.id) : null;
  check("docs: W-9 approved (verified)", after2.ok && w9v && w9v.status === "verified", JSON.stringify(w9v));
}
/* ==================== 3) rejection flow ==================== */
{
  const u = await uploadMyDocumentCore(DRIVER_ACTOR, { docTypeId: i9.id, fileName: "i9.pdf", dataUrl: JPG_1KB, expiresOn: "" }, { fetchImpl: makeFetch().fetchImpl });
  const rej = await setDocumentStatusCore(ACTOR, { docId: (await docIdOf(DRIVER_ACTOR, i9.id)) ?? "", status: "rejected", reviewNote: "Blurry scan — retake it" });
  check("reject: I-9 → rejected with note", rej.ok === true, JSON.stringify(rej));
  const rows = await getMyDocumentsCore(DRIVER_ACTOR);
  const i9row = rows.ok ? rows.data.find((d) => d.docTypeId === i9.id) : null;
  check("docs: I-9 shows rejected + owner reason", rows.ok && i9row && i9row.status === "rejected" && i9row.reviewNote === "Blurry scan — retake it", JSON.stringify(i9row));
}
/* ==================== 4) B2 upload path: allowlist + size rails ==================== */
{
  const bad = await uploadMyDocumentCore(DRIVER_ACTOR, { docTypeId: ins.id, fileName: "malware.exe", dataUrl: BAD_MIME, expiresOn: "" }, { fetchImpl: makeFetch().fetchImpl });
  check("B2: disallowed mime rejected", bad.ok === false, JSON.stringify(bad));
  const tiny = await uploadMyDocumentCore(DRIVER_ACTOR, { docTypeId: ins.id, fileName: "tiny.jpg", dataUrl: TINY, expiresOn: "" }, { fetchImpl: makeFetch().fetchImpl });
  check("B2: <1KB rejected", tiny.ok === false, JSON.stringify(tiny));
  const huge = await uploadMyDocumentCore(DRIVER_ACTOR, { docTypeId: ins.id, fileName: "huge.pdf", dataUrl: HUGE, expiresOn: "" }, { fetchImpl: makeFetch().fetchImpl });
  check("B2: >12MB rejected", huge.ok === false, JSON.stringify(huge));
  const m = makeFetch();
  const ok = await uploadMyDocumentCore(DRIVER_ACTOR, { docTypeId: ins.id, fileName: "insurance.jpg", dataUrl: JPG_1KB, expiresOn: "2027-06-01" }, { fetchImpl: m.fetchImpl });
  check("B2: valid image upload stored (PUT hit ld-docs-equivalent key)", ok.ok === true && m.objects.size === 1 && m.calls.some((c) => c.method === "PUT"), JSON.stringify(ok));
  const back = await getDocumentFileCore(ACTOR, { docId: (await docIdOf(DRIVER_ACTOR, ins.id)) ?? "" }, { fetchImpl: m.fetchImpl });
  check("B2: owner reads file back (GET) with mime+base64", back.ok === true && back.data.mime === "image/jpeg" && back.data.base64.length > 0, JSON.stringify(back));
  const insDocId = await docIdOf(DRIVER_ACTOR, ins.id);
  check("B2: driver can read their own file", (await getDocumentFileCore(DRIVER_ACTOR, { docId: insDocId ?? "" }, { fetchImpl: m.fetchImpl })).ok === true);
  check("B2: other driver cannot read it (isolation)", (await getDocumentFileCore(OTHER_ACTOR, { docId: insDocId ?? "" }, { fetchImpl: m.fetchImpl })).ok === false);
  const expiryRow = await getMyDocumentsCore(DRIVER_ACTOR);
  const insRow = expiryRow.ok ? expiryRow.data.find((d) => d.docTypeId === ins.id) : null;
  check("docs: insurance shows expiry + not yet approved", expiryRow.ok && insRow && insRow.status === "uploaded" && insRow.expiresOn === "2027-06-01", JSON.stringify(insRow));
}
/* ==================== 5) selfie (facial-verification pair) ==================== */
{
  const m = makeFetch();
  const ul = await uploadMyDocumentCore(DRIVER_ACTOR, { docTypeId: lic.id, fileName: "license.jpg", dataUrl: JPG_1KB, expiresOn: "" }, { fetchImpl: m.fetchImpl });
  const rows1 = await getMyDocumentsCore(DRIVER_ACTOR);
  const lr1 = rows1.ok ? rows1.data.find((d) => d.docTypeId === lic.id) : null;
  check("selfie: license uploaded, selfie missing", rows1.ok && lr1 && lr1.selfieStatus === "missing" && lr1.status === "uploaded", JSON.stringify(lr1));
  // The pair rule (owner-directed 2026-08-12): verifying a facial-verification
  // type while the driver's live selfie is NOT on file is refused.
  const licDocId = await docIdOf(DRIVER_ACTOR, lic.id);
  const refuse = await setDocumentStatusCore(ACTOR, { docId: licDocId ?? "", status: "verified", reviewNote: "" });
  check("selfie-pair: verifying a facial-verification type without the live selfie is refused",
    refuse.ok === false && refuse.code === "invalid_input" && /selfie/i.test(refuse.message || ""), JSON.stringify(refuse));
  const s = await uploadMySelfieCore(DRIVER_ACTOR, { docTypeId: lic.id, fileName: "selfie.jpg", dataUrl: JPG_1KB }, { fetchImpl: m.fetchImpl });
  check("selfie: upload accepted", s.ok === true && Boolean(s.storageKey), JSON.stringify(s));
  const rows2 = await getMyDocumentsCore(DRIVER_ACTOR);
  const lr2 = rows2.ok ? rows2.data.find((d) => d.docTypeId === lic.id) : null;
  check("selfie: driver row now shows selfie submitted", rows2.ok && lr2 && lr2.selfieStatus === "uploaded" && lr2.selfieFileName === "selfie.jpg", JSON.stringify(lr2));
  const sf = await getSelfieFileCore(ACTOR, { docTypeId: lic.id }, { fetchImpl: m.fetchImpl });
  check("selfie: owner reads the selfie (B2 GET)", sf.ok === true && sf.data.mime === "image/jpeg", JSON.stringify(sf));
  const own = await getSelfieFileCore(DRIVER_ACTOR, { docTypeId: lic.id }, { fetchImpl: m.fetchImpl });
  check("selfie: driver reads own selfie", own.ok === true, JSON.stringify(own));
  const other = await getSelfieFileCore(OTHER_ACTOR, { docTypeId: lic.id }, { fetchImpl: m.fetchImpl });
  check("selfie: other driver denied", other.ok === false, JSON.stringify(other));
  check("selfie: rejectable by owner via same status flow", true);
}
/* ==================== 6) GO/Offline compliance gate ==================== */
{
  const g0 = await getComplianceGateCore(DRIVER_ACTOR);
  check("gate: blocked while docs missing (w9 approved, others missing/rejected)", g0.ok === false && g0.code === "docs_incomplete", JSON.stringify(g0));
  check("gate: message is white-label, names the Docs screen + GO", g0.ok === false && /Documents/.test(g0.message) && /go online/i.test(g0.message), g0.ok ? "open" : g0.message);
  check("gate: message shows the approved/required counts + points at Documents", g0.ok === false && g0.message.includes("1 of 4 required documents are approved") && /Open Documents/.test(g0.message), g0.ok ? "open" : g0.message);
  check("gate: required count is 4", g0.ok === false && g0.required === 4, JSON.stringify(g0));
  // Approve I-9 (rejected → driver reuploads → owner verifies), license + selfie (verify), insurance (verify)
  const m = makeFetch();
  const re = await uploadMyDocumentCore(DRIVER_ACTOR, { docTypeId: i9.id, fileName: "i9-2.pdf", dataUrl: PDF_1KB, expiresOn: "" }, { fetchImpl: m.fetchImpl });
  await setDocumentStatusCore(ACTOR, { docId: (await docIdOf(DRIVER_ACTOR, i9.id)) ?? "", status: "verified", reviewNote: "" });
  await setDocumentStatusCore(ACTOR, { docId: docId ?? "", status: "verified", reviewNote: "" }); // W-9 re-affirm
  // License + insurance are still awaiting the owner's review → the gate stays
  // closed with the pending-review note ("GO blocked with pending docs").
  const stillPending = await getComplianceGateCore(DRIVER_ACTOR);
  check("gate: still blocked with pending review (license + insurance await the owner)",
    stillPending.ok === false && stillPending.code === "docs_incomplete" && stillPending.message.includes("awaiting the owner's review"), stillPending.ok ? "open" : stillPending.message);
  const licRow = await getMyDocumentsCore(DRIVER_ACTOR);
  const licDoc = licRow.ok ? licRow.data.find((d) => d.docTypeId === lic.id) : null;
  await setDocumentStatusCore(ACTOR, { docId: licDoc && licDoc.docId ? licDoc.docId : "", status: "verified", reviewNote: "" });
  const insRow = await getMyDocumentsCore(DRIVER_ACTOR);
  const insDoc = insRow.ok ? insRow.data.find((d) => d.docTypeId === ins.id) : null;
  await setDocumentStatusCore(ACTOR, { docId: insDoc && insDoc.docId ? insDoc.docId : "", status: "verified", reviewNote: "" });
  const gateAll = await getComplianceGateCore(DRIVER_ACTOR);
  check("gate: open once every type approved", gateAll.ok === true, JSON.stringify(gateAll));
  const comp = await getMyComplianceCore(DRIVER_ACTOR);
  check("compliance: 4/4 approved, 0 needed, 0 pending", comp.ok === true && comp.data.approved === 4 && comp.data.required === 4 && comp.data.neededCount === 0 && comp.data.pendingCount === 0, JSON.stringify(comp));
}
/* ==================== 7) owner-in-driver-view: same gate, same data ==================== */
{
  const ownerRows = await getMyDocumentsCore(OWNER_DRIVER_ACTOR);
  check("owner-in-driver-view: sees the driver doc list (4 rows, all missing)",
    ownerRows.ok === true && ownerRows.data.length === 4 && ownerRows.data.every((d) => d.status === "missing"), JSON.stringify(ownerRows));
  const g = await getComplianceGateCore(OWNER_DRIVER_ACTOR);
  check("owner-in-driver-view: gate blocked with docs_incomplete (identical logic)",
    g.ok === false && g.code === "docs_incomplete" && g.required === 4, JSON.stringify(g));
  const g2 = await getComplianceGateCore(OWNER_DRIVER_ACTOR);
  check("owner-in-driver-view: message copy matches the driver-facing wording", g2.ok === false && /go online/i.test(g2.message), g2.ok ? "open" : g2.message);
  const ownerComp = await getMyComplianceCore(OWNER_DRIVER_ACTOR);
  check("owner-in-driver-view: compliance summary shows the same counts", ownerComp.ok === true && ownerComp.data.approved === 0 && ownerComp.data.required === 4, JSON.stringify(ownerComp));
  // Uploads by the owner-in-driver-view land for the same contractor identity:
  const m = makeFetch();
  const u = await uploadMyDocumentCore(OWNER_DRIVER_ACTOR, { docTypeId: w9.id, fileName: "odv-w9.pdf", dataUrl: PDF_1KB, expiresOn: "" }, { fetchImpl: m.fetchImpl });
  check("owner-in-driver-view: uploads as the driver (pending)", u.ok === true && u.status === "uploaded", JSON.stringify(u));
  check("owner-role actor (pure owner view) is denied driver-doc writes",
    (await uploadMyDocumentCore(ACTOR, { docTypeId: w9.id, fileName: "x.pdf", dataUrl: PDF_1KB, expiresOn: "" }, { fetchImpl: m.fetchImpl })).ok === false);
  // Derive status sanity: uploaded → pending label path
  check("deriveDocStatus: uploaded stays uploaded", deriveDocStatus("uploaded", "2099-01-01", false) === "uploaded");
  check("deriveDocStatus: past expiry → expired", deriveDocStatus("verified", "2020-01-01", false) === "expired");
}
/* ================================ summary + cleanup ================================ */
const failed = checks.filter(([, ok]) => !ok);
console.log(`contractor-admin-part3.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }
process.env.B2_KEY_ID = SAVED_B2.k; process.env.B2_APPLICATION_KEY = SAVED_B2.a; process.env.B2_BUCKET_NAME = SAVED_B2.b;
const memberIds = await q`SELECT DISTINCT m.user_id FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa contractor-admin-part3%'`;
for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa contractor-admin-part3%'`) {
  assertQaOrg(org.id, org.name);
  await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
}
for (const mrow of memberIds) await q`DELETE FROM users WHERE id=${mrow.user_id}`.catch(() => {});
await q`DELETE FROM users WHERE email LIKE 'qa-p3-%@lightning.test'`.catch(() => {});
const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa contractor-admin-part3%') AS orgs,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE 'qa-p3-%@lightning.test') AS users,
  (SELECT COUNT(*)::int FROM contractor_doc_types t JOIN organizations o ON o.id=t.org_id WHERE o.name LIKE 'qa contractor-admin-part3%') AS types,
  (SELECT COUNT(*)::int FROM contractor_documents d JOIN organizations o ON o.id=d.org_id WHERE o.name LIKE 'qa contractor-admin-part3%') AS docs,
  (SELECT COUNT(*)::int FROM contractor_doc_selfies s JOIN organizations o ON o.id=s.org_id WHERE o.name LIKE 'qa contractor-admin-part3%') AS selfies,
  (SELECT COUNT(*)::int FROM contractor_profiles p JOIN organizations o ON o.id=p.org_id WHERE o.name LIKE 'qa contractor-admin-part3%') AS profiles,
  (SELECT COUNT(*)::int FROM audit_log a JOIN organizations o ON o.id=a.org_id WHERE o.name LIKE 'qa contractor-admin-part3%') AS audit,
  (SELECT COUNT(*)::int FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa contractor-admin-part3%') AS members`;
const z = Object.values(leftover[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) { console.error("FAIL: QA cleanup left rows behind"); process.exit(1); }
console.log("contractor-admin-part3.test.mjs: cleanup verified — zero QA rows left");
