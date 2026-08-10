import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "~/components/app-shell";
import { HistoryView } from "~/components/ops-views";

export const Route = createFileRoute("/ops/history")({ component: History });
function History() {
  return (
    <AppShell portal="ops" title="Job history" description="Completed jobs with their status timeline.">
      <HistoryView />
    </AppShell>
  );
}
