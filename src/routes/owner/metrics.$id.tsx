import { createFileRoute, useParams } from "@tanstack/react-router";
import { AppShell } from "~/components/app-shell";
import { OwnerDriverMetricsView } from "~/components/metrics-views";

export const Route = createFileRoute("/owner/metrics/$id")({ component: OwnerDriverMetrics });
function OwnerDriverMetrics() {
  const { id } = useParams({ from: "/owner/metrics/$id" });
  return (
    <AppShell portal="owner" title="Driver metrics" description="One driver's performance — drilled into from the fleet view.">
      <OwnerDriverMetricsView driverId={id} />
    </AppShell>
  );
}
