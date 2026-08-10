import { createFileRoute } from "@tanstack/react-router"; import { PlaceholderRoute } from "~/components/app-shell";
export const Route=createFileRoute("/driver/earnings")({component:()=> <PlaceholderRoute portal="driver" title="driver/earnings" description="Earnings"/>});
