import {
  createCsrfMiddleware,
  createMiddleware,
  createStart,
} from "@tanstack/react-start";

// The Capacitor native shell serves the SPA build from a non-web origin:
//   iOS     → capacitor://localhost
//   Android → https://localhost
// These are trusted first-party origins that call the deployed backend
// (https://www.lightningdispatch.app) cross-origin via server functions. The
// web/SSR build stays same-origin and never matches these origins, so its
// behavior is unchanged.
const NATIVE_ORIGINS = [
  "capacitor://localhost",
  "https://localhost",
  "http://localhost",
] as const;

const isNativeOrigin = (origin: string | null | undefined) =>
  origin != null && (NATIVE_ORIGINS as readonly string[]).includes(origin);

// CORS + OPTIONS preflight for the server-function route only. The native SPA
// client points its server-function RPC at the live backend (cross-origin), so
// the webview preflights every POST. This middleware answers the preflight and
// stamps CORS headers onto the response — but ONLY for the trusted native
// origins. Same-origin (web) and unrelated cross-site callers pass through
// untouched, keeping the SSR/web path byte-identical.
const serverFnCors = createMiddleware().server(async (ctx) => {
  if (ctx.handlerType !== "serverFn") return ctx.next();

  const origin = ctx.request.headers.get("Origin");
  if (!isNativeOrigin(origin)) return ctx.next();

  const corsHeaders = (): Record<string, string> => ({
    "Access-Control-Allow-Origin": origin as string,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  });

  if (ctx.request.method === "OPTIONS") {
    const headers = new Headers(corsHeaders());
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set(
      "Access-Control-Allow-Headers",
      ctx.request.headers.get("Access-Control-Request-Headers") ??
        "content-type, x-tsr-serverfn",
    );
    headers.set("Access-Control-Max-Age", "86400");
    return new Response(null, { status: 204, headers });
  }

  const result = await ctx.next();
  const headers = new Headers(result.response.headers);
  for (const [key, value] of Object.entries(corsHeaders())) {
    headers.set(key, value);
  }
  return {
    ...result,
    response: new Response(result.response.body, {
      status: result.response.status,
      statusText: result.response.statusText,
      headers,
    }),
  };
});

// CSRF protection for server functions: replicate the framework default
// (same-origin allowed) and additionally allow the trusted native-shell
// origins. Everything else stays rejected (403).
const serverFnCsrf = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
  secFetchSite: (value, ctx) => {
    if (value === "same-origin") return true;
    return isNativeOrigin(ctx.request.headers.get("Origin"));
  },
  origin: (value, ctx) => {
    if (value === new URL(ctx.request.url).origin) return true;
    return isNativeOrigin(value);
  },
});

// Server functions default to credentials: "same-origin", so the native shell
// would never send the ld_session_v2 cookie to the live backend. Force
// credentials: "include" for cross-origin (absolute http(s)) server-function
// URLs only; same-origin (web) calls pass `init` through unchanged.
const serverFnsFetch: typeof fetch = (input, init) => {
  const href =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const crossOrigin = /^https?:\/\//.test(href);
  return fetch(
    input,
    crossOrigin ? { ...init, credentials: "include" as const } : init,
  );
};

export const startInstance = createStart(() => ({
  requestMiddleware: [serverFnCors, serverFnCsrf],
  serverFns: { fetch: serverFnsFetch },
}));
