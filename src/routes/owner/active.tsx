import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "~/components/app-shell";
import { ActiveJobsView } from "~/components/ops-views";

export const Route = createFileRoute("/owner/active")({ component: OwnerActive });
function OwnerActive() {
  return (
    <AppShell portal="owner" title="Active jobs" description="Every job in flight right now, across the fleet.">
      <ActiveJobsView />
    </AppShell>
  );
}
