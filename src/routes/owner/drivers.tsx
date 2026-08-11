import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "~/components/app-shell";
import { LiveDriverMap } from "~/components/live-driver-map";
export const Route = createFileRoute("/owner/drivers")({ component: OwnerDrivers });
function OwnerDrivers() {
  return (
    <AppShell portal="owner" title="Live drivers" description="Current positions from contractors' phones — refreshed every 15 seconds. A driver is stale when no ping has arrived for over 2 minutes.">
      <LiveDriverMap />
    </AppShell>
  );
}
