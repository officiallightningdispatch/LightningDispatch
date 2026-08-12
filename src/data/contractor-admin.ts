/**
 * Contractor administration (owner-directed 2026-08-11, plan rev 17) —
 * CLIENT-SAFE FACADE.
 *
 * This module is the ONLY piece of the contractor-admin feature imported by
 * client code (owner portal / contractor app). It defines the createServerFn
 * server functions; their handlers dynamic-import the SERVER-ONLY core
 * (./contractor-admin-core.ts) so the client bundle never pulls in b2-client /
 * auth-server / db code. No other exports — the core owns all logic (see the
 * client-graph rule that has broken the build before).
 */
import { createServerFn } from "@tanstack/react-start";
import type {
  ContractorAdminResult,
  ContractorComplianceRow,
  ContractorContactResult,
  ContractorDetailRow,
  ContractorDocumentRow,
  ContractorScheduleRow,
  ContractorVehicleResult,
  DocFilePayload,
  DocTypeRow,
  FormSubmissionView,
  MyCompliance,
  SubmitFormResult,
  UploadDocumentResult,
  UploadSelfieResult,
} from "./contractor-admin-core";
export type {
  ContractorAdminResult,
  ContractorComplianceRow,
  ContractorContactResult,
  ContractorDetailRow,
  ContractorDocumentRow,
  ContractorScheduleRow,
  ContractorVehicle,
  ContractorVehicleResult,
  DocFilePayload,
  DocStatus,
  DocTypeRow,
  FormSubmissionView,
  MyCompliance,
  UploadDocumentResult,
  UploadSelfieResult,
} from "./contractor-admin-core";

const passthrough = (x: unknown) => x;

/* ------------------------------ doc types (owner) ------------------------------ */

export const listRequiredDocTypes = createServerFn({ method: "GET" }).handler(async (): Promise<ContractorAdminResult<DocTypeRow[]>> => {
  const core = await import("./contractor-admin-core");
  return core.listRequiredDocTypesHandler();
});

export const addDocType = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<ContractorAdminResult<DocTypeRow>> => {
  const core = await import("./contractor-admin-core");
  return core.addDocTypeHandler(data);
});

export const renameDocType = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<ContractorAdminResult<DocTypeRow>> => {
  const core = await import("./contractor-admin-core");
  return core.renameDocTypeHandler(data);
});

export const removeDocType = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<ContractorAdminResult<{ id: string }>> => {
  const core = await import("./contractor-admin-core");
  return core.removeDocTypeHandler(data);
});

export const setDocTypeActive = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<ContractorAdminResult<{ id: string; active: boolean }>> => {
  const core = await import("./contractor-admin-core");
  return core.setDocTypeActiveHandler(data);
});

export const reorderDocTypes = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<ContractorAdminResult<{ reordered: number }>> => {
  const core = await import("./contractor-admin-core");
  return core.reorderDocTypesHandler(data);
});

/* ------------------------------ documents (owner) ------------------------------ */

export const listContractorDocuments = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<ContractorAdminResult<ContractorDocumentRow[]>> => {
  const core = await import("./contractor-admin-core");
  return core.listContractorDocumentsHandler(data);
});

export const setDocumentStatus = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<ContractorAdminResult<{ docId: string; status: ContractorDocumentRow["status"] }>> => {
  const core = await import("./contractor-admin-core");
  return core.setDocumentStatusHandler(data);
});

export const setDocumentExpiry = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<ContractorAdminResult<{ docId: string; expiresOn: string | null }>> => {
  const core = await import("./contractor-admin-core");
  return core.setDocumentExpiryHandler(data);
});

export const getDocumentFile = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<ContractorAdminResult<DocFilePayload>> => {
  const core = await import("./contractor-admin-core");
  return core.getDocumentFileHandler(data);
});

/* ---------------------------------- payrate ---------------------------------- */

export const setContractorPayrate = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<ContractorAdminResult<{ contractorId: string; payrateCents: number | null }>> => {
  const core = await import("./contractor-admin-core");
  return core.setContractorPayrateHandler(data);
});

/* --------------------------------- compliance --------------------------------- */

export const listContractorCompliance = createServerFn({ method: "GET" }).handler(async (): Promise<ContractorAdminResult<ContractorComplianceRow[]>> => {
  const core = await import("./contractor-admin-core");
  return core.listContractorComplianceHandler();
});

/* --------------------------- contractor detail (owner) --------------------------- */

export const getContractorDetail = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<ContractorAdminResult<ContractorDetailRow>> => {
  const core = await import("./contractor-admin-core");
  return core.getContractorDetailHandler(data);
});

/** Update the LD-only contact fields (phone + vehicle description) — never
 *  pushed to Towbook. Owner/admin only. */
export const setContractorContact = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<ContractorAdminResult<ContractorContactResult>> => {
  const core = await import("./contractor-admin-core");
  return core.setContractorContactHandler(data);
});

/* ---------------------------- contractor-own documents ---------------------------- */

