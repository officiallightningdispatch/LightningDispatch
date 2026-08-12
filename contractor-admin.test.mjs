// Hermetic tests for the contractor-administration core (part 1/3): required
// doc-type CRUD (add/rename/reorder/toggle/soft-remove), per-contractor
// documents with READ-TIME derived status (MISSING/UPLOADED/VERIFIED/EXPIRED/
// REJECTED — date wins), payrate set/clear with audit rows, the extended
// roster payload (payrateCents/requiredDocCount/onFileDocCount), compliance
// counts, contractor-own scoping, and the B2 document path (upload + read via
// an injectable mock fetchImpl — real network calls never happen).
// DB-backed against throwaway QA orgs deleted at the end (zero rows left).
//   DATABASE_URL=... bun contractor-admin.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 9).toString("base64");
// B2 env for THIS process (env-first resolution; the mock fetchImpl serves the
// authorize + S3 calls so no real credential is needed).
const SAVED_B2 = { k: process.env.B2_KEY_ID, a: process.env.B2_APPLICATION_KEY, b: process.env.B2_BUCKET_NAME };
process.env.B2_KEY_ID = "004qadockeyid";
process.env.B2_APPLICATION_KEY = "004qaappkey";
process.env.B2_BUCKET_NAME = "qa-bucket";

const {
  listRequiredDocTypesCore, addDocTypeCore, renameDocTypeCore, removeDocTypeCore,
  setDocTypeActiveCore, reorderDocTypesCore,
  listContractorDocumentsCore, setDocumentStatusCore, setDocumentExpiryCore,
  getDocumentFileCore, setContractorPayrateCore, listContractorComplianceCore,
  getMyDocumentsCore, uploadMyDocumentCore, deriveDocStatus, decodeDocumentDataUrl,
} = await import("./src/data/contractor-admin-core.ts");
const { listContractorsCore } = await import("./src/data/contractor-management-core.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");

const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

const ORG = `qa-contractor-admin-${randomUUID()}`;
const ORG2 = `qa-contractor-admin2-${randomUUID()}`;
const OWNER = `qa-ca-owner-${randomUUID()}`;
const ADMIN = `qa-ca-admin-${randomUUID()}`;
const DRIVER = `qa-ca-driver-${randomUUID()}`;
const OTHER_DRIVER = `qa-ca-other-${randomUUID()}`;
const OWNER2 = `qa-ca-owner2-${randomUUID()}`;
const DRIVER2 = `qa-ca-driver2-${randomUUID()}`;
// Run-unique Towbook driver ids (numeric, derived from the random UUIDs) so a
// crashed run's leftovers can never collide with the next run's fixtures on
// users_towbook_driver_id_idx (unique partial index).
const driverId = (seed) => String(BigInt("0x" + seed.slice(-36).replace(/-/g, "").slice(0, 10)) % 1_000_000_000n);
const DRIVER_TB_ID = driverId(DRIVER);
const DRIVER2_TB_ID = driverId(DRIVER2);
const OTHER_TB_ID = driverId(OTHER_DRIVER);

const ACTOR = { orgId: ORG, id: OWNER, role: "owner" };
const ADMIN_ACTOR = { orgId: ORG, id: ADMIN, role: "admin" };
const DRIVER_ACTOR = { orgId: ORG, id: DRIVER, role: "contractor" };
const OTHER_DRIVER_ACTOR = { orgId: ORG, id: OTHER_DRIVER, role: "contractor" };
const WRONG_ORG_ACTOR = { orgId: ORG2, id: OWNER2, role: "owner" };
const WRONG_DRIVER_ACTOR = { orgId: ORG2, id: DRIVER2, role: "contractor" };

