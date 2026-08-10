import { Link, useLocation } from "@tanstack/react-router";
import { Zap, Home, Inbox, Briefcase, DollarSign, User, List, Users, History, BarChart3, Settings, Wallet } from "lucide-react";
import type { ReactNode } from "react";

export type Portal = "driver" | "ops" | "owner";

type NavItem = { to: string; label: string; icon: typeof Home };

/**
 * Per-portal navigation. The portal is EXPLICIT (never inferred from the page
 * title — that was the bug where /owner/settings, /owner/money, /owner/team and
 * /owner/performance rendered the ops nav, so "Queue" clicked out of the owner
 * portal). Every nav item stays inside its own portal's shell:
 * owner → /owner/*, ops → /ops/*, driver → /driver/*.
 */
const NAV: Record<Portal, { links: NavItem[]; mobile: NavItem[] }> = {
  owner: {
    links: [
      { to: "/owner", label: "Dashboard", icon: Home },
      { to: "/owner/queue", label: "Queue", icon: List },
      { to: "/owner/active", label: "Active Jobs", icon: Briefcase },
      { to: "/owner/history", label: "History", icon: History },
      { to: "/owner/performance", label: "Performance", icon: BarChart3 },
      { to: "/owner/money", label: "Money", icon: Wallet },
      { to: "/owner/team", label: "Team", icon: Users },
      { to: "/owner/settings", label: "Settings", icon: Settings },
    ],
    // Bottom bar on phones — a subset so labels fit; all still /owner/*.
    mobile: [
      { to: "/owner", label: "Dashboard", icon: Home },
      { to: "/owner/queue", label: "Queue", icon: List },
      { to: "/owner/active", label: "Active", icon: Briefcase },
      { to: "/owner/performance", label: "Performance", icon: BarChart3 },
      { to: "/owner/money", label: "Money", icon: Wallet },
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
      { to: "/driver/profile", label: "Profile", icon: User },
    ],
    mobile: [
      { to: "/driver", label: "Home", icon: Home },
      { to: "/driver/offers", label: "Offers", icon: Inbox },
      { to: "/driver/active", label: "Active", icon: Briefcase },
      { to: "/driver/earnings", label: "Earnings", icon: DollarSign },
      { to: "/driver/profile", label: "Profile", icon: User },
    ],
  },
};

const PORTAL_META: Record<Portal, { appLabel: string; portalLabel: string; mobileBottomPad: boolean }> = {
  driver: { appLabel: "Contractor app", portalLabel: "Contractor portal", mobileBottomPad: true },
  ops: { appLabel: "Dispatcher operations", portalLabel: "Dispatcher portal", mobileBottomPad: false },
  owner: { appLabel: "Owner command center", portalLabel: "Owner portal", mobileBottomPad: false },
};

export function AppShell({ portal, title, description, children }: { portal: Portal; title: string; description: string; children?: ReactNode }) {
  const location = useLocation();
  const { links, mobile } = NAV[portal];
  const meta = PORTAL_META[portal];
  return <div className={`min-h-dvh min-w-0 overflow-x-clip bg-canvas text-ink-900 ${meta.mobileBottomPad ? "pb-20" : ""}`}>
    <header className="border-b border-ink-100 bg-surface"><div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6"><Link to={links[0].to as any} className="flex items-center gap-3"><span className="grid size-9 place-items-center rounded-xl bg-brand-500"><Zap className="size-5 text-white" fill="currentColor" strokeWidth={0} /></span><strong className="text-sm font-bold">Lightning Dispatch OS</strong></Link><span className="hidden text-xs text-ink-400 sm:block">{meta.appLabel}</span></div></header>
    <div className="mx-auto flex max-w-7xl"><aside className="hidden w-56 shrink-0 border-r border-ink-100 py-5 pr-4 md:block"><nav className="space-y-1" aria-label="Portal navigation">{links.map(l => <Link key={l.to} to={l.to as any} className={`flex h-11 items-center gap-3 rounded-xl px-3 text-sm font-semibold ${location.pathname === l.to ? "bg-ink-950 text-white" : "text-ink-500 hover:bg-ink-50"}`}><l.icon className="size-4" />{l.label}</Link>)}</nav></aside>
    <main className={`min-w-0 flex-1 px-4 py-7 sm:px-6 ${portal === "driver" ? "mx-auto max-w-lg md:max-w-none" : ""}`}><div className="mb-7"><p className="mb-2 text-xs font-bold uppercase tracking-[.18em] text-brand-600">{meta.portalLabel}</p><h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1><p className="mt-1 text-sm text-ink-500">{description}</p></div>{children}</main>
    </div>
    <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-ink-100 bg-surface/95 p-1 backdrop-blur md:hidden" aria-label="Portal navigation">{mobile.map(l => <Link key={l.to} to={l.to as any} className={`flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg text-[11px] font-semibold ${location.pathname === l.to ? "text-brand-600" : "text-ink-500"}`}><l.icon className="size-4" /><span>{l.label}</span></Link>)}</nav>
  </div>;
}

/** Back-compat placeholder for routes that have not shipped a view yet. */
export function PlaceholderRoute({ portal = "ops", title, description }: { portal?: Portal; title: string; description: string }) {
  return <AppShell portal={portal} title={title} description={description}><div className="rounded-2xl border border-dashed border-ink-200 bg-surface p-8 text-center text-sm text-ink-500">This portal view is ready for the next content milestone.</div></AppShell>;
}
