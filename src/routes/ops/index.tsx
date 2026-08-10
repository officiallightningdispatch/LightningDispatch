import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "~/components/app-shell";
import { QueueView } from "~/components/ops-views";

export const Route = createFileRoute("/ops/")({ component: DispatcherConsole });
function DispatcherConsole() {
  return (
    <AppShell portal="ops" title="Dispatch queue" description="Assign incoming jobs to the best available contractor.">
      <QueueView />
    </AppShell>
  );
}
