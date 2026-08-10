import { createFileRoute } from "@tanstack/react-router";
import { Users } from "lucide-react";
import { AppShell } from "~/components/app-shell";
import { EmptyState } from "~/components/ui";
export const Route = createFileRoute("/ops/contractors")({ component: () => <AppShell title="Contractors" description="Availability and dispatch coverage."><EmptyState icon={Users} title="Add your first contractor" body="The owner can invite contractors to the fleet." /></AppShell> });
