import { HeadContent, Outlet, Scripts, createRootRoute, Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { authStatus } from "~/data/auth";
import { Route as RouteIcon } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState } from "~/components/ui";
import { ToastProvider } from "~/components/ui";
import { DispatchStoreProvider } from "~/lib/store";
import appCss from "~/styles/app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Lightning Dispatch OS" },
      {
        name: "description",
        content:
          "Lightning Dispatch OS — the AI-assisted operations platform for Lightning Roadside Assistants. Dispatch, contractor, and owner tools in one mobile-first system.",
      },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
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

function AuthGate({children}:{children:ReactNode}) { return <>{children}</>; }

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
