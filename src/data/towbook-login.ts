/**
 * Shared Towbook web-login helper (extracted 2026-08-11 from server.ts's
 * connectTowbook for the driver portal): one code path that turns a Towbook
 * username + password into an authenticated cookie session, used by BOTH the
 * owner connect flow (server.ts) and the driver login flow (driver-auth.ts).
 *
 * PURE — no database, no persistence. It returns the session cookies (or the
 * classified failure + full diagnostic facts); callers decide where to store
 * them (towbook_sessions owner row vs driver row) and how to surface errors.
 *
 * Request shape is byte-matched to a real browser (see
 * /home/team/shared/towbook-recon.md): the login page GET issues a rotating
 * RequestVerificationToken + antiforgery cookie pair, the POST sends
 * Username, Password, bSignIn (=EMPTY — the button has no value attribute) and
 * RequestVerificationToken in exactly that order with full browser headers.
 * A fake-credential 200/302 can never be mistaken for success: only a Set-Cookie
 * matching the auth-cookie heuristics (and NOT the antiforgery/TempData/marketing
 * names) counts as authenticated.
 */

export const TOWBOOK_ORIGIN = "https://app.towbook.com";
export const TOWBOOK_LOGIN = "https://app.towbook.com/Security/Login.aspx";
const TOWBOOK_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

export const towbookBrowserHeaders = (cookie?: string) => ({
  "user-agent": TOWBOOK_UA,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "accept-language": "en-US,en;q=0.9",
  "upgrade-insecure-requests": "1",
  "sec-ch-ua": '"Chromium";v="151", "Not=A?Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Linux"',
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "navigate",
  "sec-fetch-user": "?1",
  "sec-fetch-dest": "document",
  ...(cookie ? { cookie } : {}),
});

const getSetCookies = (h: Headers): string[] => {
  const hd = h as Headers & { getSetCookie?: () => string[] };
  if (typeof hd.getSetCookie === "function") return hd.getSetCookie();
  const joined = h.get("set-cookie");
  return joined ? [joined] : [];
};
const jar = (cs: string[]) => cs.map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");
// Session/auth cookies carry the authenticated state; the excluded names are
// the non-auth cookies Towbook actually sends (antiforgery + TempData flash +
// marketing), so a fake-credential 200/302 can never be mistaken for success.
const isAuthCookie = (n: string) => /(\.ASPXAUTH|ASP\.NET_SessionId|\.AspNetCore\.Cookies|\.AspNetCore\.Identity|\.AspNet\.ApplicationCookie|identity|ticket|session|auth)/i.test(n) && !/(TempData|Antiforgery|RequestVerificationToken|_ga|_gid|_gat|_hj|_zitok|hubspot|__cf|_hjid|_gcl)/i.test(n);
const hasAuthCookie = (cs: string[]) => cs.some((c) => isAuthCookie(c.split(";")[0].split("=")[0].trim()));
// Full cookie set for later authenticated pulls: response Set-Cookie merged over
// the pre-login cookies, response winning on name collisions.
const mergeJars = (pre: string, resp: string) => {
  const m = new Map<string, string>();
  for (const part of pre.split("; ")) { const n = part.split("=")[0].trim(); if (part && n) m.set(n, part); }
  for (const part of resp.split("; ")) { const n = part.split("=")[0].trim(); if (part && n) m.set(n, part); }
  return [...m.values()].join("; ");
};

