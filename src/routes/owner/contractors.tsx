import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Layout for /owner/contractors. The roster lives in the index child
 *  (contractors.index.tsx); the per-contractor detail screen is the $id child
 *  (contractors.$id.tsx). Each child renders its own AppShell — this layout
 *  only mounts them. (Fixed 2026-08-13: this file used to render the roster
 *  page itself with no <Outlet/>, so /owner/contractors/<id> never mounted
 *  the detail route and the owner could not approve pending documents.) */
export const Route = createFileRoute("/owner/contractors")({
  component: () => <Outlet />,
});
