/**
 * /owner/ratings — CUSTOMER RATINGS (owner command center).
 *
 * Real customer-survey data from job_completions.survey (JSONB), surfaced via
 * the already-merged `getSurveyRatings` serverFn (owner/admin/dispatcher →
 * whole org). Purely presentational: the server-side aggregation + drill-down
 * already ships in completion-core.ts (`surveyRatingsCore`); this view only
 * resolves display names and renders.
 *
 * Name resolution (client-side, no new server logic):
 *   1. ContractorSurveyRating.contractorId  ↔  ContractorRow.id   (users.id)
 *   2. ContractorSurveyRating.towbookDriverId ↔ ContractorRow.towbookDriverId
 *   3. fall back to matching rows' driverName keyed by towbookDriverId/driverId
 *   4. unattributed rated jobs (contractorId/towbookDriverId both null) surface
 *      as an "Unattributed rating" bucket so real data is never dropped.
 *
 * Empty state is honest — zero surveys renders "No customer ratings yet".
 */
import { createFileRoute } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, MessageSquareText, Star, UserRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "~/components/app-shell";
import { Avatar, BoardSkeleton, Card, EmptyState, StatCard } from "~/components/ui";
import { listContractors, type ContractorRow } from "~/data/contractor-management";
import {
  getSurveyRatings,
  type ContractorSurveyRating,
  type OwnerSurveyRow,
} from "~/data/completion";
import { SERVICE_LABELS } from "~/lib/job-ui";

export const Route = createFileRoute("/owner/ratings")({ component: OwnerRatings });

/** SERVICE_LABELS is typed to the ServiceType union; a real DB row may carry a
 *  value outside that union, so fall back to the raw string (never invent a
 *  label). */
const serviceLabel = (s: string): string =>
  (SERVICE_LABELS as Record<string, string>)[s] ?? s;

/** Resolve a human name for an aggregated contractor entry (real data only —
 *  see module docstring for the priority order). */
function resolveContractorName(
  c: ContractorSurveyRating,
  contractors: ContractorRow[],
  rows: OwnerSurveyRow[],
): string {
  if (c.contractorId) {
    const byId = contractors.find((r) => r.id === c.contractorId);
    if (byId?.name) return byId.name;
  }
  if (c.towbookDriverId) {
    const byTb = contractors.find((r) => r.towbookDriverId === c.towbookDriverId);
    if (byTb?.name) return byTb.name;
    const byRow = rows.find((r) => r.towbookDriverId === c.towbookDriverId && r.driverName);
    if (byRow?.driverName) return byRow.driverName;
  }
  if (c.contractorId) {
    const byRow = rows.find((r) => r.driverId === c.contractorId && r.driverName);
    if (byRow?.driverName) return byRow.driverName;
  }
  return c.contractorId || c.towbookDriverId
    ? `Contractor ${c.contractorId ?? c.towbookDriverId}`
    : "Unattributed rating";
}

/** The drill-down rows for a given contractor entry — filter `rows` by
 *  driverId (== contractorId) or towbookDriverId; the fully-unattributed
 *  bucket matches rows with neither key set. */
function rowsForContractor(c: ContractorSurveyRating, rows: OwnerSurveyRow[]): OwnerSurveyRow[] {
  return rows.filter((r) => {
    if (c.contractorId && r.driverId === c.contractorId) return true;
    if (c.towbookDriverId && r.towbookDriverId === c.towbookDriverId) return true;
    if (!c.contractorId && !c.towbookDriverId && !r.driverId && !r.towbookDriverId) return true;
    return false;
  });
}

function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${rating} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          className={`size-3.5 ${n <= rating ? "fill-accent-500 text-accent-500" : "text-ink-200"}`}
          aria-hidden="true"
        />
      ))}
    </span>
  );
}

const fmtDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";

