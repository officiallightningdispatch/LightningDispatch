import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { logout } from "~/data/auth";

/**
 * /logout — a real sign-out page (owner batch 2026-08-12). The session cookie
 * and DB session row are destroyed by the server fn, then the user lands back
 * on /login. Every portal gate bounces unauthenticated users there, so this
 * route simply fires the logout and navigates; no user state is read here.
 */
export const Route = createFileRoute("/logout")({ component: LogoutView });

function LogoutView() {
  const nav = useNavigate();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    void (async () => {
      try {
        await logout(); // POST: destroys session (DB row + cookies)
      } catch {
        // The server fn itself deletes rows + expires cookies before returning
        // ok, so a network-level failure still leaves the local session dead on
        // the next request. Never trap the user — navigate either way.
      }
      try {
        await nav({ to: "/login", replace: true });
      } catch {
        setFailed(true);
      }
    })();
  }, [nav]);
  if (failed) {
    return (
      <main className="grid min-h-dvh place-items-center bg-canvas px-4">
        <div className="w-full max-w-sm rounded-2xl border border-ink-100 bg-surface p-6 text-center shadow-card">
          <p className="text-sm font-bold text-ink-700">Signed out</p>
          <p className="mt-1 text-xs text-ink-500">Your session was closed — return to the sign-in page to log back in.</p>
          <button
            type="button"
            onClick={() => void nav({ to: "/login", replace: true }).catch(() => setFailed(true))}
            className="mt-4 inline-flex h-10 w-full items-center justify-center rounded-xl bg-brand-500 px-5 text-sm font-bold text-white transition-colors hover:bg-brand-600"
          >
            Go to sign in
          </button>
        </div>
      </main>
    );
  }
  return (
    <main className="grid min-h-dvh place-items-center bg-canvas px-4" role="status" aria-live="polite">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="size-8 animate-spin rounded-full border-2 border-brand-500 border-t-transparent motion-reduce:animate-none" aria-hidden="true" />
        <p className="text-sm font-medium text-ink-400">Signing you out…</p>
      </div>
    </main>
  );
}