/* ---- mock B2 fetch (authorize + S3 PUT/GET with an in-memory object store) ---- */
function makeFetch() {
  const calls = [];
  const objects = new Map(); // bucket/key → Buffer
  const resp = (status, { json, bytes } = {}) => ({
    status, ok: status >= 200 && status < 300,
    text: async () => (json != null ? JSON.stringify(json) : ""),
    json: async () => (json != null ? JSON.parse(JSON.stringify(json)) : {}),
    arrayBuffer: async () => (bytes != null ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : new ArrayBuffer(0)),
  });
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    calls.push({ method, url: u, body: init.body });
    if (u.startsWith("https://api.backblazeb2.com/")) {
      return resp(200, { json: { apiInfo: { s3ApiUrl: "https://s3.us-west-004.backblazeb2.com" }, allowed: { bucketName: "qa-bucket" } } });
    }
    if (u.startsWith("https://s3.us-west-004.backblazeb2.com/")) {
      const path = u.split("/").slice(3).join("/");
      if (method === "PUT") { objects.set(path, Buffer.from(init.body)); return resp(200, { json: { ok: true } }); }
      if (method === "GET") { return objects.has(path) ? resp(200, { bytes: new Uint8Array(objects.get(path)) }) : resp(404, {}); }
    }
    throw new Error(`unexpected call: ${method} ${u}`);
  };
  return { fetchImpl, calls, objects };
}

const PDF_1KB = "data:application/pdf;base64," + "JVBERi0xLjQK".repeat(180); // ~1.2KB of PDF bytes
const JPG_1KB = "data:image/jpeg;base64," + "AABBCC".repeat(260);           // ~1.3KB
const PNG_1KB = "data:image/png;base64," + "iVBORw0KGgo".repeat(160);       // ~1.1KB
const TINY = "data:image/jpeg;base64," + Buffer.from("tiny").toString("base64");

async function setup() {
  await ensureSchema();
  for (const [org, owner, admin, driver, other] of [
    [ORG, OWNER, ADMIN, DRIVER, OTHER_DRIVER],
    [ORG2, OWNER2, null, DRIVER2, null],
  ]) {
    await q`INSERT INTO organizations(id, name) VALUES(${org}, 'qa contractor-admin')`;
    await q`INSERT INTO users(id, name, email, password_hash) VALUES(${owner}, 'QA CA Owner', ${`qa-ca-owner-${randomUUID()}@lightning.test`}, 'x')`;
    await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${org}, ${owner}, 'owner')`;
    if (admin) {
      await q`INSERT INTO users(id, name, email, password_hash) VALUES(${admin}, 'QA CA Admin', ${`qa-ca-admin-${randomUUID()}@lightning.test`}, 'x')`;
      await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${org}, ${admin}, 'admin')`;
    }
    if (driver) {
      await q`INSERT INTO users(id, name, email, password_hash, towbook_driver_id) VALUES(${driver}, 'QA CA Driver', ${`qa-ca-driver-${randomUUID()}@lightning.test`}, 'x', ${org === ORG ? DRIVER_TB_ID : DRIVER2_TB_ID})`;
      await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${org}, ${driver}, 'contractor')`;
    }
    if (other) {
      await q`INSERT INTO users(id, name, email, password_hash, towbook_driver_id) VALUES(${other}, 'QA CA Other', ${`qa-ca-other-${randomUUID()}@lightning.test`}, 'x', ${OTHER_TB_ID})`;
      await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${org}, ${other}, 'contractor')`;
    }
  }
}
await setup();

