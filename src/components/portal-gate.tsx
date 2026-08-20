import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { authStatus, type AuthUser, type Role } from "~/data/auth";
import { DriverGpsTracker } from "~/components/driver-gps-tracker";

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

/** Driver-portal gate decision (owner↔contractor view toggle, 2026-08-12):
 *  contractors always pass; owner/admin pass only with a non-deactivated
 *  driver identity (their own towbook_driver_id — shape a — or a linked
 *  driver — shape b; owner-confirmed Q1: admins included). Everything else is
 *  rejected. Exported as a pure function so the hermetic suites can assert the
 *  gate logic without a DOM; the component uses it verbatim. */
export function driverGateAllows(user: Pick<AuthUser, "role" | "driverIdentity"> | null): boolean {
  if (!user) return false;
  if (user.role === "contractor") return true;
  if (user.role === "owner" || user.role === "admin") {
    return Boolean(user.driverIdentity && !user.driverIdentity.deactivated);
  }
  return false;
}

export function PortalGate({ children, roles, allowDriverIdentity }: { children: ReactNode; roles: Role[]; allowDriverIdentity?: boolean }) {
  const nav = useNavigate(); const loc = useLocation();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    // Render nothing until authStatus resolves. Previously children rendered
    // immediately: an unauthenticated user saw the portal flash before the
    // redirect to /login (the owner's report), and a signed-in user could be
    // bounced after a transient first read. A failed auth check is still an
    // infrastructure error, not proof of sign-out — retain the portal on error.
    void authStatus().then((s) => {
      if (s.mode !== "database" && !s.user) void nav({ to: "/login", search: { next: loc.pathname } as any, replace: true });
      else if (s.mode === "database" && s.user && !roles.includes(s.user.role)) {
        // DriverGate extension: staff with an effective driver identity may
        // enter the driver portal (view toggle). Everything else → 403 with a
        // reason so the copy can explain the no-driver case.
        if (allowDriverIdentity && driverGateAllows(s.user)) setReady(true);
        else void nav({ to: "/403", search: (allowDriverIdentity ? { reason: "no-driver" } : {}) as any, replace: true });
      }
      else setReady(true);
    }).catch(() => { /* retain the portal; allow a later check/retry */ setReady(true); });
  }, [nav, loc.pathname, roles, allowDriverIdentity]);
  if (!ready) return <GateSkeleton />;
  return <>{children}</>;
}
export const DriverGate = ({ children }: { children: ReactNode }) => (
  <PortalGate roles={["contractor"]} allowDriverIdentity>
    <DriverGpsTracker>{children}</DriverGpsTracker>
  </PortalGate>
);
// Owner is the boss: owner + admin have full access to the ops workspace too.
// Contractors are still restricted to their own portal via DriverGate (never weakened).
export const OpsGate = ({ children }: { children: ReactNode }) => <PortalGate roles={["owner", "admin", "dispatcher"]}>{children}</PortalGate>;
export const OwnerGate = ({ children }: { children: ReactNode }) => <PortalGate roles={["owner", "admin"]}>{children}</PortalGate>;
