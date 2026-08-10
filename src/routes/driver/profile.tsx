import { createFileRoute } from "@tanstack/react-router"; import { PlaceholderRoute } from "~/components/app-shell";
export const Route=createFileRoute("/driver/profile")({component:()=> <PlaceholderRoute title="driver/profile" description="Profile"/>});
