import { createFileRoute } from "@tanstack/react-router";
import { DriverGate } from "~/components/portal-gate";
import { Outlet } from "@tanstack/react-router";
export const Route=createFileRoute("/driver")({component:()=> <DriverGate><Outlet/></DriverGate>});
