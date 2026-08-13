import { Link, useLocation } from "@tanstack/react-router";
import { CarFront, Home, Inbox, Briefcase, DollarSign, LayoutDashboard, List, LogOut, MoreHorizontal, Settings, User, UserRound, Users, History, BarChart3, Wallet, Bot, Map, UserCog, Zap, FileWarning } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { authStatus, type AuthUser } from "~/data/auth";
import { getMyProfilePhoto } from "~/data/driver-profile-photo";
import { Avatar } from "~/components/ui";

export type Portal = "driver" | "ops" | "owner";

/** Module-level one-shot cache: the profile photo is fetched once per session
 *  (the driver's avatar) and reused across the header/profile screens; a
 *  re-upload resets it via the hook's reload. */
let cachedProfilePhoto: { dataUrl: string | null; at: number } | null = null;
function useProfilePhoto(portal: Portal) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    if (portal !== "driver") { setDataUrl(null); return; }
    let stopped = false;
    const fiveMin = 5 * 60 * 1000;
    if (cachedProfilePhoto && Date.now() - cachedProfilePhoto.at < fiveMin) {
      setDataUrl(cachedProfilePhoto.dataUrl);
      return;
    }
    void getMyProfilePhoto().then((res) => {
      if (stopped) return;
      const url = res.ok ? res.dataUrl : null;
      cachedProfilePhoto = { dataUrl: url, at: Date.now() };
      setDataUrl(url);
    });
    return () => { stopped = true; };
  }, [portal, reloadKey]);
  return { dataUrl, reload: () => setReloadKey((k) => k + 1) };
}

type NavItem = { to: string; label: string; icon: typeof Home };
type PortalNav = { links: NavItem[]; mobile: NavItem[]; more?: NavItem[] };

/**
 * Per-portal navigation. The portal is EXPLICIT (never inferred from the page
 * title — that was the bug where /owner/settings, /owner/money, /owner/team and
 * /owner/performance rendered the ops nav, so "Queue" clicked out of the owner
 * portal). Every nav item stays inside its own portal's shell:
 * owner → /owner/*, ops → /ops/*, driver → /driver/*.
 */
const NAV: Record<Portal, PortalNav> = {
  owner: {
    links: [
      { to: "/owner", label: "Dashboard", icon: Home },
      { to: "/owner/queue", label: "Queue", icon: List },
      { to: "/owner/active", label: "Active Jobs", icon: Briefcase },
      { to: "/owner/drivers", label: "Live Map", icon: Map },
      { to: "/owner/contractors", label: "Contractors", icon: UserCog },
      { to: "/owner/history", label: "History", icon: History },
      { to: "/owner/metrics", label: "Metrics", icon: BarChart3 },
      { to: "/owner/claims", label: "Claims", icon: FileWarning },
      { to: "/owner/money", label: "Payments", icon: Wallet },
      { to: "/owner/ai-dispatcher", label: "AI Dispatcher", icon: Bot },
      { to: "/owner/settings", label: "Settings", icon: Settings },
    ],
    // Bottom bar on phones — OWNER DECISION 2026-08-12 (locked): 5 primary
    // (Dashboard, Queue, Active, Contractors, Payments) + a "More" sheet
    // holding Metrics, Claims, AI Dispatcher, Settings. Contractors stays on
    // the rail (owner-directed). Live Map stays in the desktop sidebar only.
    mobile: [
      { to: "/owner", label: "Dashboard", icon: Home },
      { to: "/owner/queue", label: "Queue", icon: List },
      { to: "/owner/active", label: "Active", icon: Briefcase },
      { to: "/owner/contractors", label: "Contractors", icon: UserCog },
      { to: "/owner/money", label: "Payments", icon: Wallet },
    ],
    // Secondary owner destinations — surfaced through the "More" bottom sheet.
    more: [
      { to: "/owner/metrics", label: "Metrics", icon: BarChart3 },
      { to: "/owner/claims", label: "Claims", icon: FileWarning },
      { to: "/owner/ai-dispatcher", label: "AI Dispatcher", icon: Bot },
      { to: "/owner/settings", label: "Settings", icon: Settings },
    ],
  },
  ops: {
    links: [
      { to: "/ops", label: "Queue", icon: List },
      { to: "/ops/active", label: "Active Jobs", icon: Briefcase },
      { to: "/ops/contractors", label: "Contractors", icon: Users },
      { to: "/ops/history", label: "History", icon: History },
    ],
    mobile: [
      { to: "/ops", label: "Queue", icon: List },
      { to: "/ops/active", label: "Active Jobs", icon: Briefcase },
      { to: "/ops/contractors", label: "Contractors", icon: Users },
      { to: "/ops/history", label: "History", icon: History },
    ],
  },
  driver: {
    links: [
      { to: "/driver", label: "Home", icon: Home },
      { to: "/driver/offers", label: "Offers", icon: Inbox },
      { to: "/driver/active", label: "Active", icon: Briefcase },
      { to: "/driver/earnings", label: "Earnings", icon: DollarSign },
      { to: "/driver/metrics", label: "Metrics", icon: BarChart3 },
      { to: "/driver/profile", label: "Profile", icon: User },
    ],
    mobile: [
      { to: "/driver", label: "Home", icon: Home },
      { to: "/driver/offers", label: "Offers", icon: Inbox },
      { to: "/driver/active", label: "Active", icon: Briefcase },
      { to: "/driver/earnings", label: "Earnings", icon: DollarSign },
      { to: "/driver/metrics", label: "Metrics", icon: BarChart3 },
      { to: "/driver/profile", label: "Profile", icon: User },
    ],
  },
};