/* ==================== 1) doc types: empty → add → validation ==================== */
let w9, ins, lic, mec;
{
  const empty = await listRequiredDocTypesCore(ACTOR);
  check("types: initial list empty", empty.ok === true && empty.data.length === 0, JSON.stringify(empty));
  check("types: contractor actor → unauthorized", (await listRequiredDocTypesCore(DRIVER_ACTOR)).ok === false);
  // Org isolation: the foreign org's owner lists their OWN org (empty here) —
  // never our rows. Cross-org WRITE attempts assert not_found below.
  const foreignList = await listRequiredDocTypesCore(WRONG_ORG_ACTOR);
  check("types: foreign org owner sees their own empty list (no cross-org leak)", foreignList.ok === true && foreignList.data.length === 0, JSON.stringify(foreignList));

  const a1 = await addDocTypeCore(ACTOR, { name: "W-9", requiresExpiry: false });
  check("add W-9", a1.ok === true && a1.data.name === "W-9" && a1.data.requiresExpiry === false && a1.data.active === true && a1.data.sortOrder === 0, JSON.stringify(a1));
  w9 = a1.ok ? a1.data : null;
  const a2 = await addDocTypeCore(ACTOR, { name: "Insurance Certificate", requiresExpiry: true });
  check("add Insurance Certificate (expiry)", a2.ok === true && a2.data.requiresExpiry === true && a2.data.sortOrder === 1, JSON.stringify(a2));
  ins = a2.ok ? a2.data : null;
  const a3 = await addDocTypeCore(ACTOR, { name: "Driver's License", requiresExpiry: true });
  lic = a3.ok ? a3.data : null;
  check("add Driver's License", a3.ok === true && a3.data.sortOrder === 2, JSON.stringify(a3));
  const a4 = await addDocTypeCore(ADMIN_ACTOR, { name: "Medical Examiner Card", requiresExpiry: true });
  mec = a4.ok ? a4.data : null;
  check("admin actor can add too", a4.ok === true, JSON.stringify(a4));

  check("duplicate case-insensitive → duplicate error", (await addDocTypeCore(ACTOR, { name: "w-9" })).ok === false);
  check("empty name → invalid_input", (await addDocTypeCore(ACTOR, { name: "   " })).ok === false);
  check(">40 chars → invalid_input", (await addDocTypeCore(ACTOR, { name: "x".repeat(41) })).ok === false);
  check("contractor actor add → unauthorized", (await addDocTypeCore(DRIVER_ACTOR, { name: "Bad" })).ok === false);
  const dbDup = await q`SELECT COUNT(*)::int AS n FROM contractor_doc_types WHERE org_id=${ORG} AND LOWER(name)='w-9'`;
  check("no duplicate rows inserted", Number(dbDup[0].n) === 1, JSON.stringify(dbDup));

  const list = await listRequiredDocTypesCore(ACTOR);
  check("list: 4 types, active first, sorted by sort_order",
    list.ok === true && list.data.length === 4 &&
    list.data.map((t) => t.name).join("|") === "W-9|Insurance Certificate|Driver's License|Medical Examiner Card", JSON.stringify(list));
  const aud = await q`SELECT action FROM audit_log WHERE org_id=${ORG} AND action LIKE 'contractor_doc_type_%' ORDER BY occurred_at`;
  check("audit: 4 type-add rows", aud.length === 4 && aud.every((r) => String(r.action) === "contractor_doc_type_added"), JSON.stringify(aud));
}

/* ================ 2) doc types: rename / reorder / toggle / soft-remove ================ */
{
  const rn = await renameDocTypeCore(ACTOR, { id: w9.id, name: "W-9 Tax Form" });
  check("rename W-9 → W-9 Tax Form", rn.ok === true && rn.data.name === "W-9 Tax Form" && rn.data.id === w9.id, JSON.stringify(rn));
  check("rename to duplicate (case-insensitive) → duplicate", (await renameDocTypeCore(ACTOR, { id: w9.id, name: "insurance certificate" })).ok === false);
  check("rename missing id → not_found", (await renameDocTypeCore(ACTOR, { id: "dt-none", name: "X" })).ok === false);
  check("rename other-org type → not_found", (await renameDocTypeCore(WRONG_ORG_ACTOR, { id: w9.id, name: "X" })).ok === false);

  // Reorder: [ins, lic, w9, mec] — swap W-9 to the end.
  const re = await reorderDocTypesCore(ACTOR, { orderedIds: [ins.id, lic.id, mec.id, w9.id] });
  check("reorder ok", re.ok === true && re.data.reordered === 4, JSON.stringify(re));
  const afterReorder = await listRequiredDocTypesCore(ACTOR);
  check("reorder persisted (sort_order positions)",
    afterReorder.ok === true && afterReorder.data.map((t) => t.id).join("|") === `${ins.id}|${lic.id}|${mec.id}|${w9.id}`, JSON.stringify(afterReorder));
  check("reorder ignores foreign ids", (await reorderDocTypesCore(ACTOR, { orderedIds: ["dt-foreign", ins.id] })).ok === true);

  const tog = await setDocTypeActiveCore(ACTOR, { id: mec.id, active: false });
  check("toggle off (pause) MEC", tog.ok === true && tog.data.active === false, JSON.stringify(tog));
  const afterPause = await listRequiredDocTypesCore(ACTOR);
  check("paused type sinks to the end (active DESC first)",
    afterPause.ok === true && afterPause.data[0].id === ins.id && afterPause.data[3].id === mec.id && afterPause.data[3].active === false, JSON.stringify(afterPause));
  check("re-activate MEC", (await setDocTypeActiveCore(ACTOR, { id: mec.id, active: true })).ok === true);

  const rm = await removeDocTypeCore(ACTOR, { id: lic.id });
  check("soft-remove license (active=FALSE, row kept)", rm.ok === true, JSON.stringify(rm));
  const dbLic = await q`SELECT active FROM contractor_doc_types WHERE id=${lic.id}`;
  check("license row still exists, active=FALSE", dbLic.length === 1 && dbLic[0].active === false, JSON.stringify(dbLic));
  const afterRemove = await listRequiredDocTypesCore(ACTOR);
  check("removed type hidden from the required set (active list = 3)",
    afterRemove.ok === true && afterRemove.data.filter((t) => t.active).length === 3 && afterRemove.data.length === 4, JSON.stringify(afterRemove));
  check("remove missing id → not_found", (await removeDocTypeCore(ACTOR, { id: "dt-none" })).ok === false);

  const aud = await q`SELECT action FROM audit_log WHERE org_id=${ORG} AND action IN ('contractor_doc_type_renamed','contractor_doc_type_reordered','contractor_doc_type_toggled','contractor_doc_type_removed')`;
  check("audit: rename/reorder/toggle/remove rows exist", aud.length >= 4, JSON.stringify(aud));
}

