// Hermetic fillable-forms test suite (2026-08-12): W-9/I-9 official forms.
//   DATABASE_URL=... bun form-tests.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
process.env.TOWBOOK_SESSION_KEY = Buffer.alloc(32, 9).toString("base64");
const { submitW9FormCore, submitI9FormCore, getFormSubmissionCore, getFormDocFileCore, reviewI9Section2Core } = await import("./src/data/form-docs-core.ts");
const { getMyComplianceCore, getDocumentFileCore, setDocumentStatusCore, getComplianceGateCore } = await import("./src/data/contractor-admin-core.ts");
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const checks = [];
const check = (n, c, x = "") => { checks.push([n, Boolean(c), x]); if (!c) throw new Error(`FAIL ${n} ${x}`); };
const TAG = randomUUID();
const ORG = `qa-forms-${TAG}`, OWNER = `qa-forms-o-${TAG}`, DRIVER = `qa-forms-d-${TAG}`;
// NOTE: the email must be ONE template expression — `${OWNER}@qa.local`
// would split into param + literal "@qa.local", which Postgres parses as a
// table reference ("missing FROM-clause entry for table qa").
const OWNER_EMAIL = `${OWNER}@qa.local`, DRIVER_EMAIL = `${DRIVER}@qa.local`;
const OWNER_A = { orgId: ORG, id: OWNER, role: "owner" };
const DRIVER_A = { orgId: ORG, id: DRIVER, role: "contractor" };
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
// mm/dd/yyyy (the official forms validate /^\d{2}\/\d{2}\/\d{4}$/)
const mdy = (d) => { const dt = new Date(Date.now() + d * 86400000); return `${String(dt.getMonth() + 1).padStart(2, "0")}/${String(dt.getDate()).padStart(2, "0")}/${dt.getFullYear()}`; };
// Identity-doc upload: a data URL the core decodes (>1 KB, allowed mime)
const PNG = `data:image/png;base64,${Buffer.alloc(4096, 1).toString("base64")}`;
await ensureSchema();
await q`INSERT INTO organizations(id, name) VALUES(${ORG}, 'qa-forms')`;
await q`INSERT INTO users(id, name, email, password_hash) VALUES(${OWNER}, 'QA Owner', ${OWNER_EMAIL}, 'qa-hash'), (${DRIVER}, 'QA Driver', ${DRIVER_EMAIL}, 'qa-hash')`;
await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${OWNER}, 'owner'), (${ORG}, ${DRIVER}, 'contractor')`;
const SSN = "123456789"; // W-9 taxId + I-9 ssn validators require /^[0-9]{9}$/ (no dashes)
const w9id = `dt-w9-${TAG}`;
const i9id = `dt-i9-${TAG}`;
await q`INSERT INTO contractor_doc_types(id, org_id, name, requires_expiry, requires_facial_verification, form_kind, sort_order) VALUES(${w9id}, ${ORG}, 'W-9', FALSE, FALSE, 'w9', 1), (${i9id}, ${ORG}, 'I-9', FALSE, FALSE, 'i9', 2)`;
const w9 = await submitW9FormCore(DRIVER_A, {
  docTypeId: w9id, name: "QA Driver", taxClassification: "individual", address: "1 Main St", city: "Bridgeport", state: "CT", zip: "06606",
  taxIdType: "ssn", taxId: SSN, signature: "QA Driver",
});
check("w9 submit ok", w9.ok, JSON.stringify(w9).slice(0, 200));
const w9rows = await q`SELECT payload, tax_id_encrypted FROM contractor_form_submissions WHERE org_id=${ORG} AND doc_type_id=${w9id}`;
check("w9 tax id encrypted at rest", w9rows.length === 1 && typeof w9rows[0].tax_id_encrypted === "string" && w9rows[0].tax_id_encrypted.length > 20, "no ciphertext");
const payloadStr = JSON.stringify(w9rows[0].payload);
// NOTE: the payload legitimately carries the KEY `taxIdType` — the leak check
// must look for the SSN VALUE, not the word "taxid".
check("w9 tax id NOT in payload", !payloadStr.includes(SSN) && !payloadStr.includes("6789"), payloadStr.slice(0, 120));
// audit_log (NOT audit_logs) is the real table; the LIKE covers BOTH the
// contractor_form_submitted rows (where a tax-id leak would actually appear)
// and the contractor_doc_* review rows.
const audit = await q`SELECT detail FROM audit_log WHERE org_id=${ORG} AND action LIKE 'contractor_%'`;
check("w9 tax id NOT in audit", !JSON.stringify(audit).includes("6789"), "audit leak");
const own = await getFormSubmissionCore(OWNER_A, { contractorId: DRIVER, docTypeId: w9id });
check("owner read decrypts tax id", own.ok && own.data.taxId === SSN, own.ok ? String(own.data.taxId) : own.message);
const drv = await getFormSubmissionCore(DRIVER_A, { docTypeId: w9id });
check("driver read SSN-free", drv.ok && drv.data.taxId === null && !JSON.stringify(drv.data).includes("6789"), "driver saw ssn");
// I-9 Section 1: List A alone, B+C, B-only rejected
const base9 = { docTypeId: i9id, lastName: "Driver", firstName: "QA", address: "1 Main St", city: "Bridgeport", state: "CT", zip: "06606", dob: "01/01/1990", ssn: SSN, email: "d@qa.local", phone: "5550101", citizenship: "citizen", signature: "QA Driver", date: mdy(0) };
const i9a = await submitI9FormCore(DRIVER_A, { ...base9, identityDocs: [{ list: "A", title: "Passport", issuingAuthority: "US DOS", number: "X123", expiration: mdy(3650), dataUrl: PNG }] });
check("i9 List A accepted", i9a.ok, JSON.stringify(i9a).slice(0, 200));
const i9b = await submitI9FormCore(DRIVER_A, { ...base9, identityDocs: [{ list: "B", title: "Driver License", issuingAuthority: "CT DMV", number: "DL1", expiration: mdy(365), dataUrl: PNG }, { list: "C", title: "SS Card", issuingAuthority: "SSA", number: "SS1", expiration: "", dataUrl: PNG }] });
check("i9 List B+C accepted", i9b.ok, JSON.stringify(i9b).slice(0, 200));
const i9bad = await submitI9FormCore(DRIVER_A, { ...base9, identityDocs: [{ list: "B", title: "Driver License", issuingAuthority: "CT DMV", number: "DL1", expiration: mdy(365), dataUrl: PNG }] });
check("i9 B-only REJECTED", !i9bad.ok, JSON.stringify(i9bad).slice(0, 200));
const i9s = await q`SELECT s.id AS sid FROM contractor_form_submissions s WHERE s.org_id=${ORG} AND s.doc_type_id=${i9id} ORDER BY s.updated_at DESC LIMIT 1`;
const subId = String(i9s[0].sid);
const docrow = await q`SELECT id FROM contractor_documents WHERE org_id=${ORG} AND doc_type_id=${i9id} LIMIT 1`;
const docId = String(docrow[0].id);
const s2 = await reviewI9Section2Core(OWNER_A, { docId, approve: true, repName: "QA Owner", repTitle: "Owner", reviewNote: "" });
check("owner section2 approve ok", s2.ok && s2.data.status === "verified", JSON.stringify(s2).slice(0, 160));
const s2rows = await q`SELECT section2, pdf_storage_key FROM contractor_form_submissions WHERE id=${subId}`;
check("section2 recorded + pdf regenerated", s2rows[0].section2 != null && typeof s2rows[0].pdf_storage_key === "string" && s2rows[0].pdf_storage_key.length > 10, "s2/pdf");
const vrows = await q`SELECT status FROM contractor_documents WHERE id=${docId}`;
check("doc flipped verified", String(vrows[0].status) === "verified");
// Contractor read of the completed form PDF is refused (owner-only)
const pdfRead = await getDocumentFileCore(DRIVER_A, { docId });
check("contractor form-pdf read refused", !pdfRead.ok, JSON.stringify(pdfRead).slice(0, 120));
const pdfReadOwner = await getDocumentFileCore(OWNER_A, { docId });
check("owner form-pdf read allowed", pdfReadOwner.ok && pdfReadOwner.data.base64.length > 100, "owner pdf bytes");
// W-9 doc: the OWNER verifies through the real owner path — the same
// setDocumentStatus('verified') call the owner Documents UI makes.
const w9docrow = await q`SELECT id FROM contractor_documents WHERE org_id=${ORG} AND doc_type_id=${w9id} LIMIT 1`;
check("w9 doc row exists", w9docrow.length === 1, JSON.stringify(w9docrow));
const w9docId = String(w9docrow[0].id);
const w9ver = await setDocumentStatusCore(OWNER_A, { docId: w9docId, status: "verified", reviewNote: "" });
check("owner verifies W-9 doc through owner path", w9ver.ok && w9ver.data.status === "verified", JSON.stringify(w9ver).slice(0, 160));
const w9vrows = await q`SELECT status FROM contractor_documents WHERE id=${w9docId}`;
check("w9 doc flipped verified", String(w9vrows[0].status) === "verified");
// Compliance gate: the org's only active types are the two FORM docs; after
// both are verified (W-9 via the owner doc-review path above, I-9 via the
// Section-2 approval) the gate opens — submitted AND approved.
const gate = await getComplianceGateCore(DRIVER_A);
check("compliance gate open after verified forms", gate.ok === true, JSON.stringify(gate));
const comp = await getMyComplianceCore(DRIVER_A);
check("both forms approved 2/2", comp.ok && comp.data.approved === 2 && comp.data.required === 2, JSON.stringify(comp).slice(0, 200));
// zero QA rows after (delete under guard); audit_log references users(id),
// so it must go before the users delete
await q`DELETE FROM audit_log WHERE org_id=${ORG}`;
await q`DELETE FROM contractor_form_docs WHERE org_id=${ORG}`;
await q`DELETE FROM contractor_form_submissions WHERE org_id=${ORG}`;
await q`DELETE FROM contractor_documents WHERE org_id=${ORG}`;
await q`DELETE FROM contractor_doc_types WHERE org_id=${ORG}`;
await q`DELETE FROM organization_memberships WHERE org_id=${ORG}`;
await q`DELETE FROM users WHERE id IN (${OWNER}, ${DRIVER})`;
await assertQaOrg(ORG);
await q`DELETE FROM organizations WHERE id=${ORG}`;
const leftover = await q`SELECT (SELECT count(*) FROM organizations WHERE id=${ORG}) AS orgs, (SELECT count(*) FROM contractor_form_submissions WHERE org_id=${ORG}) AS subs, (SELECT count(*) FROM contractor_doc_types WHERE org_id=${ORG}) AS types`;
check("zero QA rows after", Number(leftover[0].orgs) === 0 && Number(leftover[0].subs) === 0 && Number(leftover[0].types) === 0, JSON.stringify(leftover[0]));
console.log(`form-tests.test.mjs: ${checks.length}/${checks.length} passed`);
