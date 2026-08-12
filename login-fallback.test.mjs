// Hermetic login-fallback tests (owner bug 2026-08-12): an LD owner/admin/
// dispatcher with a wrong password must NOT fall through to the Towbook driver
// login (it surfaced a misleading "Towbook could not be connected" error with a
// meaningless "interactive reconnect" hint), while unknown identifiers and
// contractor accounts (drivers authenticate via Towbook) still do. The driver
// sign-in copy for Towbook network/unreachable failures is plain — never the
// connect-card's "interactive reconnect" wording.
// Pure function tests — no DB, no network, no fixture rows (nothing to clean up).
//   bun login-fallback.test.mjs
import { shouldFallThroughToDriverLogin } from "./src/data/auth.ts";
import { driverSignInErrorCopy } from "./src/data/driver-auth.ts";
const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};
/* ---------- (i) LD staff wrong password → driverLogin NOT invoked ---------- */
check("owner wrong password → no Towbook fallback",
  shouldFallThroughToDriverLogin({ ok: false, error: "Invalid username or password.", reason: "invalid_password" }) === false);
check("admin wrong password → no Towbook fallback",
  shouldFallThroughToDriverLogin({ ok: false, error: "Invalid username or password.", reason: "invalid_password" }) === false);
check("dispatcher wrong password → no Towbook fallback",
  shouldFallThroughToDriverLogin({ ok: false, error: "Invalid username or password.", reason: "invalid_password" }) === false);
check("no-workspace account → no Towbook fallback",
  shouldFallThroughToDriverLogin({ ok: false, error: "Your account has no workspace assigned yet. Contact your administrator.", reason: "no_workspace" }) === false);
check("invalid input (empty/oversized) → no Towbook fallback",
  shouldFallThroughToDriverLogin({ ok: false, error: "Invalid username or password.", reason: "invalid_input" }) === false);
check("demo-mode failure (no reason) → no Towbook fallback",
  shouldFallThroughToDriverLogin({ ok: false, error: "Database mode is not active." }) === false);
/* ---------- (ii) unknown identifier → driverLogin fallback still fires ---------- */
check("unknown identifier → driverLogin fallback fires",
  shouldFallThroughToDriverLogin({ ok: false, error: "Invalid username or password.", reason: "unknown_identifier" }) === true);
/* ---------- (iii) contractor account (unusable random hash) → fallback fires ---------- */
check("contractor account → driverLogin fallback fires (existing driver flow)",
  shouldFallThroughToDriverLogin({ ok: false, error: "Invalid username or password.", reason: "contractor_account" }) === true);
/* ---------- driver sign-in copy: plain, no "interactive reconnect" ---------- */
check("towbook_unreachable → plain copy, no reconnect hint",
  driverSignInErrorCopy("towbook_unreachable", "Towbook could not be connected. Try again or use an interactive reconnect.") === "Towbook didn't respond — please try again in a moment.");
check("towbook_unreachable (unexpected status) → plain copy",
  driverSignInErrorCopy("towbook_unreachable", "Towbook responded with an unexpected status 502. Try again or use an interactive reconnect.") === "Towbook didn't respond — please try again in a moment.");
check("invalid_credentials keeps raw copy (drivers see 'rejected those credentials')",
  driverSignInErrorCopy("invalid_credentials", "Towbook rejected those credentials.") === "Towbook rejected those credentials.");
check("towbook_blocked keeps raw copy",
  driverSignInErrorCopy("towbook_blocked", "Towbook is blocking automated sign-in. Open Towbook in your browser once, then retry.") === "Towbook is blocking automated sign-in. Open Towbook in your browser once, then retry.");
check("unknown/no code keeps raw copy",
  driverSignInErrorCopy(undefined, "Driver sign-in failed. Try again.") === "Driver sign-in failed. Try again.");
/* --------------------------------- summary --------------------------------- */
const failed = checks.filter(([, ok]) => !ok);
console.log(`login-fallback.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }
console.log("login-fallback.test.mjs: pure suite — no QA rows created");