// --- Diagnostics: capture exactly what Towbook returned so a rejected login is
// explainable. The classified short message goes to the UI; the full facts can
// be persisted (towbook_sessions.error) for post-mortem. Never logged raw. ---
export type TowbookCookieFact = { name: string; value: string; auth: boolean };
export type TowbookFacts = {
  stage: string;
  status: number | null;
  location: string | null;
  bodyLen: number | null;
  contentType: string | null;
  cookies: TowbookCookieFact[];
  authCookieDetected: boolean;
  loginForm: boolean;
  bodyHint: string;
  hops: { status: number | null; location: string | null; cookies: string[] }[];
};
const truncate = (s: string, n = 26) => (s.length > n ? s.slice(0, n) + "…" : s);
const cookieFacts = (cs: string[]): TowbookCookieFact[] => cs.map((c) => {
  const eq = c.indexOf("=");
  const name = (eq > 0 ? c.slice(0, eq) : c).trim();
  const value = eq > 0 ? c.slice(eq + 1).trim() : "";
  return { name, value: truncate(value), auth: isAuthCookie(name) };
});
const hasLoginForm = (html: string) => /<form/i.test(html) && /RequestVerificationToken/i.test(html);
const botChallengeHint = /(cf-chl|challenge-platform|just a moment|attention required|captcha|verify (you are|your)|access denied|blocked by)/i;
export const describeTowbookFailure = (f: TowbookFacts): { code: "invalid_credentials"|"towbook_blocked"|"towbook_unreachable"; message: string } => {
  if (f.status === 401 || f.status === 403) {
    if (f.status === 403 && botChallengeHint.test(f.bodyHint)) return { code: "towbook_blocked", message: "Towbook is blocking automated sign-in. Open Towbook in your browser once, then retry." };
    return { code: "invalid_credentials", message: "Towbook rejected those credentials." };
  }
  if (f.status !== null && f.status >= 300 && f.status < 400) {
    const names = f.cookies.map((c) => c.name).join(", ") || "none";
    return { code: "invalid_credentials", message: `Towbook responded: ${f.status} redirect${f.location ? ` to ${f.location}` : ""}, cookies: [${names}], no auth cookie matched — Towbook may be blocking automated sign-in or the session cookie name is unrecognized.` };
  }
  if (f.status === 200) {
    if (f.loginForm) return { code: "invalid_credentials", message: "Towbook rejected those credentials." };
    if (f.cookies.length === 0) return { code: "towbook_blocked", message: "Towbook is blocking automated sign-in. Open Towbook in your browser once, then retry." };
    return { code: "towbook_blocked", message: `Towbook responded: 200 with an unexpected page (${f.bodyLen ?? "?"} bytes, no login form, no session cookie) — Towbook may be blocking automated sign-in. Open Towbook in your browser once, then retry.` };
  }
  return { code: "towbook_unreachable", message: `Towbook responded with an unexpected status ${f.status ?? "unknown"}. Try again or use an interactive reconnect.` };
};
export const towbookDetail = (f: TowbookFacts) => JSON.stringify(f);

export type TowbookLoginError = { code: "invalid_credentials"|"towbook_blocked"|"towbook_unreachable"; message: string };
export type TowbookLoginResult =
  | { ok: true; cookies: string; baseUrl: string }
  | { ok: false; error: TowbookLoginError; facts: TowbookFacts };

export type TowbookLoginOptions = {
  /** Injectable fetch for hermetic tests — never real in the test suite. */
  fetchImpl?: typeof fetch;
  /** Override the login page URL (tests). */
  loginUrl?: string;
  /** Override the origin used for redirect-following (tests). */
  origin?: string;
  signal?: AbortSignal;
};

/** Login to app.towbook.com exactly like a browser and return the authenticated
 *  cookie jar (or a classified failure + diagnostic facts). Throws only on
 *  network-level catastrophes the caller cannot classify; failures are RETURNED
 *  so the caller can persist facts and show the short message. */