const PORTAL_META: Record<Portal, { appLabel: string; portalLabel: string; mobileBottomPad: boolean }> = {
  driver: { appLabel: "Contractor app", portalLabel: "Contractor portal", mobileBottomPad: true },
  ops: { appLabel: "Dispatcher operations", portalLabel: "Dispatcher portal", mobileBottomPad: false },
  owner: { appLabel: "Owner command center", portalLabel: "Owner portal", mobileBottomPad: false },
};

/** Session identity for the view-toggle chrome (owner↔contractor, 2026-08-12).
 *  One shared helper: staffWithDriver = owner/admin with a non-deactivated
 *  driver identity (own towbook_driver_id or a linked driver — Q1 admins
 *  included). The header pill (owner portal) and the persistent driver-view
 *  banner (driver portal) both key off it. */
function useSessionIdentity(): { user: AuthUser | null; staffWithDriver: boolean; driverName: string | null } {
  const [user, setUser] = useState<AuthUser | null>(null);
  useEffect(() => {
    let live = true;
    void authStatus().then((s) => { if (live && s.user) setUser(s.user); }).catch(() => { /* chrome hides on failure */ });
    return () => { live = false; };
  }, []);
  const staffWithDriver = Boolean(user && (user.role === "owner" || user.role === "admin") && user.driverIdentity && !user.driverIdentity.deactivated);
  return { user, staffWithDriver, driverName: staffWithDriver && user?.driverIdentity ? user.driverIdentity.driverName : null };
}

/** §1a — the owner-header "Driver view" affordance (secondary pill; never in
 *  the ops portal, never for contractors, never without a driver identity). */
function DriverViewPill() {
  return (
    <Link
      to="/driver"
      aria-label="Switch to the driver app"
      title="See the app the way your drivers do"
      className="inline-flex h-11 items-center gap-2 rounded-full border border-ink-200 bg-surface px-3.5 text-sm font-semibold text-ink-700 transition-colors hover:bg-hover active:scale-[0.98] motion-reduce:transform-none focus:outline-2 focus:outline-brand-500/40 sm:h-9"
    >
      <CarFront className="size-4" aria-hidden="true" /> Driver view
    </Link>
  );
}

