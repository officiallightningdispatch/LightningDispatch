/**
 * DB SAFETY GUARD (2026-08-12, post-incident hardening).
 *
 * HARD RULE: no organizations row may be deleted unless it is PROVABLY a QA
 * fixture. On 2026-08-12 a cleanup script deleted the PRODUCTION org
 * ("Lightning Roadside Assistants LLC", 89e15ce587651cc47c3bc45b1c612a220955)
 * by following an orphaned QA user's org FK without verifying the target —
 * every org-scoped table cascade-deleted, no backup existed.
 *
 * Every destructive cleanup path (test suites, dev seed scripts, manual ops)
 * MUST call assertQaOrg(orgId) BEFORE any `DELETE FROM organizations`. The
 * guard throws and aborts the delete unless the org is provably QA:
 *   - id starts with "qa-"  OR  name starts with "qa " / "qa-"
 *   - and the id is NOT the production org id (which is always refused).
 *
 * SERVER-ONLY module. Imported only by hermetic tests / dev scripts / ops
 * tooling — never by client-reachable modules.
 */

/** The real production org (owner "Lightning Roadside Assistants LLC"). */
export const PRODUCTION_ORG_ID = "89e15ce587651cc47c3bc45b1c612a220955";
export const PRODUCTION_ORG_NAME = "Lightning Roadside Assistants LLC";

/** True when the org must NEVER be deleted (production org, or anything that
 *  cannot be proven to be a QA fixture). */
export function isProtectedOrg(orgId: string, orgName?: string | null): boolean {
  if (!orgId) return true;
  if (orgId === PRODUCTION_ORG_ID) return true;
  const name = (orgName ?? "").trim();
  if (orgId.startsWith("qa-")) return false;
  if (/^qa[\s-]/i.test(name)) return false;
  return true;
}

/** Hard-refuse deleting an org that is not a provable QA fixture. Throws
 *  BEFORE the delete runs — callers must invoke it immediately before the
 *  DELETE statement and must NOT swallow its error. */
export function assertQaOrg(orgId: string, orgName?: string | null): void {
  if (isProtectedOrg(orgId, orgName)) {
    throw new Error(
      `Refusing to delete org ${orgId}${orgName ? ` ("${orgName}")` : ""} — not a provable QA fixture. ` +
        `Deletion is only allowed for orgs whose id starts with "qa-" (or whose name starts with "qa "). ` +
        `See /home/team/shared/db-safety-rules.md.`
    );
  }
}
