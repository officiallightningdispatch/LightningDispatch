import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { ClipboardCheck } from "lucide-react";
import { AppShell } from "~/components/app-shell";
import { Button, Card, EmptyState } from "~/components/ui";
import {
  decideBatteryCompatibilityReview,
  listBatteryCompatibilityReviewRows,
} from "~/data/battery-compat";

type ReviewRow = {
  id: string;
  make: string;
  model: string;
  yearFrom: number;
  yearTo: number;
  trim: string | null;
  engine: string | null;
  batteryGroupSize: string;
  sourceReferenceInternal: string | null;
};

export const Route = createFileRoute("/owner/batteries")({
  component: BatteryCompatibilityReviews,
});

function BatteryCompatibilityReviews() {
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [error, setError] = useState("");
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const result = await listBatteryCompatibilityReviewRows();
      if (result.ok) {
        setRows(result.rows);
        setError("");
      } else {
        setError("Owner or admin access is required.");
      }
    } catch {
      setError("Could not load compatibility reviews.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (id: string, decision: "approve" | "reject") => {
    const reason = reasons[id]?.trim();
    if (decision === "reject" && !reason) {
      setError("A reason is required to reject a compatibility mapping.");
      return;
    }
    try {
      const result = await decideBatteryCompatibilityReview({
        data: { compatibilityId: id, decision, reason },
      });
      if (result.ok) {
        setRows((current) => current.filter((row) => row.id !== id));
        setError("");
      } else {
        setError(result.reason === "reason_required" ? "A reason is required to reject a compatibility mapping." : `Decision failed: ${result.reason}.`);
      }
    } catch {
      setError("Decision failed. Please try again.");
    }
  };

  return (
    <AppShell
      portal="owner"
      title="Battery compatibility reviews"
      description="Review fitment mappings before they can drive a battery recommendation."
    >
      {error && <p className="mb-4 rounded-xl bg-danger-50 p-3 text-sm text-danger-700">{error}</p>}
      {!rows.length ? (
        <EmptyState
          icon={ClipboardCheck}
          title="No pending reviews"
          body="Approved compatibility mappings are used only when their vehicle identity is an exact safe match."
        />
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <Card key={row.id} className="space-y-3 p-4">
              <div>
                <p className="font-bold">{row.yearFrom}–{row.yearTo} {row.make} {row.model}</p>
                <p className="text-sm text-ink-500">
                  Engine: {row.engine ?? "not specified"} · Battery group: {row.batteryGroupSize}
                </p>
                <p className="text-xs text-ink-400">
                  Source: {row.sourceReferenceInternal ?? "missing provenance"}
                </p>
              </div>
              <label className="block text-sm font-medium">
                Rejection reason
                <input
                  placeholder="Required when rejecting"
                  value={reasons[row.id] ?? ""}
                  onChange={(event) => setReasons((current) => ({ ...current, [row.id]: event.target.value }))}
                  className="mt-1 h-10 w-full rounded-lg border border-ink-200 px-3 text-sm"
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void decide(row.id, "approve")}>Approve</Button>
                <Button variant="danger-ghost" onClick={() => void decide(row.id, "reject")}>Reject</Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </AppShell>
  );
}