export function AppShell({
  portal,
  title,
  description,
  children,
  slim = false,
  headerActions,
}: {
  portal: Portal;
  title: string;
  description: string;
  children?: ReactNode;
  /** Slim = the Uber-style chrome: ONLY the brand header row + bottom tab bar
   *  (no eyebrow/h1/description block), and the main area goes flush (px-0,
   *  py-0, no max-width) so a full-bleed map hero can fill the screen. Other
   *  portals and non-slim driver pages are unchanged. */
  slim?: boolean;
  /** Extra controls rendered on the right side of the header row (driver
   *  portal: GO/Offline pill + "?" Help icon). Header-actions area is
   *  ml-auto so the brand stays left. */
  headerActions?: ReactNode;
}) {
  const location = useLocation();
  const { links, mobile, more } = NAV[portal];
  const [moreOpen, setMoreOpen] = useState(false);
  const meta = PORTAL_META[portal];
  const identity = useSessionIdentity();
  const { dataUrl: profilePhotoUrl } = useProfilePhoto(portal);
  /** A nav item is active on its exact path, or on any sub-route of it (so the
   *  Contractors tab stays highlighted on /owner/contractors/:id). The bare
   *  portal roots stay exact-only — Dashboard must not highlight on every
   *  /owner/* page. */
  const isActive = (to: string) => location.pathname === to || (to !== "/owner" && to !== "/ops" && to !== "/driver" && location.pathname.startsWith(to + "/"));
  // Default header action: a real Sign out link on the owner/ops portals (the
  // driver portal passes its own GO/Offline + Help actions). /logout destroys
  // the session server-side and lands the user on /login — owner batch
  // 2026-08-12 (previously there was no sign-out route at all).
  const actions = headerActions ?? (portal === "driver" ? null : (
    <Link to="/logout" className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-ink-200 px-3 text-xs font-bold text-ink-600 transition-colors hover:bg-ink-50 hover:text-ink-800" aria-label="Sign out">
      <LogOut className="size-3.5" aria-hidden="true" /> Sign out
    </Link>
  ));
  return <div className={`min-h-dvh min-w-0 overflow-x-clip bg-canvas text-ink-900 ${meta.mobileBottomPad ? "pb-20" : ""}`}>
    <header className="border-b border-ink-100 bg-surface"><div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6"><Link to={links[0].to as any} className="flex items-center gap-3"><span className="grid size-9 place-items-center rounded-xl bg-brand-500"><Zap className="size-5 text-white" fill="currentColor" strokeWidth={0} /></span><strong className="text-sm font-bold">Lightning Dispatch OS</strong></Link><span className="hidden text-xs text-ink-400 sm:block">{meta.appLabel}</span>{actions || portal === "driver" ? <div className="ml-auto flex items-center gap-2">{identity.staffWithDriver && portal === "owner" ? <DriverViewPill /> : null}{actions}{portal === "driver" && (
  // Feature batch 7: the driver's profile photo (or initials) as the header
  // avatar → taps into Profile, where the photo is uploaded/changed.
  <Link to="/driver/profile" aria-label="Profile" className="flex items-center">
    <Avatar name={identity.driverName ?? "Driver"} src={profilePhotoUrl} className="size-9" />
  </Link>
)}</div> : null}</div></header>
    {identity.staffWithDriver && portal === "driver" && (
      // §1b — persistent view-mode banner on every driver page for staff in
      // driver view. Never dismissible: the owner must never forget which hat
      // they're wearing. Brand-tinted attention state (NOT yellow — reserved).
      <div className="border-b border-brand-200 bg-brand-50">
        <div className="mx-auto flex h-11 max-w-7xl items-center justify-between gap-2 px-4 text-xs sm:px-6">
          <p className="flex min-w-0 items-center gap-2 font-bold text-brand-800">
            <UserRound className="size-4 shrink-0 text-brand-600" aria-hidden="true" />
            <span className="truncate">Viewing as {identity.driverName ?? "driver"} · Owner</span>
          </p>
          <Link
            to="/owner"
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-ink-200 bg-surface px-3 text-[13px] font-semibold text-ink-700 transition-colors hover:bg-hover"
          >
            <LayoutDashboard className="size-3.5" aria-hidden="true" /> Back to owner view
          </Link>
        </div>
      </div>
    )}
    <div className="mx-auto flex max-w-7xl"><aside className="hidden w-56 shrink-0 border-r border-ink-100 py-5 pr-4 md:block"><nav className="space-y-1" aria-label="Portal navigation">{links.map(l => <Link key={l.to} to={l.to as any} className={`flex h-11 items-center gap-3 rounded-xl px-3 text-sm font-semibold ${isActive(l.to) ? "bg-ink-950 text-white" : "text-ink-500 hover:bg-ink-50"}`}><l.icon className="size-4" />{l.label}</Link>)}</nav></aside>
    <main className={`min-w-0 flex-1 px-4 py-7 sm:px-6 ${portal === "driver" ? "mx-auto max-w-lg md:max-w-none" : ""} ${slim ? "max-w-none px-0 py-0" : ""}`}>{!slim && <div className="mb-7"><p className="mb-2 text-xs font-bold uppercase tracking-[.18em] text-brand-600">{meta.portalLabel}</p><h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1><p className="mt-1 text-sm text-ink-500">{description}</p></div>}{children}</main>
    </div>
    <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-ink-100 bg-surface/95 p-1 backdrop-blur md:hidden" aria-label="Portal navigation">{mobile.map(l => <Link key={l.to} to={l.to as any} className={`flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg text-[11px] font-semibold ${isActive(l.to) ? "text-brand-600" : "text-ink-500"}`}><l.icon className="size-4" /><span>{l.label}</span></Link>)}{more && more.length > 0 ? <button type="button" onClick={() => setMoreOpen(true)} aria-haspopup="dialog" aria-expanded={moreOpen} aria-label="More options" className={`flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg text-[11px] font-semibold ${more.some(l => isActive(l.to)) ? "text-brand-600" : "text-ink-500"}`}>
        <MoreHorizontal className="size-4" aria-hidden="true" />
        <span>More</span>
      </button> : null}</nav>
    {moreOpen && more && more.length > 0 && (
      <div className="fixed inset-0 z-40 bg-ink-950/40 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label="More options" onClick={() => setMoreOpen(false)}>
        <div className="absolute inset-x-0 bottom-0 rounded-t-3xl bg-surface p-3 pb-6 shadow-[0_-8px_24px_rgba(14,14,17,0.16)]" onClick={(e) => e.stopPropagation()}>
          <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-ink-200" aria-hidden="true" />
          <p className="mb-2 px-1 text-xs font-bold uppercase tracking-wider text-ink-400">More</p>
          <div className="grid grid-cols-2 gap-2">
            {more.map(l => (
              <Link key={l.to} to={l.to as any} onClick={() => setMoreOpen(false)} className={`flex min-h-14 flex-col items-center justify-center gap-1.5 rounded-2xl border px-2 text-center text-xs font-semibold transition-colors ${isActive(l.to) ? "border-brand-200 bg-brand-50 text-brand-700" : "border-ink-100 bg-surface text-ink-600 hover:bg-ink-50"}`}>
                <l.icon className="size-5" aria-hidden="true" />
                <span>{l.label}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    )}
  </div>;
}

/** Back-compat placeholder for routes that have not shipped a view yet. */
export function PlaceholderRoute({ portal = "ops", title, description }: { portal?: Portal; title: string; description: string }) {
  return <AppShell portal={portal} title={title} description={description}><div className="rounded-2xl border border-dashed border-ink-200 bg-surface p-8 text-center text-sm text-ink-500">This portal view is ready for the next content milestone.</div></AppShell>;
}
