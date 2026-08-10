import { createFileRoute } from "@tanstack/react-router";
import { Plug, X } from "lucide-react";
import { useState } from "react";
import { AppShell } from "~/components/app-shell";
import { Button, Card } from "~/components/ui";

export const Route = createFileRoute("/owner/settings")({ component: OwnerSettings });

function OwnerSettings() {
  const [open, setOpen] = useState(false);
  return <AppShell title="Settings" description="Keep your organization and integrations connected.">
    <Card className="border-brand-200 bg-gradient-to-br from-brand-50/70 to-surface p-6 sm:p-8">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-4"><span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-brand-500 text-white"><Plug className="size-6" /></span><div><p className="text-xs font-bold uppercase tracking-wider text-brand-700">Dispatch integration</p><h2 className="mt-1 text-xl font-bold">Connect Towbook</h2><p className="mt-1 max-w-lg text-sm text-ink-500">Bring live roadside jobs into Lightning Dispatch and keep your queue current.</p></div></div>
        <Button className="shrink-0" onClick={() => setOpen(true)}>Connect Towbook</Button>
      </div>
    </Card>
    {open && <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/40 p-4" role="dialog" aria-modal="true" aria-labelledby="towbook-title"><Card className="w-full max-w-md p-6"><div className="flex items-start justify-between gap-4"><div><span className="grid size-10 place-items-center rounded-xl bg-brand-50 text-brand-600"><Plug className="size-5" /></span><h2 id="towbook-title" className="mt-4 text-xl font-bold">Connect Towbook</h2></div><button className="grid size-11 place-items-center rounded-xl text-ink-400 hover:bg-ink-50" aria-label="Close" onClick={() => setOpen(false)}><X className="size-5" /></button></div><p className="mt-4 text-sm leading-relaxed text-ink-600">You'll sign into Towbook securely through Lightning Dispatch. Once connected, live Towbook jobs will populate your dispatch queue automatically.</p><p className="mt-4 rounded-xl border border-accent-200 bg-accent-50 p-3 text-xs leading-relaxed text-accent-800"><strong>Integration coming next</strong> — requires your Towbook API access.</p><Button className="mt-6 w-full" variant="secondary" onClick={() => setOpen(false)}>Got it</Button></Card></div>}
  </AppShell>;
}
