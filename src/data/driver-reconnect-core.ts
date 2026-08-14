/**
 * Driver reconnect core — SERVER-ONLY (auth incident 2026-08-13 —
 *  24hourbattery/lightengineer loop: the driver view reported "Your session
 *  expired", reconnect signed the owner out and landed them back on the owner
 *  dashboard, and the driver view stayed broken because re-logging in as the
 *  OWNER never refreshes the LINKED driver's stored Towbook session —
 *  persistDriverSession only ran inside driverLogin (the Towbook path)).
 *
 *  This core re-authenticates the EFFECTIVE driver against Towbook with the
 *  DRIVER's own dispatch credentials and persists a FRESH session row — WITHOUT
 *  touching the LD session (no cookie rotation, no session deletion — the
 *  owner stays signed in as themselves).
 *
 *  Guards (minimal surface, no privilege change):
 *   - Only the driver whose id equals the session's EFFECTIVE driver id may
 *     refresh the row (a manager account or a different driver's credentials
 *     are refused — a wrong-account reconnect must never overwrite the stored
 *     session or cross-attribute identity).
 *   - The standard identifyDriver status/type rules apply (disabled accounts
 *     refused, type 2 = manager refused here with driver-specific copy).
 *
 *  Lives in its OWN server-only module per the client-graph rule (see
 *  /home/team/shared/skills/tanstack-client-graph-leak): driver-auth.ts is
 *  client-reachable, and a plain export there that dynamic-imports
 *  towbook-login pulls auth-server/db/node:crypto into the client bundle
 *  ("randomBytes is not exported by __vite-browser-external"). The
 *  driverReconnect createServerFn handler in driver-auth.ts dynamic-imports
 *  this module from inside its handler body (stripped client-side); hermetic
 *  tests import it directly. Static server imports are fine here — this module
 *  never enters the client bundle graph.
 *
 *  Hermetic: fetchImpl/loginUrl/origin injectable for the test suite — no real
 *  Towbook calls in tests. */
import { towbookLogin } from "./towbook-login";
import { identifyDriver, driverSignInErrorCopy, type DriverSession } from "./driver-auth";
import { persistDriverSession } from "./driver-gps-core";

export type DriverReconnectResult =
  | { ok: true; driverId: string }
  | { ok: false; message: string };

/** Reconnect a DEAD driver Towbook session IN PLACE (server-only core; the
 *  handler in driver-auth resolves the effective driver and delegates here). */
export async function driverReconnectCore(
  user: { orgId: string; towbookDriverId: string },
  username: string,
  password: string,
  opts: { fetchImpl?: typeof fetch; loginUrl?: string; origin?: string } = {},
): Promise<DriverReconnectResult> {
  const login = await towbookLogin(username, password, {
    fetchImpl: opts.fetchImpl,
    loginUrl: opts.loginUrl,
    origin: opts.origin,
  });
  if (!login.ok) return { ok: false as const, message: driverSignInErrorCopy(login.error.code, login.error.message) };
  const session: DriverSession = { cookies: login.cookies, baseUrl: login.baseUrl };
  const identity = await identifyDriver(session, { fetchImpl: opts.fetchImpl });
  if (!identity.ok) return { ok: false as const, message: identity.message };
  if (identity.kind === "owner") {
    return { ok: false as const, message: "That's a manager account — reconnect with the driver's own dispatch username and password." };
  }
  if (identity.identity.driverId !== user.towbookDriverId) {
    return { ok: false as const, message: "That username doesn't match the driver on this session — use the dispatch username shown on the reconnect screen." };
  }
  await persistDriverSession(user.orgId, identity.identity.driverId, session);
  return { ok: true as const, driverId: identity.identity.driverId };
}