/* ==================== 3) roster payload: payrate + compliance joins ==================== */
{
  const list = await listContractorsCore(ACTOR);
  const row = list.ok ? list.data.find((c) => c.id === DRIVER) : null;
  check("roster: payrateCents null + requiredDocCount 3 + onFileDocCount 0",
    list.ok === true && row && row.payrateCents === null && row.requiredDocCount === 3 && row.onFileDocCount === 0 &&
    row.payrateCents !== undefined && row.requiredDocCount !== undefined && row.onFileDocCount !== undefined, JSON.stringify(row));
  check("roster: seroval-safe (null never undefined)", row && Object.values(row).every((v) => v !== undefined), JSON.stringify(row));
}

/* ==================== 4) payrate: set / clear with audit ==================== */
{
  const set = await setContractorPayrateCore(ACTOR, { contractorId: DRIVER, payrateCents: 7500 });
  check("payrate set 7500", set.ok === true && set.data.payrateCents === 7500, JSON.stringify(set));
  const list = await listContractorsCore(ACTOR);
  const row = list.ok ? list.data.find((c) => c.id === DRIVER) : null;
  check("roster reflects payrate 7500", row && row.payrateCents === 7500, JSON.stringify(row));
  const aud = await q`SELECT detail FROM audit_log WHERE org_id=${ORG} AND action='contractor_payrate_set' ORDER BY occurred_at DESC LIMIT 1`;
  check("audit contractor_payrate_set with from/to",
    aud.length === 1 && aud[0].detail.from === null && aud[0].detail.to === 7500, JSON.stringify(aud));

  const adminSet = await setContractorPayrateCore(ADMIN_ACTOR, { contractorId: DRIVER, payrateCents: 8200 });
  check("admin can set payrate", adminSet.ok === true && adminSet.data.payrateCents === 8200, JSON.stringify(adminSet));

  const clear = await setContractorPayrateCore(ACTOR, { contractorId: DRIVER, payrateCents: null });
  check("payrate clear → null", clear.ok === true && clear.data.payrateCents === null, JSON.stringify(clear));
  const list2 = await listContractorsCore(ACTOR);
  const row2 = list2.ok ? list2.data.find((c) => c.id === DRIVER) : null;
  check("roster reflects cleared payrate", row2 && row2.payrateCents === null, JSON.stringify(row2));
  const aud2 = await q`SELECT detail FROM audit_log WHERE org_id=${ORG} AND action='contractor_payrate_set' ORDER BY occurred_at DESC LIMIT 1`;
  check("audit clear from/to", aud2.length === 1 && aud2[0].detail.from === 8200 && aud2[0].detail.to === null, JSON.stringify(aud2));

  check("payrate invalid (string) → invalid_input", (await setContractorPayrateCore(ACTOR, { contractorId: DRIVER, payrateCents: "75" })).ok === false);
  check("payrate negative → invalid_input", (await setContractorPayrateCore(ACTOR, { contractorId: DRIVER, payrateCents: -5 })).ok === false);
  check("payrate unknown contractor → not_found", (await setContractorPayrateCore(ACTOR, { contractorId: "nope", payrateCents: 100 })).ok === false);
  check("payrate contractor actor → unauthorized", (await setContractorPayrateCore(DRIVER_ACTOR, { contractorId: DRIVER, payrateCents: 100 })).ok === false);
}

