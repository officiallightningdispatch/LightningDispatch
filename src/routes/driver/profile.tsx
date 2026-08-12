import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { BadgeCheck, CalendarClock, Camera, ChevronRight, Crown, FileText, LifeBuoy, LogOut, Truck, User, Wallet } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AppShell } from "~/components/app-shell";
import { DriverToolbar } from "~/components/driver-queue";
import { resizeImageToJpeg } from "~/components/driver-photos-ui";
import { Avatar, Card } from "~/components/ui";
import { authStatus } from "~/data/auth";
import { driverLogout, driverProfile, type DriverProfileResult } from "~/data/driver-auth";
import { getMyProfilePhoto, uploadMyProfilePhoto } from "~/data/driver-profile-photo";

/**
 * /driver/profile — the driver's account card: dispatch identity, login, and
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
    await driverLogout(); // best-effort checkout so we're not left "online"
    void nav({ to: "/login", replace: true });
  };
  const name = profile?.ok ? profile.name : user?.user?.name ?? "Driver";
  // Internal @towbook.driver placeholder addresses are never shown to drivers
  // (white-label 2026-08-12) — defensive mask on the authStatus fallback too.
  const rawEmail = profile?.ok ? profile.email : user?.user?.email ?? "";
  const email = rawEmail.toLowerCase().endsWith("@towbook.driver") ? "" : rawEmail;
  const driverId = profile?.ok ? profile.towbookDriverId : "";
  // Owner↔contractor view toggle: an owner/admin in driver view sees their hat
  // (spec §1b badge swap) + a one-tap way back to the owner dashboard.
  const staffDriverView = Boolean(user?.user && (user.user.role === "owner" || user.user.role === "admin") && user.user.driverIdentity && !user.user.driverIdentity.deactivated);

  /* Feature batch 7 — profile photo: fetch the current avatar once, upload a
   * new one via B2 (same infra as the job-photo workflow), refresh the header
   * avatar through the shared module cache in app-shell (window reload of the
   * avatar link is implicit — the shell re-fetches on mount). */
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let stopped = false;
    void getMyProfilePhoto().then((res) => { if (!stopped && res.ok) setPhotoUrl(res.dataUrl); });
    return () => { stopped = true; };
  }, []);
  const onPickPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setPhotoBusy(true);
    setPhotoError(null);
    try {
      const dataUrl = await resizeImageToJpeg(file, 640, 0.85);
      const res = await uploadMyProfilePhoto({ data: { dataUrl } });
      if (!res.ok) { setPhotoError(res.message); return; }
      const got = await getMyProfilePhoto();
      if (got.ok && got.dataUrl) setPhotoUrl(got.dataUrl);
    } catch {
      setPhotoError("We couldn't read that photo — try another one.");
    } finally {
      setPhotoBusy(false);
    }
  };
  return (
    <AppShell portal="driver" title="Profile" description="Your account details and sign-out.">
      <DriverToolbar loading={loading} onRefresh={() => undefined} onSignOut={() => void signOut()} />
      {loading ? (
        <div className="h-40 animate-pulse rounded-2xl bg-ink-100/70" aria-busy="true" />
      ) : (
        <div className="space-y-4">
          <Card className="flex items-center gap-4 p-4">
            <div className="relative shrink-0">
              <Avatar name={name} src={photoUrl} className="size-14" />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={photoBusy}
                aria-label="Change profile photo"
                className="absolute -bottom-1 -right-1 grid size-7 place-items-center rounded-full border-2 border-surface bg-ink-950 text-white shadow-sm transition-transform active:scale-90 disabled:opacity-50"
              >
                <Camera className="size-3.5" aria-hidden="true" />
              </button>
              <input ref={fileRef} type="file" accept="image/*" capture="user" className="hidden" onChange={(e) => void onPickPhoto(e)} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-lg font-bold text-ink-800">{name}</p>
              {email && <p className="truncate text-sm text-ink-500">{email}</p>}
              {staffDriverView ? (
                <p className="mt-1 inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">
                  <Crown className="size-3.5" /> Owner (driver view)
                </p>
              ) : (
                <p className="mt-1 inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700">
                  <BadgeCheck className="size-3.5" /> Contractor
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={photoBusy}
              className="shrink-0 rounded-xl border border-ink-200 px-3 py-2 text-xs font-bold text-ink-600 transition-colors hover:bg-hover disabled:opacity-50"
            >
              {photoBusy ? "Saving…" : photoUrl ? "Change" : "Add photo"}
            </button>
          </Card>
          {photoError && (
            <p className="rounded-xl border border-danger-200 bg-danger-50 px-3 py-2 text-xs font-semibold text-danger-600" role="alert">{photoError}</p>
          )}
          <Link
            to="/driver/documents"
            className="flex items-center gap-3 rounded-2xl bg-surface p-4 ring-1 ring-ink-100 transition-colors duration-150 hover:bg-hover"
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
              <FileText className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-ink-800">Documents</span>
              <span className="block text-xs text-ink-500">Upload required paperwork — W-9, I-9, license, insurance</span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-ink-400" />
          </Link>
          <Link
            to="/driver/schedule"
            className="flex items-center gap-3 rounded-2xl bg-surface p-4 ring-1 ring-ink-100 transition-colors duration-150 hover:bg-hover"
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
              <CalendarClock className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-ink-800">Availability schedule</span>
              <span className="block text-xs text-ink-500">Set the days and hours you typically work</span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-ink-400" />
          </Link>
          <Link
            to="/driver/payout"
            className="flex items-center gap-3 rounded-2xl bg-surface p-4 ring-1 ring-ink-100 transition-colors duration-150 hover:bg-hover"
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
              <Wallet className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-ink-800">Payout method</span>
              <span className="block text-xs text-ink-500">Cash App, Venmo, Zelle or bank — how you get paid</span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-ink-400" />
          </Link>
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
          {staffDriverView && (
            <Link
              to="/owner"
              className="flex items-center gap-3 rounded-2xl bg-surface p-4 ring-1 ring-ink-100 transition-colors duration-150 hover:bg-hover"
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
                <Crown className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold text-ink-800">Switch back to owner dashboard</span>
                <span className="block text-xs text-ink-500">Management settings and the full dispatch board</span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-ink-400" />
            </Link>
          )}
          <Card className="p-4">
            <dl className="space-y-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <dt className="flex items-center gap-2 text-ink-500"><Truck className="size-4" /> Driver ID</dt>
                <dd className="font-mono font-semibold text-ink-800">{driverId || "—"}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="flex items-center gap-2 text-ink-500"><User className="size-4" /> Sign-in</dt>
                <dd className="font-semibold text-ink-800">Lightning Dispatch login</dd>
              </div>
            </dl>
          </Card>
          <Card className="p-4">
            <p className="text-sm leading-relaxed text-ink-500">
              Your Lightning Dispatch login is your driver account — one account, one password. Jobs you accept stay in sync
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
