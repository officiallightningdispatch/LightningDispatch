import { createFileRoute, Outlet } from "@tanstack/react-router";
/** Layout for /driver/academy. The landing lives in the index child
 *  (academy.index.tsx); the lesson detail is the $id child (academy.$id.tsx).
 *  Each child renders its own AppShell — this layout only mounts them (same
 *  pattern as /owner/metrics and /owner/contractors). */
export const Route = createFileRoute("/driver/academy")({
  component: () => <Outlet />,
});
