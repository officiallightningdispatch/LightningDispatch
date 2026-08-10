import { createFileRoute, Link } from "@tanstack/react-router";
import { ShieldX } from "lucide-react";
import { EmptyState } from "~/components/ui";
export const Route=createFileRoute('/403')({component:Forbidden});
function Forbidden(){return <main className="grid min-h-dvh place-items-center bg-canvas px-4"><div className="w-full max-w-sm"><EmptyState icon={ShieldX} title="Access restricted" body="Your account does not have access to this workspace." action={<Link to="/" className="text-sm font-semibold text-brand-600">Return home</Link>}/></div></main>}
