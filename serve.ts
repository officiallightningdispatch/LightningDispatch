// Production server for the built site. The TanStack Start build emits a portable
// fetch handler (dist/server/server.js) plus static client assets (dist/client);
// this wraps them in a Bun server on port 3000 — static files first, SSR for the
// rest. Run `bun run build` before starting. Restart it with `bun run publish`.
//
// Starting a new instance supersedes the old one: it frees the port no matter
// which user owns the current server (provisioning starts it as `engine`; a team
// member's `bun run publish` runs as their own user), so publish never collides
// with an already-running server. Every sandbox user has passwordless sudo, so
// the takeover works across user boundaries.
import handler from "./dist/server/server.js";

// Pinned, NOT read from the environment. The published preview URL
// (<label>.<PUBLIC_SITE_DOMAIN>) is reverse-proxied to 0.0.0.0:3000 inside the
// sandbox, so the default site MUST bind there. Bun auto-loads .env files, so
// honouring process.env.PORT/HOST would let a stray env var or a .env in the site
// dir silently move the site off :3000 (or onto loopback) and break the public URL.
const PORT = 3000;
const HOST = "0.0.0.0";
const CLIENT_DIR = `${import.meta.dir}/dist/client`;

// Free PORT regardless of which user owns the current listener. lsof runs under
// sudo so it can see (and the kill can signal) a process owned by another user;
// the loop waits for the socket to actually release before we bind.
const freePort =
  `for _ in $(seq 1 25); do ` +
  `pids=$(lsof -t -iTCP:${String(PORT)} -sTCP:LISTEN 2>/dev/null || true); ` +
  `if [ -z "$pids" ]; then exit 0; fi; ` +
  `kill $pids 2>/dev/null || true; sleep 0.2; ` +
  `done`;

// Take over the port, re-freeing and retrying if another publish grabbed it in the
// gap between freeing and binding (last publish wins). Bun.serve throws EADDRINUSE
// synchronously, so without this a raced publish would die while the shell already
// reported success.
for (let attempt = 1; ; attempt++) {
  await Bun.$`sudo sh -c ${freePort}`.quiet().nothrow();
  try {
    Bun.serve({
      port: PORT,
      hostname: HOST,
      async fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname !== "/") {
          const file = Bun.file(CLIENT_DIR + pathname);
          if (await file.exists()) return new Response(file);
        }
        return (
          handler as { fetch: (r: Request) => Response | Promise<Response> }
        ).fetch(req);
      },
    });
    break;
  } catch (err) {
    if (attempt >= 10) throw err;
    await Bun.sleep(200);
  }
}

console.log(`team-site serving on http://${HOST}:${String(PORT)}`);

// Warm the auth/migration promises before the first browser request. The old
// first-request safety net ran the schema DDL on the login hot path, making the
// initial authStatus call pay the full cold-start cost and competing with the
// first login/driver requests. This is best-effort: handlers retain their own
// safety nets for fresh databases and upgrade-path recovery.
try {
  const { ensureAuthSchema } = await import("./src/data/auth-server.ts");
  const { ensureSchema } = await import("./src/data/migrations.ts");
  await ensureAuthSchema();
  await ensureSchema();
} catch {
  /* the request handlers retry schema preparation when boot warmup fails */
}

// Owner-directed 2026-08-12 (resilience): start the 3s Towbook sync +
// auto-dispatch loop at server boot so a restart never leaves the dispatcher
// dead (it used to start only on the first authenticated request). Best-effort:
// when DATABASE_URL is absent at boot the loop simply doesn't start here and
// server.ts's first-prepare path starts it on the first authenticated request
// instead. startBackgroundSync is idempotent per process (global marker), so
// the dist bundle's own copy never starts a second loop.
try {
  const { startBackgroundSync } = await import("./src/data/background-sync.ts");
  startBackgroundSync();
} catch {
  /* best-effort — the first-prepare fallback still covers this */
}
// Owner-directed 2026-08-12 (contractor-admin): the MANDATED required-doc set
// (W-9, I-9, Driver's license + facial verification, Insurance information) is
// auto-seeded for the PRODUCTION org at boot — idempotent, so every publish
// re-checks and adds nothing once present. This SUPERSEDES the spec's original
// "suggestions, never auto-seeded" stance (owner mandate 2026-08-12). Audit
// rows are attributed to the org's first owner/admin member (best-effort).
// Best-effort like the sync loop: a DB outage at boot must not take the server
// down — the owner button and per-org on-demand paths still cover it.
try {
  const { ensureMandatedDocTypesForOrg } = await import("./src/data/contractor-admin-core.ts");
  const { PRODUCTION_ORG_ID } = await import("./src/data/db-guard.ts");
  await ensureMandatedDocTypesForOrg(PRODUCTION_ORG_ID);
} catch {
  /* best-effort — retried on every boot */
}