/* ==================== 5) derived status: MISSING → upload → verified/rejected/expired ==================== */
const b2 = makeFetch();
{
  const docs0 = await listContractorDocumentsCore(ACTOR, { contractorId: DRIVER });
  check("docs: 3 active types all MISSING (license soft-removed excluded)",
    docs0.ok === true && docs0.data.length === 3 && docs0.data.every((d) => d.status === "missing" && d.docId === null), JSON.stringify(docs0));
  check("docs: unknown contractor → not_found", (await listContractorDocumentsCore(ACTOR, { contractorId: "nope" })).ok === false);
  check("docs: contractor actor (owner fn) → unauthorized", (await listContractorDocumentsCore(DRIVER_ACTOR, { contractorId: DRIVER })).ok === false);

  // Upload W-9 as a PDF and Insurance Certificate as a JPG with a future expiry.
  const up1 = await uploadMyDocumentCore(DRIVER_ACTOR, { docTypeId: w9.id, dataUrl: PDF_1KB, fileName: "w9.pdf", expiresOn: "" }, { fetchImpl: b2.fetchImpl });
  check("upload W-9 PDF", up1.ok === true && up1.status === "uploaded" && up1.storageKey === `ld-docs/${ORG}/${DRIVER}/${w9.id}.pdf`, JSON.stringify(up1));
  check("B2 object stored under ld-docs key (mock S3 keys carry the bucket prefix)", b2.objects.has(`qa-bucket/${up1.storageKey}`), [...b2.objects.keys()].join(","));
  const up2 = await uploadMyDocumentCore(DRIVER_ACTOR, { docTypeId: ins.id, dataUrl: JPG_1KB, fileName: "ins.jpg", expiresOn: "2099-12-31" }, { fetchImpl: b2.fetchImpl });
  check("upload Insurance Certificate JPG with future expiry", up2.ok === true && up2.expiresOn === "2099-12-31", JSON.stringify(up2));

  const docs1 = await listContractorDocumentsCore(ACTOR, { contractorId: DRIVER });
  const w9row = docs1.ok ? docs1.data.find((d) => d.docTypeId === w9.id) : null;
  const insRow = docs1.ok ? docs1.data.find((d) => d.docTypeId === ins.id) : null;
  check("docs after upload: W-9 UPLOADED with meta", w9row && w9row.status === "uploaded" && w9row.fileName === "w9.pdf" && w9row.mime === "application/pdf" && w9row.sizeBytes > 1000, JSON.stringify(w9row));
  check("docs after upload: insurance UPLOADED with future expiry", insRow && insRow.status === "uploaded" && insRow.expiresOn === "2099-12-31", JSON.stringify(insRow));

  // Read the file back — byte-identical round trip.
  const got = await getDocumentFileCore(ACTOR, { docId: w9row.docId }, { fetchImpl: b2.fetchImpl });
  const orig = PDF_1KB.split(",")[1];
  check("getDocumentFile round-trips base64", got.ok === true && got.data.mime === "application/pdf" && got.data.base64 === orig, JSON.stringify({ ok: got.ok, mime: got.ok ? got.data.mime : "", same: got.ok ? got.data.base64 === orig : false }));
  check("getDocumentFile unknown doc → not_found", (await getDocumentFileCore(ACTOR, { docId: "doc-none" }, { fetchImpl: b2.fetchImpl })).ok === false);

  // Cross-contractor read → 403 semantics.
  const cross = await getDocumentFileCore(OTHER_DRIVER_ACTOR, { docId: w9row.docId }, { fetchImpl: b2.fetchImpl });
  check("cross-contractor getDocumentFile → unauthorized", cross.ok === false && cross.code === "unauthorized", JSON.stringify(cross));
  const own = await getDocumentFileCore(DRIVER_ACTOR, { docId: w9row.docId }, { fetchImpl: b2.fetchImpl });
  check("owner-own getDocumentFile allowed (contractor reads own doc)", own.ok === true, JSON.stringify(own));
  check("wrong-org getDocumentFile → not_found", (await getDocumentFileCore(WRONG_ORG_ACTOR, { docId: w9row.docId }, { fetchImpl: b2.fetchImpl })).ok === false);

  // Verify → VERIFIED.
  const ver = await setDocumentStatusCore(ACTOR, { docId: w9row.docId, status: "verified" });
  check("verify W-9", ver.ok === true && ver.data.status === "verified", JSON.stringify(ver));
  // Reject the insurance with a review note → REJECTED (note shown to driver).
  const rej = await setDocumentStatusCore(ACTOR, { docId: insRow.docId, status: "rejected", reviewNote: "Blurry — please retake" });
  check("reject insurance", rej.ok === true && rej.data.status === "rejected", JSON.stringify(rej));

  const docs2 = await listContractorDocumentsCore(ACTOR, { contractorId: DRIVER });
  const w9v = docs2.ok ? docs2.data.find((d) => d.docTypeId === w9.id) : null;
  const insR = docs2.ok ? docs2.data.find((d) => d.docTypeId === ins.id) : null;
  check("docs: W-9 VERIFIED, insurance REJECTED with note",
    w9v && w9v.status === "verified" && insR && insR.status === "rejected" && insR.reviewNote === "Blurry — please retake", JSON.stringify([w9v, insR]));
  check("audit contractor_doc_verified + contractor_doc_rejected",
    (await q`SELECT action FROM audit_log WHERE org_id=${ORG} AND action IN ('contractor_doc_verified','contractor_doc_rejected')`).length === 2);

  // Date wins: push the VERIFIED W-9's expiry into the past → derived EXPIRED.
  const exp = await setDocumentExpiryCore(ACTOR, { docId: w9row.docId, expiresOn: "2020-06-15" });
  check("set expiry to past date", exp.ok === true && exp.data.expiresOn === "2020-06-15", JSON.stringify(exp));
  const docs3 = await listContractorDocumentsCore(ACTOR, { contractorId: DRIVER });
  const w9e = docs3.ok ? docs3.data.find((d) => d.docTypeId === w9.id) : null;
  check("derived status: stored verified + past expiry → EXPIRED (date wins)", w9e && w9e.status === "expired" && w9e.expiresOn === "2020-06-15", JSON.stringify(w9e));
  check("audit contractor_doc_expiry_set",
    (await q`SELECT action FROM audit_log WHERE org_id=${ORG} AND action='contractor_doc_expiry_set'`).length >= 1);

  // Clear the expiry → back to VERIFIED (stored status resurfaces).
  await setDocumentExpiryCore(ACTOR, { docId: w9row.docId, expiresOn: "" });
  const docs4 = await listContractorDocumentsCore(ACTOR, { contractorId: DRIVER });
  const w9v2 = docs4.ok ? docs4.data.find((d) => d.docTypeId === w9.id) : null;
  check("cleared expiry → VERIFIED again", w9v2 && w9v2.status === "verified" && w9v2.expiresOn === null, JSON.stringify(w9v2));

  // Force expired via status.
  await setDocumentStatusCore(ACTOR, { docId: w9row.docId, status: "expired" });
  const docs5 = await listContractorDocumentsCore(ACTOR, { contractorId: DRIVER });
  const w9f = docs5.ok ? docs5.data.find((d) => d.docTypeId === w9.id) : null;
  check("stored status expired → EXPIRED", w9f && w9f.status === "expired", JSON.stringify(w9f));

  // Re-upload replaces the same slot (upsert) and resets to uploaded.
  const up3 = await uploadMyDocumentCore(DRIVER_ACTOR, { docTypeId: w9.id, dataUrl: PNG_1KB, fileName: "w9-v2.png", expiresOn: "" }, { fetchImpl: b2.fetchImpl });
  check("re-upload W-9 (replace)", up3.ok === true && up3.storageKey === `ld-docs/${ORG}/${DRIVER}/${w9.id}.png`, JSON.stringify(up3));
  const cnt = await q`SELECT COUNT(*)::int AS n FROM contractor_documents WHERE org_id=${ORG} AND contractor_id=${DRIVER} AND doc_type_id=${w9.id}`;
  check("re-upload upserts ONE row per (contractor, type)", Number(cnt[0].n) === 1, JSON.stringify(cnt));
  const docs6 = await listContractorDocumentsCore(ACTOR, { contractorId: DRIVER });
  const w9r = docs6.ok ? docs6.data.find((d) => d.docTypeId === w9.id) : null;
  check("re-upload resets status to UPLOADED (re-review) + clears review_note",
    w9r && w9r.status === "uploaded" && w9r.fileName === "w9-v2.png" && w9r.reviewNote === null, JSON.stringify(w9r));
  check("audit contractor_doc_uploaded rows ≥ 3",
    (await q`SELECT COUNT(*)::int AS n FROM audit_log WHERE org_id=${ORG} AND action='contractor_doc_uploaded'`)[0].n >= 3);

  // Upload validation rails.
  check("upload bad mime → invalid_input", (await uploadMyDocumentCore(DRIVER_ACTOR, { docTypeId: w9.id, dataUrl: "data:text/plain;base64," + Buffer.from("hello").toString("base64") }, { fetchImpl: b2.fetchImpl })).ok === false);
  check("upload <1KB → invalid_input", (await uploadMyDocumentCore(DRIVER_ACTOR, { docTypeId: w9.id, dataUrl: TINY }, { fetchImpl: b2.fetchImpl })).ok === false);
  // "A" base64 chars decode 4→3 bytes: need >16_777_216 chars to exceed 12 MB.
  const BIG = "data:image/png;base64," + "A".repeat(18 * 1024 * 1024);
  check("upload >12MB → invalid_input", (await uploadMyDocumentCore(DRIVER_ACTOR, { docTypeId: w9.id, dataUrl: BIG }, { fetchImpl: b2.fetchImpl })).ok === false);
  check("upload inactive type → not_found", (await uploadMyDocumentCore(DRIVER_ACTOR, { docTypeId: lic.id, dataUrl: PNG_1KB }, { fetchImpl: b2.fetchImpl })).ok === false);
  check("upload other-org type → not_found", (await uploadMyDocumentCore(WRONG_DRIVER_ACTOR, { docTypeId: w9.id, dataUrl: PNG_1KB }, { fetchImpl: b2.fetchImpl })).ok === false);
  check("upload invalid expiry format → invalid_input", (await uploadMyDocumentCore(DRIVER_ACTOR, { docTypeId: ins.id, dataUrl: JPG_1KB, expiresOn: "12/31/2026" }, { fetchImpl: b2.fetchImpl })).ok === false);
  check("owner cannot upload (contractor-own fn)", (await uploadMyDocumentCore(ACTOR, { docTypeId: w9.id, dataUrl: PNG_1KB }, { fetchImpl: b2.fetchImpl })).ok === false);

  // decodeDocumentDataUrl allowlist (PDF branch + image-only rejection).
  check("decode: PDF allowed", decodeDocumentDataUrl(PDF_1KB)?.mime === "application/pdf");
  check("decode: jpeg/png/webp allowed", decodeDocumentDataUrl(JPG_1KB)?.mime === "image/jpeg" && decodeDocumentDataUrl(PNG_1KB)?.mime === "image/png" && decodeDocumentDataUrl("data:image/webp;base64," + Buffer.from("x".repeat(2000)).toString("base64"))?.mime === "image/webp");
  check("decode: text/plain rejected", decodeDocumentDataUrl("data:text/plain;base64,aGk=") === null);
  check("decode: garbage rejected", decodeDocumentDataUrl("not-a-data-url") === null);
  check("deriveDocStatus: date wins over verified", deriveDocStatus("verified", "2000-01-01") === "expired");
  check("deriveDocStatus: future date keeps verified", deriveDocStatus("verified", "2099-01-01") === "verified");
  check("deriveDocStatus: stored expired", deriveDocStatus("expired", null) === "expired");
  check("deriveDocStatus: rejected", deriveDocStatus("rejected", null) === "rejected");
}

