import { createFileRoute } from "@tanstack/react-router";
import { Users } from "lucide-react";
import { AppShell } from "~/components/app-shell";
import { Button, EmptyState } from "~/components/ui";
export const Route = createFileRoute("/owner/team")({ component: () => <AppShell portal="owner" title="Team" description="Manage contractors and access."><EmptyState icon={Users} title="Add your first contractor" body="Invite contractors to build your roadside team." action={<Button>Invite contractor</Button>} /></AppShell> });
