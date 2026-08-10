import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "~/components/app-shell";
import { ContractorsView } from "~/components/ops-views";

export const Route = createFileRoute("/ops/contractors")({ component: Contractors });
function Contractors() {
  return (
    <AppShell portal="ops" title="Contractors" description="Who's on the fleet, who's online, and what they're doing.">
      <ContractorsView />
    </AppShell>
  );
}
