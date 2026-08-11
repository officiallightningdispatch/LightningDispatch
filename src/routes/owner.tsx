import { createFileRoute, Outlet } from "@tanstack/react-router";
import { OwnerGate } from "~/components/portal-gate";
import { OwnerNotificationLayer } from "~/components/notify-banners";
export const Route = createFileRoute("/owner")({
  component: () => (
    <OwnerGate>
      <OwnerNotificationLayer />
      <Outlet />
    </OwnerGate>
  ),
});
