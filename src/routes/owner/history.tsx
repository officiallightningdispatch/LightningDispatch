import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "~/components/app-shell";
import { HistoryView } from "~/components/ops-views";

export const Route = createFileRoute("/owner/history")({ component: OwnerHistory });
function OwnerHistory() {
  return (
    <AppShell portal="owner" title="Job history" description="Completed jobs with their full status timeline.">
      <HistoryView />
    </AppShell>
  );
}
