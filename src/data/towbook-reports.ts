import { createServerFn } from "@tanstack/react-start";
import type { CallWorkflowRow, ReconciliationResult } from "./towbook-reports-core";
const passthrough = (x: unknown) => x;
export const getTowbookReconciliation = createServerFn({ method: "POST" }).validator(passthrough).handler(async ({ data }): Promise<{ok:true;data:ReconciliationResult}|{ok:false;message:string}> => {
  const { currentUser } = await import("./auth-server"); const u = await currentUser();
  if (!u || !["owner","admin"].includes(u.role)) return { ok:false, message:"Owner access required." };
  const v = data as { start?: string; end?: string; rows?: CallWorkflowRow[] };
  if (!v.start || !v.end) return { ok:false, message:"Report window is required." };
  try { const core = await import("./towbook-reports-core"); return { ok:true, data: await core.getReconciliationCore(u.orgId, { start:v.start, end:v.end }, v.rows) }; }
  catch (e) { return { ok:false, message:e instanceof Error ? e.message : "Unable to reconcile Towbook report." }; }
});