export const getMyDocuments = createServerFn({ method: "GET" }).handler(async (): Promise<ContractorAdminResult<ContractorDocumentRow[]>> => {
  const core = await import("./contractor-admin-core");
  return core.getMyDocumentsHandler();
});

export const uploadMyDocument = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<UploadDocumentResult> => {
  const core = await import("./contractor-admin-core");
  return core.uploadMyDocumentHandler(data);
});

/** Upload the live selfie half of a facial-verification pair (driver-only;
 *  part 3, owner-directed 2026-08-12). */
export const uploadMySelfie = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<UploadSelfieResult> => {
  const core = await import("./contractor-admin-core");
  return core.uploadMySelfieHandler(data);
});

/** Read a stored selfie (owner: any contractor's; driver: own only). */
export const getSelfieFile = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<ContractorAdminResult<DocFilePayload>> => {
  const core = await import("./contractor-admin-core");
  return core.getSelfieFileHandler(data);
});

/** The acting driver's compliance snapshot (counts + names) — Home compliance
 *  chip + Documents screen header. */
export const getMyCompliance = createServerFn({ method: "GET" }).handler(async (): Promise<ContractorAdminResult<MyCompliance>> => {
  const core = await import("./contractor-admin-core");
  return core.getMyComplianceHandler();
});

/** GO/Offline compliance gate (owner-directed 2026-08-12): ok when every
 *  active required type is approved; docs_incomplete + driver-facing message
 *  otherwise. */
export const getComplianceGate = createServerFn({ method: "GET" }).handler(async (): Promise<{ ok: true } | { ok: false; code: "docs_incomplete"; approved: number; required: number; message: string }> => {
  const core = await import("./contractor-admin-core");
  return core.getComplianceGateHandler();
});

/** Idempotently add the owner-mandated required doc set (W-9, I-9, Driver's
 *  license with facial verification, Insurance information) to this org. */
export const seedMandatedDocTypes = createServerFn({ method: "POST" }).handler(async (): Promise<ContractorAdminResult<DocTypeRow[]>> => {
  const core = await import("./contractor-admin-core");
  return core.seedMandatedDocTypesHandler();
});

/* ------------------- structured vehicle + schedule (contractor v2) ------------------- */

/** Save a contractor's structured vehicle (LD-only; Towbook has no vehicle
 *  data). Overwrites the legacy vehicle_desc with the generated display string
 *  when any structured field is set. Owner/admin only. */
export const setContractorVehicle = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<ContractorAdminResult<ContractorVehicleResult>> => {
  const core = await import("./contractor-admin-core");
  return core.setContractorVehicleHandler(data);
});

/** Owner/admin: read one contractor's weekly schedule (+ who owns it). */
export const getContractorSchedule = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<ContractorAdminResult<ContractorScheduleRow>> => {
  const core = await import("./contractor-admin-core");
  return core.getContractorScheduleHandler(data);
});

/** Owner/admin: set (or clear) a contractor's schedule — takes over ownership
 *  (source='owner', owner_override=TRUE; driver edits stop applying). */
export const setContractorSchedule = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<ContractorAdminResult<ContractorScheduleRow>> => {
  const core = await import("./contractor-admin-core");
  return core.setContractorScheduleHandler(data);
});

/** The acting driver's own schedule (contractor-declared; resolves through the
 *  effective-driver resolver, so an owner in driver view edits their own
 *  contractor identity's schedule). */
export const getMySchedule = createServerFn({ method: "GET" }).handler(async (): Promise<ContractorAdminResult<ContractorScheduleRow>> => {
  const core = await import("./contractor-admin-core");
  return core.getMyScheduleHandler();
});

/** The acting driver declares their own weekly availability. Refused while the
 *  owner has overridden the schedule ("Set by owner"). */
export const setMySchedule = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<ContractorAdminResult<ContractorScheduleRow>> => {
  const core = await import("./contractor-admin-core");
  return core.setMyScheduleHandler(data);
});

/* ------- official fillable forms (W-9 + I-9; owner-directed 2026-08-12) ------- */
// Driver fills the OFFICIAL W-9 / I-9 in-app (form docs); the completed
// official-form PDF is stored to private B2. W-9 SSN/EIN + I-9 SSN are
// encrypted at rest and NEVER render back to the driver (owner-only).

export const submitW9Form = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(async ({ data }): Promise<SubmitFormResult> => core.submitW9FormHandler(data));

export const submitI9Form = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(async ({ data }): Promise<SubmitFormResult> => core.submitI9FormHandler(data));

export const getFormSubmission = createServerFn({ method: "GET" })
  .validator(passthrough)
  .handler(async ({ data }): Promise<ContractorAdminResult<FormSubmissionView>> => core.getFormSubmissionHandler(data));

export const getFormDocFile = createServerFn({ method: "GET" })
  .validator(passthrough)
  .handler(async ({ data }): Promise<ContractorAdminResult<DocFilePayload>> => core.getFormDocFileHandler(data));

export const reviewI9Section2 = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(async ({ data }): Promise<ContractorAdminResult<{ docId: string; status: "verified" | "rejected" }>> => core.reviewI9Section2Handler(data));
