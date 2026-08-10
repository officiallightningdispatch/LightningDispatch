import { createFileRoute } from "@tanstack/react-router"; import { PlaceholderRoute } from "~/components/app-shell";
export const Route=createFileRoute("/ops/active")({component:()=> <PlaceholderRoute title="ops/active" description="Active jobs"/>});
