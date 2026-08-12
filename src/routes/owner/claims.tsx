import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "~/components/app-shell";
import { OwnerClaimsView } from "~/components/claims-ui";
export const Route = createFileRoute("/owner/claims")({ component: OwnerClaims });
function OwnerClaims() {
  return (
    <AppShell portal="owner" title="Damage Claims" description="Auto-detected from the owner's inbox — review, approve, and send.">
      <OwnerClaimsView />
    </AppShell>
  );
}
