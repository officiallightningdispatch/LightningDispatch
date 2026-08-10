import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { authStatus, type Role } from "~/data/auth";

export function GateSkeleton() {
  return (
    <main className="grid min-h-dvh place-items-center bg-canvas px-4">
      <div className="flex flex-col items-center gap-3" role="status" aria-live="polite">
        <div className="size-8 animate-spin rounded-full border-2 border-brand-500 border-t-transparent motion-reduce:animate-none" aria-hidden="true" />
        <p className="text-sm font-medium text-ink-400">Loading your workspace…</p>
      </div>
    </main>
  );
}

export function PortalGate({ children, roles }: { children: ReactNode; roles: Role[] }) {
  const nav = useNavigate(); const loc = useLocation();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    // Render nothing until authStatus resolves. Previously children rendered
    // immediately: an unauthenticated user saw the portal flash before the
    // redirect to /login (the owner's report), and a signed-in user could be
    // bounced after a transient first read. A failed auth check is still an
    // infrastructure error, not proof of sign-out — retain the portal on error.
    void authStatus().then((s) => {
      if (s.mode !== "demo" && !s.user) void nav({ to: "/login", search: { next: loc.pathname } as any, replace: true });
      else if (s.mode !== "demo" && s.user && !roles.includes(s.user.role)) void nav({ to: "/403", replace: true });
      else setReady(true);
    }).catch(() => { /* retain the portal; allow a later check/retry */ setReady(true); });
  }, [nav, loc.pathname, roles]);
  if (!ready) return <GateSkeleton />;
  return <>{children}</>;
}
export const DriverGate = ({ children }: { children: ReactNode }) => <PortalGate roles={["contractor"]}>{children}</PortalGate>;
export const OpsGate = ({ children }: { children: ReactNode }) => <PortalGate roles={["dispatcher", "admin"]}>{children}</PortalGate>;
export const OwnerGate = ({ children }: { children: ReactNode }) => <PortalGate roles={["owner", "admin"]}>{children}</PortalGate>;
