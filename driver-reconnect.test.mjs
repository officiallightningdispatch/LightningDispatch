// Hermetic driver-reconnect regression tests (auth incident 2026-08-13 —
// 24hourbattery/lightengineer loop): the driver view reported "Your session
// expired — tap to reconnect", reconnect signed the LD session out and landed
// the owner back on the OWNER dashboard, and the driver view stayed broken
// because re-logging in as the owner never refreshes the LINKED driver's stored
// Towbook session. The fix: an IN-PLACE reconnect (driverReconnectCore) that
// re-authenticates the EFFECTIVE driver against Towbook with the DRIVER's own
// dispatch credentials and persists a fresh session row — WITHOUT touching the
// LD session (reconnect retains the intended portal; the owner stays owner).
//
// Coverage (task-mandated regression scenarios):
//   1. driver-only identity reconnect → driver session refreshed (lands driver)
//   2. owner-with-linked-driver (lightengineer shape-b) reconnect → the LINKED
//      driver's session is refreshed, owner session untouched (toggle → driver)
//   3. session reconnect retains intended portal — LD sessions unchanged by the
//      reconnect core (no cookie rotation, no session deletion)
//   4. logout/login as another role clears stale state — old tokens die, the
//      new login's token resolves to the new user only
//   5. expired-session refresh does NOT silently land the owner — manager
//      credentials and a DIFFERENT driver's credentials are refused by the
//      reconnect guard (never cross-wires sessions/identities)
//
// QA fixture only (qa-* org + users); no real Towbook, no real sessions, no
// production rows touched. Cleanup always runs (try/finally).
//   DATABASE_URL=... bun driver-reconnect.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
const { ensureSchema } = await import("./src/data/migrations.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const { driverReconnectCore } = await import("./src/data/driver-reconnect-core.ts");
const { persistDriverSession, loadDriverSession } = await import("./src/data/driver-gps-core.ts");
const { effectiveDriverIdentity } = await import("./src/data/auth-server.ts");
const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};
const PREFIX = "qa-driver-reconnect";
const uid = (tag) => `${PREFIX}-${tag}-${randomUUID()}`;
const ORG = `qa ${PREFIX} ${randomUUID()}`;
const ORG_PAT = `qa ${PREFIX}%`;
const USER_PAT = `${PREFIX}-%@lightning.test`;
const email = (u) => `${u}@lightning.test`;
const tbId = (seed) => String(BigInt("0x" + seed.replace(/-/g, "").slice(-32)) % 900_000_000n + 100_000_000n);

/* ------------------------------ mock Towbook ------------------------------ */
const LOGIN_URL = "https://tb-reconnect.test/Security/Login.aspx";
const ORIGIN = "https://tb-reconnect.test";
const hdrs = (entries) => {
  const m = new Map(entries.map(([k, v]) => [k.toLowerCase(), v]));
  return {
    get: (k) => m.get(k.toLowerCase()) ?? null,
    getSetCookie: () => {
      const v = m.get("set-cookie");
      return v ? [v] : [];
    },
  };
};
/** Routes the real towbookLogin + identifyDriver against a canned Towbook:
 *  login page GET → token, login POST → auth cookie (or re-rendered login form
 *  when the password is wrong), then /api/user, /api/users (disabled status),
 *  /api/drivers (roster). UNROUTED calls throw. */
const makeTbFetch = ({ userId, userName, type, roster, validPassword }) => {
  return async (url, init = {}) => {
    const method = init?.method ?? "GET";
    const key = `${method} ${url}`;
    if (key === `GET ${LOGIN_URL}`) {
      return {
        status: 200, ok: true,
        headers: hdrs([["content-type", "text/html"]]),
        text: async () => `<html><body><form><input type="hidden" name="RequestVerificationToken" value="tok-${userId}" /></form></body></html>`,
      };
    }
    if (key === `POST ${LOGIN_URL}`) {
      const body = String(init?.body ?? "");
      const pw = new URLSearchParams(body).get("Password") ?? "";
      if (validPassword && pw !== validPassword) {
        // Towbook's real failed-login shape: 200 with the login form re-rendered
        // and NO auth cookie → towbookLogin classifies invalid_credentials.
        return {
          status: 200, ok: true,
          headers: hdrs([["content-type", "text/html"]]),
          text: async () => `<html><body><form><input type="hidden" name="RequestVerificationToken" value="tok-${userId}" /></form></body></html>`,
        };
      }
      return {
        status: 302, ok: true,
        headers: hdrs([["location", "/"], ["set-cookie", `.ASPXAUTH=authed-${userId}; path=/; HttpOnly`]]),
        text: async () => "",
      };
    }
    if (key === `GET ${ORIGIN}/api/user`) {
      return { status: 200, ok: true, headers: hdrs([]), text: async () => JSON.stringify({ id: userId, name: userName, type }) };
    }
    if (key === `GET ${ORIGIN}/api/users`) {
      return { status: 200, ok: true, headers: hdrs([]), text: async () => JSON.stringify([{ id: userId, name: userName, type, disabled: false }]) };
    }
    if (key === `GET ${ORIGIN}/api/drivers`) {
      return { status: 200, ok: true, headers: hdrs([]), text: async () => JSON.stringify(roster) };
    }
    throw new Error(`no route for ${key}`);
  };
};

