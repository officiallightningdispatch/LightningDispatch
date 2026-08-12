import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { ShieldX } from "lucide-react";
import { EmptyState } from "~/components/ui";
export const Route=createFileRoute('/403')({component:Forbidden});
function Forbidden(){
  // The driver-portal gate passes a reason when it rejects someone: no-driver =
  // signed-in staff who do not hold a driver identity (view-toggle spec §2).
  const search = useSearch({ from: "/403" as any }) as { reason?: string };
  const noDriver = search.reason === "no-driver";
  return <main className="grid min-h-dvh place-items-center bg-canvas px-4"><div className="w-full max-w-sm">
    <EmptyState icon={ShieldX} title={noDriver ? "No driver identity on this account" : "Access restricted"}
      body={noDriver ? "Your account isn't linked to a driver identity, so the driver app isn't available here. If you also drive, ask an owner to link your driver account from Settings." : "Your account does not have access to this workspace."}
      action={<Link to="/" className="text-sm font-semibold text-brand-600">Return home</Link>}/>
  </div></main>;
}