function OwnerRatings() {
  const [contractors, setContractors] = useState<ContractorRow[]>([]);
  const [data, setData] = useState<{ contractors: ContractorSurveyRating[]; rows: OwnerSurveyRow[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    const roster = await listContractors({ data: { includeRemoved: true } });
    if (roster.ok) setContractors(roster.data);
    try {
      const ratings = await getSurveyRatings();
      setData(ratings);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Customer ratings could not be loaded.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const entries = useMemo(
    () => (data ? [...data.contractors].sort((a, b) => (b.averageRating ?? -1) - (a.averageRating ?? -1) || b.ratingCount - a.ratingCount) : []),
    [data],
  );
  const totalSurveys = useMemo(
    () => (data ? data.rows.length : 0),
    [data],
  );
  const ratedContractors = entries.filter((c) => c.ratingCount > 0).length;
  const orgAverage = useMemo(() => {
    const rated = entries.filter((c) => c.averageRating != null && c.ratingCount > 0);
    if (rated.length === 0) return null;
    const weighted = rated.reduce((sum, c) => sum + (c.averageRating ?? 0) * c.ratingCount, 0);
    const count = rated.reduce((sum, c) => sum + c.ratingCount, 0);
    return count ? weighted / count : null;
  }, [entries]);

  if (!data && !loadError) {
    return (
      <AppShell portal="owner" title="Ratings" description="Customer survey ratings from completed jobs.">
        <BoardSkeleton rows={3} />
      </AppShell>
    );
  }

  return (
    <AppShell
      portal="owner"
      title="Ratings"
      description="Customer survey ratings left at job completion — real data, no demo ratings."
    >
      <div className="space-y-6">
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <StatCard label="Rated surveys" value={totalSurveys} detail="completed-job customer surveys" />
          <StatCard label="Rated contractors" value={ratedContractors} detail={`${entries.length} contractor${entries.length === 1 ? "" : "s"} in the org`} />
          <StatCard
            label="Org average"
            value={orgAverage == null ? "—" : orgAverage.toFixed(2)}
            detail={orgAverage == null ? "no ratings yet" : "across all rated contractors"}
          />
        </section>

        {loadError && (
          <Card className="p-4">
            <p className="text-sm font-semibold text-danger-600">{loadError}</p>
            <button type="button" onClick={() => void load()} className="mt-2 text-xs font-bold text-brand-600 hover:underline">Try again</button>
          </Card>
        )}

        {data && entries.length === 0 && (
          <EmptyState
            icon={Star}
            title="No customer ratings yet"
            body="When a customer completes a job and leaves a star rating on the contractor's phone, the summary appears here."
          />
        )}

        {data && entries.length > 0 && (
          <Card className="overflow-hidden">
            {entries.map((c) => {
              const name = resolveContractorName(c, contractors, data.rows);
              const rows = rowsForContractor(c, data.rows);
              const key = c.contractorId ?? c.towbookDriverId ?? "unattributed";
              const open = openId === key;
              return (
                <div key={key} className="border-b border-ink-100 last:border-0">
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : key)}
                    aria-expanded={open}
                    className="flex min-h-16 w-full items-center gap-3 px-4 py-3.5 text-left transition-colors duration-150 hover:bg-hover"
                  >
                    <Avatar name={name} className="size-10 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-semibold">
                        <span className="break-words">{name}</span>
                      </p>
                      <p className="mt-0.5 text-xs tabular-nums text-ink-500">
                        {c.ratingCount} survey{c.ratingCount === 1 ? "" : "s"}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <div className="text-right">
                        <p className="text-sm font-bold tabular-nums text-ink-900">
                          {c.averageRating == null ? "—" : c.averageRating.toFixed(2)}
                        </p>
                        {c.averageRating != null && (
                          <p className="mt-0.5"><Stars rating={Math.round(c.averageRating)} /></p>
                        )}
                      </div>
                      {open ? <ChevronDown className="size-4 shrink-0 text-ink-400" /> : <ChevronRight className="size-4 shrink-0 text-ink-400" />}
                    </div>
                  </button>

                  {open && (
                    <div className="border-t border-ink-100 bg-ink-50/40">
                      {rows.length === 0 ? (
                        <p className="px-4 py-4 text-sm text-ink-400">No rated jobs found for this contractor.</p>
                      ) : (
                        <ul className="divide-y divide-ink-100">
                          {rows.map((r) => (
                            <li key={r.jobId} className="px-4 py-3.5 sm:px-6">
                              <div className="flex flex-wrap items-start gap-3">
                                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-ink-100 text-ink-500">
                                  <UserRound className="size-4" aria-hidden="true" />
                                </span>
                                <div className="min-w-0 flex-1">
                                  <p className="break-words text-sm font-semibold text-ink-800">{r.customerName || "Customer"}</p>
                                  <p className="text-xs text-ink-500">
                                    {serviceLabel(r.serviceType)} · completed {fmtDate(r.completedAt)}
                                  </p>
                                  {r.comment && (
                                    <p className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-ink-600">
                                      <MessageSquareText className="mt-0.5 size-3.5 shrink-0 text-ink-400" aria-hidden="true" />
                                      <span className="italic">“{r.comment}”</span>
                                    </p>
                                  )}
                                </div>
                                <div className="flex shrink-0 items-center gap-1.5">
                                  <span className="text-sm font-bold tabular-nums text-ink-900">{r.rating}</span>
                                  <Stars rating={r.rating} />
                                </div>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </Card>
        )}
      </div>
    </AppShell>
  );
}
