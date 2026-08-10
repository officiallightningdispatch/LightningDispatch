import { createFileRoute, Outlet } from "@tanstack/react-router";
import { OwnerGate } from "~/components/portal-gate";
export const Route=createFileRoute("/owner")({component:()=> <OwnerGate><Outlet/></OwnerGate>});
