// Hermetic portal-gate tests for the owner↔contractor view toggle (2026-08-12).
//   DriverGate (owner/admin with a non-deactivated driver identity may enter the
//   driver portal; contractors always; everyone else rejected → 403) + the
//   OwnerGate/OpsGate role lists never weakened (regression).
// Pure function tests — no DB, no network, no fixture rows (nothing to clean up).
//   bun portal-gate.test.mjs
import { readFileSync } from "node:fs";
const { driverGateAllows } = await import("./src/components/portal-gate.tsx");
const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};
const identity = (over = {}) => ({ userRowId: "u1", towbookDriverId: "7", driverName: "D", deactivated: false, ...over });
/* ------------------------- driverGateAllows decision matrix ------------------------- */
check("contractor always passes (even with null identity)", driverGateAllows({ role: "contractor", driverIdentity: null }) === true);
check("contractor with identity passes", driverGateAllows({ role: "contractor", driverIdentity: identity() }) === true);
check("owner with own driver id (shape a) passes", driverGateAllows({ role: "owner", driverIdentity: identity() }) === true);
check("admin with linked driver (shape b) passes", driverGateAllows({ role: "admin", driverIdentity: identity({ userRowId: "u9", towbookDriverId: "8" }) }) === true);
check("owner without driver identity rejected (→403 no-driver)", driverGateAllows({ role: "owner", driverIdentity: null }) === false);
check("admin without driver identity rejected", driverGateAllows({ role: "admin", driverIdentity: null }) === false);
check("owner with deactivated linked driver rejected", driverGateAllows({ role: "owner", driverIdentity: identity({ deactivated: true }) }) === false);
check("admin with deactivated linked driver rejected", driverGateAllows({ role: "admin", driverIdentity: identity({ deactivated: true }) }) === false);
check("dispatcher never passes DriverGate", driverGateAllows({ role: "dispatcher", driverIdentity: identity() }) === false);
check("signed-out (null) never passes", driverGateAllows(null) === false);
/* ------------------- OwnerGate/OpsGate never weakened (source regression) ------------------- */
{
  const src = readFileSync(new URL("./src/components/portal-gate.tsx", import.meta.url), "utf8");
  check("OwnerGate still owner+admin only", src.includes('export const OwnerGate = ({ children }: { children: ReactNode }) => <PortalGate roles={["owner", "admin"]}>{children}</PortalGate>'));
  check("OpsGate still owner+admin+dispatcher only", src.includes('export const OpsGate = ({ children }: { children: ReactNode }) => <PortalGate roles={["owner", "admin", "dispatcher"]}>{children}</PortalGate>'));
  check("DriverGate is the only gate with allowDriverIdentity", src.includes("export const DriverGate = ({ children }: { children: ReactNode }) => <PortalGate roles={[\"contractor\"]} allowDriverIdentity>{children}</PortalGate>"));
  check("DriverGate role list unchanged (contractor only)", src.includes('roles={["contractor"]}'));
  check("403 branch carries no-driver reason only for DriverGate", src.includes('search: (allowDriverIdentity ? { reason: "no-driver" } : {}) as any'));
}
/* ------------------------------- summary ------------------------------- */
const failed = checks.filter(([, ok]) => !ok);
console.log(`portal-gate.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }
console.log("portal-gate.test.mjs: pure suite — no QA rows created");
