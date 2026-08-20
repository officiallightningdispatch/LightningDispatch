import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "~/components/app-shell";
import { DriverServiceSelection } from "~/components/service-selection";
export const Route = createFileRoute("/driver/services")({ component: DriverServices });
function DriverServices() { return <AppShell portal="driver" title="Services" description="Tell dispatch which roadside services you provide."><DriverServiceSelection /></AppShell>; }
