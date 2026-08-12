import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "~/components/app-shell";
import { OwnerMetricsView } from "~/components/metrics-views";

export const Route = createFileRoute("/owner/metrics")({ component: OwnerMetrics });
function OwnerMetrics() {
  return (
    <AppShell portal="owner" title="Metrics" description="Fleet performance — tracked by Towbook, synced live.">
      <OwnerMetricsView />
    </AppShell>
  );
}
