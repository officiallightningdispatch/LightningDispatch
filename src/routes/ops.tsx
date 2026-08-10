import { createFileRoute, Outlet } from "@tanstack/react-router";
import { OpsGate } from "~/components/portal-gate";
export const Route=createFileRoute("/ops")({component:()=> <OpsGate><Outlet/></OpsGate>});
