import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "~/components/app-shell";
import { AiEscalationsBanner } from "~/components/ai-dispatcher-views";
import { QueueView } from "~/components/ops-views";

export const Route = createFileRoute("/ops/")({ component: DispatcherConsole });
function DispatcherConsole() {
  return (
    <AppShell portal="ops" title="Dispatch queue" description="Assign incoming jobs to the best available contractor.">
      <div className="space-y-6">
        <AiEscalationsBanner />
        <QueueView />
      </div>
    </AppShell>
  );
}
