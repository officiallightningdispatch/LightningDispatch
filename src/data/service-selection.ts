/** Client-safe facade for persistent contractor service capabilities. */
import { createServerFn } from "@tanstack/react-start";
import type { ServiceSelectionResult, ServiceSelectionRow } from "./service-selection-core";
export type { ServiceSelectionResult, ServiceSelectionRow } from "./service-selection-core";
const passthrough = (x: unknown) => x;
export const getMyServices = createServerFn({ method: "GET" }).handler(async (): Promise<ServiceSelectionResult<{ services: ServiceSelectionRow; options: { key: string; label: string }[] }>> => { const core = await import("./service-selection-core"); return core.getMyServicesHandler(); });
export const setMyServices = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<ServiceSelectionResult<ServiceSelectionRow>> => { const core = await import("./service-selection-core"); return core.setMyServicesHandler(data); });
export const listContractorServices = createServerFn({ method: "GET" }).handler(async (): Promise<ServiceSelectionResult<ServiceSelectionRow[]>> => { const core = await import("./service-selection-core"); return core.listContractorServicesHandler(); });
export const setContractorServices = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<ServiceSelectionResult<ServiceSelectionRow>> => { const core = await import("./service-selection-core"); return core.setContractorServicesHandler(data); });
export const bulkSetContractorServices = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<ServiceSelectionResult<{ updated: number }>> => { const core = await import("./service-selection-core"); return core.bulkSetContractorServicesHandler(data); });
