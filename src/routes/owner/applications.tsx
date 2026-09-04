import { createFileRoute } from "@tanstack/react-router";
import { CheckCircle2, Clock, Inbox, UserRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "~/components/app-shell";
import { BoardSkeleton, Button, Card, EmptyState, StatusBadge } from "~/components/ui";
import {
  listContractorApplications,
  setContractorApplicationStatus,
  type ContractorApplicationWithUser,
} from "~/data/contractor-signup";

/**
 * /owner/applications — OWNER-SIDE application review (Slice 2 of the
 * contractor sign-up-on-login-screen feature, owner-directed 2026-09-04,
 * "Uber-style onboarding"). Renders the org's contractor applications and lets
 * the owner move each one between states.
 *
 * Access control is fully server-side: the facade's `listContractorApplications`
 * / `setContractorApplicationStatus` resolve the request actor and refuse
 * non-owner/admin actors (`unauthorized`), and this route lives under the
 * `/owner` layout whose OwnerGate blocks contractors before any data loads.
 * This component adds no client-side trust — a returned `unauthorized` result
 * is surfaced as an inline error and no action button is trusted to succeed.
 */
export const Route = createFileRoute("/owner/applications")({ component: ApplicationsView });

type Status = ContractorApplicationWithUser["status"];

/** Status badge chrome — mirrors the four-state machine in
 *  contractor-signup-core.ts (interested/submitted/activated/waitlisted). */
const STATUS_META: Record<Status, { label: string; className: string }> = {
  interested: { label: "Interested", className: "bg-ink-100 text-ink-600" },
  submitted: { label: "Submitted", className: "bg-info-100 text-info-700" },
  activated: { label: "Activated", className: "bg-success-100 text-success-700" },
  waitlisted: { label: "Waitlisted", className: "bg-accent-100 text-accent-800" },
};

/** Client-side render of ALLOWED_TRANSITIONS (mirrored from the core so the UI
 *  only offers buttons the server will accept). The server re-validates every
 *  call, so this is purely presentational. */
const ACTIONS: Record<Status, { status: Status; label: string; variant?: "primary" | "secondary" }[]> = {
  interested: [
    { status: "submitted", label: "Move to submitted", variant: "secondary" },
    { status: "waitlisted", label: "Waitlist", variant: "secondary" },
  ],
  submitted: [
    { status: "activated", label: "Activate", variant: "primary" },
    { status: "waitlisted", label: "Waitlist", variant: "secondary" },
  ],
  activated: [
    { status: "submitted", label: "Move back to submitted", variant: "secondary" },
    { status: "waitlisted", label: "Waitlist", variant: "secondary" },
  ],
  waitlisted: [
    { status: "submitted", label: "Move back to submitted", variant: "secondary" },
    { status: "activated", label: "Activate", variant: "primary" },
  ],
};

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function formatAgo(iso: string): string {
  const n = Math.max(0, Date.now() - Date.parse(iso));
  if (n < 60_000) return "Just now";
  if (n < 3_600_000) return `${Math.floor(n / 60_000)}m ago`;
  if (n < 86_400_000) return `${Math.floor(n / 3_600_000)}h ago`;
  return `${Math.floor(n / 86_400_000)}d ago`;
}

function ApplicationsView() {
  const [rows, setRows] = useState<ContractorApplicationWithUser[] | null>(null);
  const [listError, setListError] = useState("");
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await listContractorApplications();
    if (r.ok) {
      setRows(r.data);
      setListError("");
    } else {
      setListError(r.message);
      setRows((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (app: ContractorApplicationWithUser, status: Status) => {
    setBusyId(app.id);
    setRowErrors((m) => {
      const next = { ...m };
      delete next[app.id];
      return next;
    });
    try {
      const r = await setContractorApplicationStatus({ data: { applicationId: app.id, status } });
      if (r.ok) {
        await load();
      } else {
        setRowErrors((m) => ({ ...m, [app.id]: r.message }));
      }
    } catch (e) {
      setRowErrors((m) => ({ ...m, [app.id]: e instanceof Error ? e.message : "Unable to update the application." }));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <AppShell
      portal="owner"
      title="Applications"
      description="Review contractor applications from the sign-up screen and move each one through review."
    >
      {listError && (
        <div
          role="alert"
          className="mb-4 flex items-center gap-2 rounded-xl border border-danger-100 bg-danger-50 p-3.5 text-sm text-danger-700"
        >
          <span className="min-w-0">{listError}</span>
          <button type="button" onClick={() => void load()} className="ml-auto text-xs font-bold underline">
            Retry
          </button>
        </div>
      )}

      {rows === null ? (
        <BoardSkeleton rows={2} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No applications yet"
          body="When a contractor signs up from the login screen, their application appears here for your review."
        />
      ) : (
        <div className="space-y-3">
          {rows.map((a) => {
            const meta = STATUS_META[a.status];
            const err = rowErrors[a.id];
            return (
              <Card key={a.id} className="p-4">
                <div className="flex flex-wrap items-start gap-4">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-ink-100 text-ink-600">
                      <UserRound className="size-5" aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <strong className="truncate text-sm text-ink-900">
                          {a.applicantName ?? "Unnamed contractor"}
                        </strong>
                        <StatusBadge className={meta.className}>{meta.label}</StatusBadge>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-ink-500">
                        {a.applicantEmail ?? "no email"}
                        {a.phone ? ` · ${a.phone}` : ""}
                      </p>
                      <p className="mt-1 text-xs text-ink-500">
                        <span className="font-semibold text-ink-600">Service area:</span>{" "}
                        {a.serviceArea?.trim() ? a.serviceArea : "—"}
                      </p>
                      <p className="mt-1 text-xs text-ink-500">
                        <span className="font-semibold text-ink-600">Services:</span>{" "}
                        {a.tools.length ? a.tools.join(", ") : "—"}
                      </p>
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <span className="inline-flex items-center gap-1 text-[11px] text-ink-400">
                      <Clock className="size-3.5" aria-hidden="true" />
                      Submitted {formatAgo(a.createdAt)} · {formatDateTime(a.createdAt)}
                    </span>
                    {a.reviewerUserId && a.reviewedAt && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-ink-400">
                        <CheckCircle2 className="size-3.5 text-success-600" aria-hidden="true" />
                        Reviewed {formatDateTime(a.reviewedAt)}
                      </span>
                    )}
                    <div className="flex flex-wrap justify-end gap-2">
                      {ACTIONS[a.status].map((action) => (
                        <Button
                          key={action.status}
                          type="button"
                          size="sm"
                          variant={action.variant ?? "secondary"}
                          loading={busyId === a.id}
                          disabled={busyId !== null && busyId !== a.id}
                          onClick={() => void act(a, action.status)}
                        >
                          {action.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>

                {err && (
                  <p role="alert" className="mt-3 rounded-xl bg-danger-50 p-3 text-sm text-danger-600">
                    {err}
                  </p>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}
