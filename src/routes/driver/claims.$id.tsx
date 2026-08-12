import { createFileRoute, useParams } from "@tanstack/react-router";
import { AppShell } from "~/components/app-shell";
import { DriverClaimSignView } from "~/components/claims-ui";
export const Route = createFileRoute("/driver/claims/$id")({ component: DriverClaimSign });
function DriverClaimSign() {
  const { claimId } = useParams({ from: "/driver/claims/$claimId" });
  return (
    <AppShell portal="driver" title="Claim Review" description="Your statement for the damage claim — review and sign.">
      <DriverClaimSignView claimId={claimId} />
    </AppShell>
  );
}
