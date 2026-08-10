import { createFileRoute } from "@tanstack/react-router"; import { PlaceholderRoute } from "~/components/app-shell";
export const Route=createFileRoute("/ops/history")({component:()=> <PlaceholderRoute title="ops/history" description="History"/>});
