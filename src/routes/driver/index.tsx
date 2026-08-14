import { createFileRoute } from "@tanstack/react-router";
import { RealDriverPortal } from "~/components/driver-portal";
import { DriverGate } from "~/components/portal-gate";

export const Route = createFileRoute("/driver/")({
  component: () => <DriverGate><RealDriverPortal /></DriverGate>,
});