/* ==================== 6) compliance counts + roster aggregate ==================== */
{
  // Now: 3 required active types; driver has insurance REJECTED + W-9 UPLOADED → onFile 1 (insurance rejected is NOT on file).
  const comp = await listContractorComplianceCore(ACTOR);
  const row = comp.ok ? comp.data.find((c) => c.contractorId === DRIVER) : null;
  check("compliance: driver required 3, onFile 1 (rejected not counted)",
    comp.ok === true && row && row.requiredDocCount === 3 && row.onFileDocCount === 1, JSON.stringify(row));
  const roster = await listContractorsCore(ACTOR);
  const rrow = roster.ok ? roster.data.find((c) => c.id === DRIVER) : null;
  check("roster aggregate matches compliance", rrow && rrow.requiredDocCount === 3 && rrow.onFileDocCount === 1, JSON.stringify(rrow));
  check("compliance: contractor actor → unauthorized", (await listContractorComplianceCore(DRIVER_ACTOR)).ok === false);

  // getMyDocuments — session-scoped self view.
  const mine = await getMyDocumentsCore(DRIVER_ACTOR);
  check("getMyDocuments returns own 3 rows (W-9 uploaded, ins rejected, MEC missing)",
    mine.ok === true && mine.data.length === 3 &&
    mine.data.find((d) => d.docTypeId === w9.id)?.status === "uploaded" &&
    mine.data.find((d) => d.docTypeId === ins.id)?.status === "rejected" &&
    mine.data.find((d) => d.docTypeId === mec.id)?.status === "missing", JSON.stringify(mine));
  check("getMyDocuments owner actor → unauthorized", (await getMyDocumentsCore(ACTOR)).ok === false);
}

