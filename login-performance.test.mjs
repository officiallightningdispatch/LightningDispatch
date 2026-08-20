// Login performance regression coverage (owner-directed 2026-08-19).
// The public login route performs the one status check it needs; the root auth
// gate must not issue a second request for public routes. This is intentionally
// source-level and hermetic: no credentials, database, or Towbook calls.
import { readFileSync } from "node:fs";

const root = readFileSync("./src/routes/__root.tsx", "utf8");
const login = readFileSync("./src/routes/login.tsx", "utf8");
const store = readFileSync("./src/lib/store.tsx", "utf8");
const checks = [];
const check = (name, condition, extra = "") => {
  checks.push([name, Boolean(condition), extra]);
  if (!condition) throw new Error(`FAIL: ${name} ${extra}`);
};

const authStatusCalls = (source) => (source.match(/\bauthStatus\s*\(/g) ?? []).length;
const gateBody = root.slice(root.indexOf("function AuthGate"), root.indexOf("function GateSkeleton"));
const publicGuard = gateBody.indexOf('if (publicPath) { setReady(true); return');
const firstAuthStatus = gateBody.indexOf("authStatus()");

check(
  "root auth gate returns before authStatus on public routes",
  publicGuard >= 0 && publicGuard < firstAuthStatus,
  "public-path guard must precede the protected-route status request",
);
check(
  "root auth gate keeps protected-route auth status",
  authStatusCalls(gateBody) === 1,
  `expected one protected-route authStatus call, found ${authStatusCalls(gateBody)}`,
);
check(
  "login route retains exactly one status check for first-run/session redirect",
  authStatusCalls(login) === 1,
  `expected one login authStatus call, found ${authStatusCalls(login)}`,
);
check(
  "login still uses the server-returned role for portal routing",
  login.includes("portal(role)") && login.includes("portal(d.role)"),
);
check(
  "public-path list still includes login, logout, and access-denied pages",
  ['"/login"', '"/logout"', '"/403"'].every((path) => gateBody.includes(path)),
);

const storeEffect = store.slice(store.indexOf("useEffect(() => {"), store.indexOf("/** Run a mutation"));
const storePublicGuard = storeEffect.indexOf('if (publicPath || driverPath) { setLoading(false); return');
const dispatchSnapshotCall = storeEffect.indexOf("getDispatchData()");
check(
  "dispatch store skips public/auth and driver screens before its snapshot request",
  storePublicGuard >= 0 && storePublicGuard < dispatchSnapshotCall && storeEffect.includes('const driverPath = location.pathname === "/driver"'),
  "getDispatchData must not run during driver login/landing",
);
check(
  "dispatch store still snapshots protected routes once",
  authStatusCalls(storeEffect) === 0 && (storeEffect.match(/getDispatchData\(\)/g) ?? []).length === 1 && storeEffect.includes("location.pathname"),
  "protected-route initialization wiring changed unexpectedly",
);

const failed = checks.filter(([, ok]) => !ok);
console.log(`login-performance.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) process.exit(1);
console.log("login-performance.test.mjs: no duplicate public auth request; no network or QA rows");
