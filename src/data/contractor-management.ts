/**
 * Contractor management + Towbook driver import (plan milestone 2) —
 * CLIENT-SAFE FACADE.
 *
 * This module is the ONLY piece of the contractor-management feature imported
 * by client code (owner portal). It defines the createServerFn server
 * functions; their handlers dynamic-import the SERVER-ONLY core
 * (./contractor-management-core.ts) so the client bundle never pulls in
 * towbook-key / auth-server / db code. No other exports — the core owns all
 * logic (see the client-graph rule that has broken the build before).
 */
import { createServerFn } from "@tanstack/react-start";
import type { ContractorManagementResult, ContractorRow, ImportSummary } from "./contractor-management-core";
export type { ContractorRow, ContractorStatus, ImportSummary, ImportSkip } from "./contractor-management-core";

const passthrough = (x: unknown) => x;

/** All contractor accounts (role 'contractor') in the owner's org with
 *  sign-in status derived from the driver-session rows. Owner/admin only. */
export const listContractors = createServerFn({ method: "GET" }).handler(async (): Promise<ContractorManagementResult<ContractorRow[]>> => {
  const core = await import("./contractor-management-core");
  return core.listContractorsHandler();
});

/** Add one contractor manually (name + Towbook driver ID + optional email).
 *  Duplicates return a clear error, never a crash. Owner/admin only. */
export const addContractor = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<ContractorManagementResult<ContractorRow>> => {
  const core = await import("./contractor-management-core");
  return core.addContractorHandler(data);
});

/** Bulk-import the real contractor list from Towbook via the owner's connected
 *  session (GET /api/drivers, no Towbook writes). Returns imported/updated/
 *  skipped counts. Owner/admin only. */
export const importContractors = createServerFn({ method: "POST" }).handler(async (): Promise<ContractorManagementResult<ImportSummary>> => {
  const core = await import("./contractor-management-core");
  return core.importContractorsHandler();
});
