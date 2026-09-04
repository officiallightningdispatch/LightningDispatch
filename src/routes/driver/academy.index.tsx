import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "~/components/app-shell";
import { AcademyLandingView } from "~/components/metrics-views";

export const Route = createFileRoute("/driver/academy/")({ component: DriverAcademyLanding });
function DriverAcademyLanding() {
  return (
    <AppShell portal="driver" title="Academy" description="Your personal coaching library.">
      <AcademyLandingView />
    </AppShell>
  );
}