export async function towbookLogin(username: string, password: string, opts: TowbookLoginOptions = {}): Promise<TowbookLoginResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const loginUrl = opts.loginUrl ?? TOWBOOK_LOGIN;
  const origin = opts.origin ?? TOWBOOK_ORIGIN;
  const timeout = (ms: number) => opts.signal ?? AbortSignal.timeout(ms);
  const facts: TowbookFacts = { stage: "get", status: null, location: null, bodyLen: null, contentType: null, cookies: [], authCookieDetected: false, loginForm: false, bodyHint: "", hops: [] };
  const fail = (): TowbookLoginResult => {
    const fb = describeTowbookFailure(facts);
    return { ok: false, error: fb, facts };
  };
  try {
    // 1) GET the login page. The RequestVerificationToken and the antiforgery
    //    cookie are issued as a pair and ROTATE on every GET — the token below
    //    must pair with the cookie from THIS response (it does: both come from
    //    this same page fetch).
    const page = await fetchImpl(loginUrl, { headers: towbookBrowserHeaders(), signal: timeout(10000) });
    const html = await page.text();
    const preJar = jar(getSetCookies(page.headers));
    facts.status = page.status; facts.bodyLen = html.length;
    facts.contentType = page.headers.get("content-type"); facts.loginForm = hasLoginForm(html);
    facts.cookies = cookieFacts(getSetCookies(page.headers)); facts.bodyHint = html.slice(0, 200).toLowerCase();
    if (!page.ok) return fail();
    const token = html.match(/name=["']RequestVerificationToken["'][^>]*value=["']([^"']+)/i)?.[1];
    if (!token) return fail();
    // 2) POST exactly like a browser form: same field names/order, bSignIn is an
    //    empty-valued submit button (Towbook's HTML has no value attribute), and
    //    the full browser header set (UA, Origin, Referer, sec-fetch-*).
    const body = new URLSearchParams({ Username: username, Password: password, bSignIn: "", RequestVerificationToken: token });
    const login = await fetchImpl(loginUrl, { method: "POST", body, redirect: "manual", headers: towbookBrowserHeaders(preJar), signal: timeout(10000) });
    const respCookies = getSetCookies(login.headers);
    const postText = await login.text();
    facts.stage = "post"; facts.status = login.status; facts.location = login.headers.get("location");
    facts.bodyLen = postText.length; facts.contentType = login.headers.get("content-type");
    facts.cookies = cookieFacts(respCookies); facts.authCookieDetected = hasAuthCookie(respCookies);
    facts.loginForm = hasLoginForm(postText); facts.bodyHint = postText.slice(0, 200).toLowerCase();
    // 3) Interpret the response. ASP.NET Core cookie auth sets the session cookie
    //    in the success response's Set-Cookie; failed logins re-render the login
    //    page (200, observed with fake creds) or bounce with a redirect.
    if (login.status === 401 || login.status === 403) return fail();
    if (login.status >= 300 && login.status < 400) {
      if (facts.authCookieDetected) return { ok: true, cookies: mergeJars(preJar, jar(respCookies)), baseUrl: origin };
      // No auth cookie on the redirect itself: follow like a browser — the
      // session cookie may be set on the redirect target instead.
      let jarSoFar = mergeJars(preJar, jar(respCookies));
      let hop = login.headers.get("location");
      for (let i = 0; i < 3 && hop; i++) {
        const target = new URL(hop, origin);
        if (target.origin !== origin) { facts.location = target.toString(); break; }
        const r = await fetchImpl(target.toString(), { headers: towbookBrowserHeaders(jarSoFar), redirect: "manual", signal: timeout(10000) });
        const rc = getSetCookies(r.headers);
        const rtext = await r.text();
        facts.hops.push({ status: r.status, location: r.headers.get("location"), cookies: rc.map((c) => c.split(";")[0]) });
        jarSoFar = mergeJars(jarSoFar, jar(rc));
        facts.status = r.status; facts.location = r.headers.get("location");
        facts.bodyLen = rtext.length; facts.contentType = r.headers.get("content-type");
        facts.cookies = cookieFacts(rc); facts.authCookieDetected = hasAuthCookie(rc);
        facts.loginForm = hasLoginForm(rtext); facts.bodyHint = rtext.slice(0, 200).toLowerCase();
        if (hasAuthCookie(rc)) return { ok: true, cookies: jarSoFar, baseUrl: origin };
        if (facts.loginForm) break; // bounced back to the login page → bad credentials
        hop = r.headers.get("location");
      }
      return fail();
    }
    if (login.status === 200) {
      if (facts.authCookieDetected) return { ok: true, cookies: mergeJars(preJar, jar(respCookies)), baseUrl: origin };
      return fail();
    }
    return fail();
  } catch (err) {
    const msg = String(err);
    facts.stage = "network"; facts.bodyHint = msg.slice(0, 200);
    return {
      ok: false,
      error: { code: msg.includes("timeout") || msg.includes("fetch") ? "towbook_unreachable" : "towbook_blocked", message: "Towbook could not be connected. Try again or use an interactive reconnect." },
      facts,
    };
  }
}
