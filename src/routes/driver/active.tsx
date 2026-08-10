import { createFileRoute } from "@tanstack/react-router"; import { PlaceholderRoute } from "~/components/app-shell";
export const Route=createFileRoute("/driver/active")({component:()=> <PlaceholderRoute portal="driver" title="driver/active" description="Active job"/>});
