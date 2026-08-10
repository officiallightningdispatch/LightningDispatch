import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "~/components/app-shell";
import { QueueView } from "~/components/ops-views";

export const Route = createFileRoute("/owner/queue")({ component: OwnerQueue });
function OwnerQueue() {
  return (
    <AppShell portal="owner" title="Dispatch queue" description="The same live queue the dispatchers see — assign straight from here.">
      <QueueView />
    </AppShell>
  );
}
