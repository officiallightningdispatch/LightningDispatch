import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { BadgeCheck, ChevronRight, LifeBuoy, LogOut, Truck, User } from "lucide-react";
import { useEffect, useState } from "react";
import { AppShell } from "~/components/app-shell";
import { DriverToolbar } from "~/components/driver-queue";
import { Avatar, Card } from "~/components/ui";
import { authStatus } from "~/data/auth";
import { driverLogout, driverProfile, type DriverProfileResult } from "~/data/driver-auth";

/**
 * /driver/profile — the driver's account card: Towbook identity, login, and
 * sign out. Real data from the LD user row behind the contractor session.
 */
export const Route = createFileRoute("/driver/profile")({ component: ProfileView });

function ProfileView() {
  const nav = useNavigate();
  const [profile, setProfile] = useState<DriverProfileResult | null>(null);
  const [user, setUser] = useState<Awaited<ReturnType<typeof authStatus>> | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    void (async () => {
      const [p, s] = await Promise.all([driverProfile(), authStatus()]);
      setProfile(p);
      setUser(s);
      setLoading(false);
    })();
  }, []);
  const signOut = async () => {
    await driverLogout(); // best-effort Towbook checkout so we're not left "online"
    void nav({ to: "/login", replace: true });
  };
  const name = profile?.ok ? profile.name : user?.user?.name ?? "Driver";
  const email = profile?.ok ? profile.email : user?.user?.email ?? "";
  const driverId = profile?.ok ? profile.towbookDriverId : "";
  return (
    <AppShell portal="driver" title="Profile" description="Your account details and sign-out.">
      <DriverToolbar loading={loading} onRefresh={() => undefined} onSignOut={() => void signOut()} />
      {loading ? (
        <div className="h-40 animate-pulse rounded-2xl bg-ink-100/70" aria-busy="true" />
      ) : (
        <div className="space-y-4">
          <Card className="flex items-center gap-4 p-4">
            <Avatar name={name} className="size-14" />
            <div className="min-w-0">
              <p className="truncate text-lg font-bold text-ink-800">{name}</p>
              {email && <p className="truncate text-sm text-ink-500">{email}</p>}
              <p className="mt-1 inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700">
                <BadgeCheck className="size-3.5" /> Contractor
              </p>
            </div>
          </Card>
          <Link
            to="/driver/help"
            className="flex items-center gap-3 rounded-2xl bg-surface p-4 ring-1 ring-ink-100 transition-colors duration-150 hover:bg-hover"
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
              <LifeBuoy className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-ink-800">Help &amp; Support</span>
              <span className="block text-xs text-ink-500">Call dispatch (475) 219-8328 or report a problem</span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-ink-400" />
          </Link>
          <Card className="p-4">
            <dl className="space-y-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <dt className="flex items-center gap-2 text-ink-500"><Truck className="size-4" /> Towbook driver ID</dt>
                <dd className="font-mono font-semibold text-ink-800">{driverId || "—"}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="flex items-center gap-2 text-ink-500"><User className="size-4" /> Sign-in</dt>
                <dd className="font-semibold text-ink-800">Towbook credentials</dd>
              </div>
            </dl>
          </Card>
          <Card className="p-4">
            <p className="text-sm leading-relaxed text-ink-500">
              Your Towbook login is your Lightning Dispatch login — one account, one password. Jobs you accept stay in sync
              with the dispatch board automatically.
            </p>
          </Card>
          <button
            type="button"
            onClick={() => void signOut()}
            className="flex w-full items-center justify-center gap-2 rounded-2xl border border-danger-200 bg-danger-50 px-4 py-3 text-sm font-semibold text-danger-600"
          >
            <LogOut className="size-4" /> Sign out
          </button>
        </div>
      )}
    </AppShell>
  );
}
