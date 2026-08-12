import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "~/components/app-shell";
import { DriverMetricsView } from "~/components/metrics-views";

export const Route = createFileRoute("/driver/metrics")({ component: DriverMetrics });
function DriverMetrics() {
  return (
    <AppShell portal="driver" title="Metrics" description="Your performance — and how to improve it.">
      <DriverMetricsView />
    </AppShell>
  );
}
