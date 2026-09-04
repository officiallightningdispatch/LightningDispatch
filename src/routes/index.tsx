import { Link } from "@tanstack/react-router";
import { LogIn, Zap } from "lucide-react";
import { createFileRoute } from "@tanstack/react-router";
import { LegalLinks } from "~/components/legal-page";
export const Route=createFileRoute("/")({component:Landing});
// Single-entry landing: ONE sign-in CTA. Roles are decided by the account
// server-side; the login page routes each user to their own workspace. There is
// deliberately no role selector here — lines never cross.
function Landing(){
  return <main className="grid min-h-dvh bg-canvas text-ink-900">
    <div className="mx-auto flex w-full max-w-md flex-col px-6 py-10 sm:py-16">
      {/* Brand header */}
      <header className="flex items-center gap-3">
        <span className="grid size-11 place-items-center rounded-2xl bg-brand-500">
          <Zap className="size-6 text-white" fill="currentColor" strokeWidth={0} aria-hidden="true"/>
        </span>
        <strong className="text-lg tracking-tight">Lightning Dispatch OS</strong>
      </header>

      {/* Value statement */}
      <section className="flex flex-1 flex-col justify-center py-14 sm:py-20">
        <p className="text-sm font-bold uppercase tracking-[.2em] text-brand-600">Roadside operations, unified</p>
        <h1 className="mt-4 text-4xl font-extrabold tracking-tight sm:text-5xl">Move every job forward.</h1>
        <p className="mt-5 max-w-sm text-lg leading-7 text-ink-500">
          One calm, intelligent system for contractors, dispatchers, and owners.
        </p>
      </section>

      {/* The single entry point */}
      <Link
        to="/login"
        className="inline-flex h-13 min-h-[52px] w-full items-center justify-center gap-2 rounded-2xl bg-brand-500 px-6 text-base font-semibold text-white shadow-card transition-colors duration-150 hover:bg-brand-600 active:scale-[0.99] motion-reduce:transform-none"
      >
        <LogIn className="size-5" aria-hidden="true"/>
        Sign in
      </Link>

      {/* Informational strip — text only, never a role choice */}
      <p className="mt-6 text-center text-sm leading-6 text-ink-400">
        Drivers&nbsp;·&nbsp;Dispatchers&nbsp;·&nbsp;Owners&nbsp;—&nbsp;one login routes you to your workspace.
      </p>

      {/* Legal / support links — discoverable for review */}
      <div className="mt-8 flex justify-center">
        <LegalLinks />
      </div>
    </div>
  </main>;
}
