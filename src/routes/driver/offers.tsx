import { createFileRoute } from "@tanstack/react-router"; import { PlaceholderRoute } from "~/components/app-shell";
export const Route=createFileRoute("/driver/offers")({component:()=> <PlaceholderRoute portal="driver" title="driver/offers" description="Offers"/>});
