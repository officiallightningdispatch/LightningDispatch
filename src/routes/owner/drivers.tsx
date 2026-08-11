import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "~/components/app-shell";
import { LiveMap } from "~/components/live-map";
export const Route = createFileRoute("/owner/drivers")({ component: OwnerDrivers });
function OwnerDrivers() {
  return (
    <AppShell portal="owner" title="Live drivers" description="Real street map of driver positions and job pickups — refreshed every 15 seconds. A driver is stale when no ping has arrived for over 2 minutes.">
      <LiveMap
        showDriverList
        emptyTitle="Live map unavailable"
        emptyBody="Sign in with an owner account to see driver positions and active job pickups here."
      />
    </AppShell>
  );
}
