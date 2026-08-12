import { createFileRoute, useParams } from "@tanstack/react-router";
import { AppShell } from "~/components/app-shell";
import { DriverClaimSignView } from "~/components/claims-ui";
export const Route = createFileRoute("/driver/claims/$id")({ component: DriverClaimSign });
function DriverClaimSign() {
  const { id } = useParams({ from: "/driver/claims/$id" });
  return (
    <AppShell portal="driver" title="Claim Review" description="Your statement for the damage claim — review and sign.">
      <DriverClaimSignView claimId={id} />
    </AppShell>
  );
}