/* ==================== 7) org isolation ==================== */
{
  const docs = await listContractorDocumentsCore(WRONG_ORG_ACTOR, { contractorId: DRIVER });
  check("other org cannot read our contractor's docs → not_found", docs.ok === false && docs.code === "not_found", JSON.stringify(docs));
  const types = await listRequiredDocTypesCore(WRONG_ORG_ACTOR);
  check("other org sees its own (empty) types", types.ok === true && types.data.length === 0, JSON.stringify(types));
  const roster = await listContractorsCore(WRONG_ORG_ACTOR);
  check("other org roster: driver2 present with zero counts",
    roster.ok === true && roster.data.length === 1 && roster.data[0].id === DRIVER2 && roster.data[0].requiredDocCount === 0 && roster.data[0].onFileDocCount === 0, JSON.stringify(roster));
}

/* ================================ summary + cleanup ================================ */
const failed = checks.filter(([, ok]) => !ok);
console.log(`contractor-admin.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }
process.env.B2_KEY_ID = SAVED_B2.k; process.env.B2_APPLICATION_KEY = SAVED_B2.a; process.env.B2_BUCKET_NAME = SAVED_B2.b;
const memberIds = await q`SELECT DISTINCT m.user_id FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa contractor-admin%'`;
for (const org of await q`SELECT id FROM organizations WHERE name LIKE 'qa contractor-admin%'`) {
  await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
}
for (const m of memberIds) await q`DELETE FROM users WHERE id=${m.user_id}`.catch(() => {});
await q`DELETE FROM users WHERE email LIKE 'qa-ca-%@lightning.test'`.catch(() => {});
const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa contractor-admin%') AS orgs,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE 'qa-ca-%@lightning.test') AS users,
  (SELECT COUNT(*)::int FROM contractor_doc_types t JOIN organizations o ON o.id=t.org_id WHERE o.name LIKE 'qa contractor-admin%') AS types,
  (SELECT COUNT(*)::int FROM contractor_documents d JOIN organizations o ON o.id=d.org_id WHERE o.name LIKE 'qa contractor-admin%') AS docs,
  (SELECT COUNT(*)::int FROM contractor_profiles p JOIN organizations o ON o.id=p.org_id WHERE o.name LIKE 'qa contractor-admin%') AS profiles,
  (SELECT COUNT(*)::int FROM audit_log a JOIN organizations o ON o.id=a.org_id WHERE o.name LIKE 'qa contractor-admin%') AS audit,
  (SELECT COUNT(*)::int FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa contractor-admin%') AS members`;
const z = Object.values(leftover[0]).every((n) => Number(n) === 0);
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) { console.error("FAIL: QA cleanup left rows behind"); process.exit(1); }
console.log("contractor-admin.test.mjs: cleanup verified — zero QA rows left");
