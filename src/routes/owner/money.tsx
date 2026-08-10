import { createFileRoute } from "@tanstack/react-router";
import { CreditCard } from "lucide-react";
import { AppShell } from "~/components/app-shell";
import { EmptyState } from "~/components/ui";
export const Route = createFileRoute("/owner/money")({ component: () => <AppShell portal="owner" title="Money" description="Revenue, profit, and payroll at a glance."><EmptyState icon={CreditCard} title="No financial data yet" body="Revenue, profit, and payroll appear once billing and payments are connected." /></AppShell> });
