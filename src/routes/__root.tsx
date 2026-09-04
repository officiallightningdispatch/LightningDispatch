import { HeadContent, Outlet, Scripts, createRootRoute, Link, useLocation, useNavigate } from "@tanstack/react-router";
import { Route as RouteIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { EmptyState } from "~/components/ui";
import { ToastProvider } from "~/components/ui";
import { DispatchStoreProvider } from "~/lib/store";
import { installPushReceivedListener } from "~/lib/push-received";
import { authStatus } from "~/data/auth";
import appCss from "~/styles/app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: "Lightning Dispatch OS" },
      {
        name: "description",
        content:
          "Lightning Dispatch OS — the AI-assisted operations platform for Lightning Roadside Assistants. Dispatch, contractor, and owner tools in one mobile-first system.",
      },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-title", content: "Lightning Dispatch" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "manifest", href: "/manifest.webmanifest" },
    ],
  }),
  notFoundComponent: () => (
    <div className="grid min-h-dvh place-items-center bg-canvas px-4">
      <div className="w-full max-w-sm">
        <EmptyState
          icon={RouteIcon}
          title="Page not found"
          body="That address doesn't match anything in the dispatch system. Head back to the console."
          action={
            <Link
              to="/"
              className="inline-flex h-11 items-center justify-center rounded-xl bg-brand-500 px-4 text-sm font-semibold text-white transition-colors duration-150 hover:bg-brand-600 active:scale-[0.98] motion-reduce:transform-none"
            >
              Back to dispatch
            </Link>
          }
        />
      </div>
    </div>
  ),
  component: RootComponent,
});

function RootComponent() {
  return (
    <ToastProvider>
      <DispatchStoreProvider>
        <RootDocument>
          <AuthGate><Outlet /></AuthGate>
        </RootDocument>
      </DispatchStoreProvider>
    </ToastProvider>
  );
}

const isPublicPath = (path: string) =>
  path === "/" ||
  path === "/login" ||
  path === "/403" ||
  path === "/logout" ||
  path === "/privacy" ||
  path === "/terms" ||
  path === "/support" ||
  path === "/deleted";

function AuthGate({ children }: { children: ReactNode }) {
  const loc = useLocation(); const nav = useNavigate();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    const publicPath = isPublicPath(loc.pathname);
    // Public routes own their auth work. In particular, /login needs one status
    // check to decide whether to show first-run setup or redirect an existing
    // session; calling authStatus here as well created two concurrent status
    // requests before the form could render. Keep the gate entirely out of the
    // public path so login latency is not doubled and logout remains immediate.
    if (publicPath) { setReady(true); return () => { live = false; }; }
    void authStatus().then((s) => {
      if (!live) return;
      if (s.mode !== "database") { void nav({ to: "/login", search: { next: loc.pathname } as any, replace: true }); return; }
      if (!s.user) { void nav({ to: "/login", search: { next: loc.pathname } as any, replace: true }); return; }
      setReady(true);
    }).catch(() => { if (live) void nav({ to: "/login", replace: true }); });
    return () => { live = false; };
  }, [loc.pathname, nav]);
  if (!ready && loc.pathname !== "/" && loc.pathname !== "/login") return <GateSkeleton />;
  return <>{children}</>;
}

function GateSkeleton() { return <main className="grid min-h-dvh place-items-center bg-canvas"><p className="text-sm text-ink-500">Checking your session…</p></main>; }

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <PushReceivedSound />
        {children}
        <Scripts />
      </body>
    </html>
  );
}

/** Mounts the SW push-received bridge once (client only): when the service
 *  worker delivers a push to an open window it posts LD_PUSH_RECEIVED — this
 *  is the listener that makes the phone SOUND the owner's exact alert MP3
 *  (the missing half of the round-trip — see src/lib/push-received.ts).
 *  Renders nothing. */
function PushReceivedSound() {
  useEffect(() => installPushReceivedListener(), []);
  return null;
}
