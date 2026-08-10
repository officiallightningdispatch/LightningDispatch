import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "~/components/app-shell";
import { PerformanceView } from "~/components/ops-views";

export const Route = createFileRoute("/owner/performance")({ component: OwnerPerformance });
function OwnerPerformance() {
  return (
    <AppShell portal="owner" title="Performance" description="How the business is running — from real jobs and history.">
      <PerformanceView />
    </AppShell>
  );
}
