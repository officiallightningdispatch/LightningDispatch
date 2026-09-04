/**
 * Contractor sign-up-on-login-screen (owner-directed 2026-09-04) — CLIENT-SAFE
 * FACADE.
 *
 * This module is the ONLY piece of the sign-up feature imported by client code
 * (login screen). It defines the createServerFn server functions; their
 * handlers dynamic-import the SERVER-ONLY core (./contractor-signup-core.ts) so
 * the client bundle never pulls in db / auth-server / node:crypto code. No
 * other exports — the core owns all logic (client-graph rule).
 */
import { createServerFn } from "@tanstack/react-start";
import type {
  ContractorApplicationRow,
  SignupCoreResult,
  ApplicationResult,
} from "./contractor-signup-core";

export type { ContractorApplicationRow, ApplicationResult };

const passthrough = (x: unknown) => x;

/** Public: create an LD contractor account in the PROD org + start a session. */
export const signupContractor = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(async ({ data }): Promise<SignupCoreResult> => {
    const core = await import("./contractor-signup-core");
    return core.signupContractorHandler(data);
  });

/** Public (signed-in contractor): create/refresh the application row. */
export const submitContractorApplication = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(async ({ data }): Promise<ApplicationResult<ContractorApplicationRow>> => {
    const core = await import("./contractor-signup-core");
    return core.submitContractorApplicationHandler(data);
  });

/** The signed-in contractor's own application (or null). */
export const getMyApplicationStatus = createServerFn({ method: "GET" })
  .handler(async (): Promise<ApplicationResult<ContractorApplicationRow | null>> => {
    const core = await import("./contractor-signup-core");
    return core.getMyApplicationStatusHandler();
  });

/** Owner/admin: all applications for the org. */
export const listContractorApplications = createServerFn({ method: "GET" })
  .handler(async (): Promise<ApplicationResult<ContractorApplicationRow[]>> => {
    const core = await import("./contractor-signup-core");
    return core.listContractorApplicationsHandler();
  });

/** Owner/admin: move an application between states. */
export const setContractorApplicationStatus = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(async ({ data }): Promise<ApplicationResult<ContractorApplicationRow>> => {
    const core = await import("./contractor-signup-core");
    return core.setContractorApplicationStatusHandler(data);
  });
