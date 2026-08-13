import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Layout for /owner/metrics. The fleet view lives in the index child
 *  (metrics.index.tsx); the per-driver drill-in is the $id child
 *  (metrics.$id.tsx). Each child renders its own AppShell — this layout only
 *  mounts them. (Fixed 2026-08-13: this file used to render the fleet view
 *  itself with no <Outlet/>, so /owner/metrics/<id> never mounted.) */
export const Route = createFileRoute("/owner/metrics")({
  component: () => <Outlet />,
});