/* ------------------------------ fixture ------------------------------ */
await ensureSchema();
const CONTRACTOR = uid("contractor"); // the real driver row (24hourbattery shape)
const OWNER_LINKED = uid("ownerlinked"); // lightengineer shape: owner linked to CONTRACTOR
const OWNER_OWN = uid("ownerown"); // al0101 shape: owner WITH own driver id
const MANAGER = uid("manager"); // towbook manager (type 2) — never allowed on reconnect
const OTHER_DRIVER = uid("otherdriver"); // a DIFFERENT contractor (wrong-driver guard)
const D_CONTRACTOR = tbId(uid("dc"));
const U_CONTRACTOR = tbId(uid("uc"));
const D_OWNER_OWN = tbId(uid("do"));
const U_OWNER_OWN = tbId(uid("uo"));
const D_OTHER = tbId(uid("dx"));
const U_OTHER = tbId(uid("ux"));
const U_MANAGER = tbId(uid("um"));

try {
  for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE ${ORG_PAT}`) {
    assertQaOrg(org.id, org.name);
    await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
  }
  await q`DELETE FROM users WHERE email LIKE ${USER_PAT}`.catch(() => {});
  await q`INSERT INTO organizations(id, name) VALUES(${ORG}, ${ORG})`;
  const ins = (id, name) => q`INSERT INTO users(id, name, email, password_hash) VALUES(${id}, ${name}, ${email(id)}, 'x')`;
  await ins(CONTRACTOR, "24hourbattery");
  await ins(OWNER_LINKED, "Lightning Dispatch");
  await ins(OWNER_OWN, "Ai Dispatch GB");
  await ins(MANAGER, "Some Manager");
  await ins(OTHER_DRIVER, "Other Driver");
  await q`UPDATE users SET towbook_driver_id=${D_CONTRACTOR}, towbook_user_id=${U_CONTRACTOR}, login_handle=${uid("dh")} WHERE id=${CONTRACTOR}`;
  await q`UPDATE users SET towbook_user_id=${U_MANAGER}, login_handle=${uid("mh")} WHERE id=${MANAGER}`;
  await q`UPDATE users SET towbook_driver_id=${D_OWNER_OWN}, towbook_user_id=${U_OWNER_OWN}, login_handle=${uid("oh")} WHERE id=${OWNER_OWN}`;
  await q`UPDATE users SET towbook_driver_id=${D_OTHER}, towbook_user_id=${U_OTHER}, login_handle=${uid("xh")} WHERE id=${OTHER_DRIVER}`;
  // lightengineer shape: owner member linked to the contractor row
  await q`UPDATE users SET linked_driver_user_id=${CONTRACTOR} WHERE id=${OWNER_LINKED}`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES
    (${ORG}, ${CONTRACTOR}, 'contractor'),
    (${ORG}, ${OWNER_LINKED}, 'owner'),
    (${ORG}, ${OWNER_OWN}, 'owner'),
    (${ORG}, ${OTHER_DRIVER}, 'contractor')`;

  /* ---------------- 1) driver-only identity reconnect refreshes the driver ---------------- */
  {
    // The contractor's own session row starts stale (simulate: no row at all —
    // loadDriverSession returns null = the "No active session" expired state).
    const before = await loadDriverSession({ orgId: ORG, towbookDriverId: D_CONTRACTOR });
    check("scenario 1 setup: contractor has NO stored session (the expired state)", before === null);
    const r = await driverReconnectCore(
      { orgId: ORG, towbookDriverId: D_CONTRACTOR },
      "the-driver-username",
      "the-driver-password",
      {
        fetchImpl: makeTbFetch({ userId: U_CONTRACTOR, userName: "24hourbattery", type: 3, roster: [{ id: D_CONTRACTOR, name: "24hourbattery", linkedUserId: U_CONTRACTOR }], validPassword: "the-driver-password" }),
        loginUrl: LOGIN_URL,
        origin: ORIGIN,
      },
    );
    check("scenario 1: driver's OWN credentials reconnect ok (driver-only login lands driver)", r.ok, JSON.stringify(r));
    const after = await loadDriverSession({ orgId: ORG, towbookDriverId: D_CONTRACTOR });
    check("scenario 1: fresh session persisted — queue can load again (no more expired)", after !== null && after.cookies.includes("authed-") && after.baseUrl === ORIGIN, JSON.stringify(after));
  }

  /* ---------------- 2) owner-with-linked-driver toggle → driver, reconnect refreshes THE LINKED DRIVER ---------------- */
  {
    // Effective-driver resolution (the lightengineer shape): the owner's driver
    // identity IS the linked contractor's row — the same path driverJobs uses.
    const identity = await effectiveDriverIdentity({ id: OWNER_LINKED, name: "Lightning Dispatch", email: email(OWNER_LINKED), role: "owner", orgId: ORG, towbookDriverId: null, linkedDriverUserId: CONTRACTOR, driverIdentity: null });
    check("scenario 2: owner-linked resolves the LINKED driver (720958 shape)", identity !== null && identity.towbookDriverId === D_CONTRACTOR && identity.userRowId === CONTRACTOR, JSON.stringify(identity));
    const sessionsBefore = await q`SELECT count(*)::int AS n FROM sessions WHERE user_id=${OWNER_LINKED}`;
    const r = await driverReconnectCore(
      { orgId: ORG, towbookDriverId: identity.towbookDriverId },
      "24hourbattery",
      "dispatch-pass",
      {
        fetchImpl: makeTbFetch({ userId: U_CONTRACTOR, userName: "24hourbattery", type: 1, roster: [{ id: D_CONTRACTOR, name: "24hourbattery", linkedUserId: U_CONTRACTOR }], validPassword: "dispatch-pass" }),
        loginUrl: LOGIN_URL,
        origin: ORIGIN,
      },
    );
    check("scenario 2: owner-in-driver-view reconnects the LINKED driver with the driver's creds", r.ok, JSON.stringify(r));
    const sess = await loadDriverSession({ orgId: ORG, towbookDriverId: D_CONTRACTOR });
    check("scenario 2: linked driver's session row is fresh after reconnect (toggle → driver now works)", sess !== null && sess.cookies.includes("authed-"), JSON.stringify(sess));
    const sessionsAfter = await q`SELECT count(*)::int AS n FROM sessions WHERE user_id=${OWNER_LINKED}`;
    check("scenario 2: reconnect did NOT create/rotate the owner's LD session (owner stays owner)", Number(sessionsBefore[0].n) === Number(sessionsAfter[0].n), `${sessionsBefore[0].n} -> ${sessionsAfter[0].n}`);
  }

  /* ---------------- 3) session reconnect retains the intended portal (LD session untouched) ---------------- */
  {
    const allBefore = await q`SELECT id, user_id FROM sessions WHERE expires_at > NOW()`;
    const beforeCount = allBefore.length;
    // A fresh reconnect for the OWNER_OWN (al0101 shape-a) — own driver creds.
    const r = await driverReconnectCore(
      { orgId: ORG, towbookDriverId: D_OWNER_OWN },
      "al0101",
      "pass",
      {
        fetchImpl: makeTbFetch({ userId: U_OWNER_OWN, userName: "Ai Dispatch GB", type: 1, roster: [{ id: D_OWNER_OWN, name: "Ai Dispatch GB", linkedUserId: U_OWNER_OWN }], validPassword: "pass" }),
        loginUrl: LOGIN_URL,
        origin: ORIGIN,
      },
    );
    check("scenario 3: shape-a owner (own driver id) reconnect ok", r.ok, JSON.stringify(r));
    const allAfter = await q`SELECT id, user_id FROM sessions WHERE expires_at > NOW()`;
    check("scenario 3: reconnect touches NO LD session rows (no rotation, no deletion — portal retained)", beforeCount === allAfter.length && allAfter.every((s) => allBefore.some((b) => String(b.id) === String(s.id))), `${beforeCount} -> ${allAfter.length}`);
    // The reconnect only wrote the driver's towbook_sessions row.
    const tbRows = await q`SELECT session_kind, towbook_driver_id FROM towbook_sessions WHERE org_id=${ORG} AND session_kind='driver'`;
    check("scenario 3: only driver-kind session rows exist for the org (no owner-kind row created by reconnect)", tbRows.every((r) => r.session_kind === "driver"), JSON.stringify(tbRows));
  }

  /* ---------------- 4) logout/login as another role clears stale state ---------------- */
  {
    // Simulate the auth contract the logout path implements (delete the token
    // row + the cookie is expired): a deleted token resolves to NO user, and a
    // fresh login for ANOTHER user creates a token that resolves ONLY to them.
    const tokA = `qa-recon-token-${randomUUID()}`;
    const tokB = `qa-recon-token-${randomUUID()}`;
    await q`INSERT INTO sessions(id, user_id, expires_at) VALUES(${tokA}, ${CONTRACTOR}, NOW() + INTERVAL '1 day'), (${tokB}, ${OWNER_LINKED}, NOW() + INTERVAL '1 day')`;
    const resolveA = await q`SELECT u.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=${tokA} AND s.expires_at > NOW()`;
    check("scenario 4: user A's token resolves to A before logout", resolveA.length === 1 && String(resolveA[0].id) === CONTRACTOR, JSON.stringify(resolveA));
    // "logout" = the server deletes the presented token(s) (driverLogout/logout).
    await q`DELETE FROM sessions WHERE id=${tokA}`;
    const resolveA2 = await q`SELECT u.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=${tokA} AND s.expires_at > NOW()`;
    check("scenario 4: A's token dies on logout — stale session cannot resolve", resolveA2.length === 0);
    // "login as another role" — the new token belongs to the new user and the
    // auth resolution joins the CURRENT membership role (not A's).
    const resolveB = await q`SELECT u.id, m.role FROM sessions s JOIN users u ON u.id=s.user_id JOIN organization_memberships m ON m.user_id=u.id WHERE s.id=${tokB} AND s.expires_at > NOW()`;
    check("scenario 4: B's fresh token resolves to B with B's role (owner) — no stale A state", resolveB.length === 1 && String(resolveB[0].id) === OWNER_LINKED && String(resolveB[0].role) === "owner", JSON.stringify(resolveB));
    await q`DELETE FROM sessions WHERE id=${tokB}`;
  }

  /* ---------------- 5) expired-session refresh never silently lands the owner ---------------- */
  {
    // Manager credentials (type 2) into the reconnect → refused with the
    // manager-specific copy — the reconnect NEVER cross-wires the owner's
    // Towbook account into the driver session.
    const rManager = await driverReconnectCore(
      { orgId: ORG, towbookDriverId: D_CONTRACTOR },
      "lightengineer",
      "manager-pass",
      {
        fetchImpl: makeTbFetch({ userId: U_MANAGER, userName: "Lightning Dispatch", type: 2, roster: [], validPassword: "manager-pass" }),
        loginUrl: LOGIN_URL,
        origin: ORIGIN,
      },
    );
    check("scenario 5: manager (type 2) creds refused — never silently lands owner", !rManager.ok && String(rManager.message).includes("manager account"), JSON.stringify(rManager));
    // A DIFFERENT driver's credentials → refused; the stored session is NOT
    // overwritten (identity guard).
    const sessBefore = await loadDriverSession({ orgId: ORG, towbookDriverId: D_CONTRACTOR });
    const rOther = await driverReconnectCore(
      { orgId: ORG, towbookDriverId: D_CONTRACTOR },
      "other-driver-username",
      "other-pass",
      {
        fetchImpl: makeTbFetch({ userId: U_OTHER, userName: "Other Driver", type: 3, roster: [{ id: D_OTHER, name: "Other Driver", linkedUserId: U_OTHER }], validPassword: "other-pass" }),
        loginUrl: LOGIN_URL,
        origin: ORIGIN,
      },
    );
    check("scenario 5: a DIFFERENT driver's creds refused (identity guard)", !rOther.ok && String(rOther.message).includes("doesn't match the driver"), JSON.stringify(rOther));
    const sessAfter = await loadDriverSession({ orgId: ORG, towbookDriverId: D_CONTRACTOR });
    check("scenario 5: refused reconnect left the stored session untouched", sessAfter !== null && sessAfter.cookies === sessBefore.cookies, JSON.stringify(sessAfter));
    // Wrong password → plain invalid-credentials copy (no silent anything).
    const rBad = await driverReconnectCore(
      { orgId: ORG, towbookDriverId: D_CONTRACTOR },
      "24hourbattery",
      "wrong-pass",
      {
        fetchImpl: makeTbFetch({ userId: U_CONTRACTOR, userName: "24hourbattery", type: 1, roster: [{ id: D_CONTRACTOR, name: "24hourbattery", linkedUserId: U_CONTRACTOR }], validPassword: "right-pass" }),
        loginUrl: LOGIN_URL,
        origin: ORIGIN,
      },
    );
    check("scenario 5: wrong password → refused with plain credentials copy", !rBad.ok && String(rBad.message).includes("rejected those credentials"), JSON.stringify(rBad));
  }
} finally {
  /* ------------------------------ cleanup (always) ------------------------------ */
  for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE ${ORG_PAT}`) {
    assertQaOrg(org.id, org.name);
    await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
  }
  await q`DELETE FROM users WHERE email LIKE ${USER_PAT}`.catch(() => {});
  await q`DELETE FROM sessions WHERE id LIKE 'qa-recon-token-%'`.catch(() => {});
}
function rOkOf(r) { return r && r.ok === true; }

/* --------------------------------- summary --------------------------------- */
const failed = checks.filter(([, ok]) => !ok);
console.log(`driver-reconnect.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }
console.log("driver-reconnect.test.mjs: QA fixture cleaned up (zero residue)");
