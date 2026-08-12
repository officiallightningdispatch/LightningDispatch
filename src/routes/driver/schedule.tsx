/**
 * /driver/schedule — the contractor's weekly availability template (Contractor
 * Management v2, owner-directed 2026-08-12). Seven day rows (Mon–Sun), each
 * with an on/off toggle + 24h start/end times; "Add day" = re-enable a day
 * that was turned off. The template is a repeating commitment ("I'm typically
 * available Mon–Fri 8a–5p"), NOT a date-specific shift list — GO/Offline stays
 * the on-demand override on top (the pill governs right now; the template
 * tells dispatch when to expect you). White-label copy only — no backend brand
 * ever appears. When the owner has taken over the schedule (owner_override),
 * the editor is read-only with a "Set by owner" notice and saves are refused
 * server-side too.
 */
import { createFileRoute } from "@tanstack/react-router";
import { CalendarClock, ChevronLeft, Lock, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { AppShell } from "~/components/app-shell";
import { DriverToolbar } from "~/components/driver-queue";
import { InlineError } from "~/components/mutation-status";
import { Button, Card, useToast } from "~/components/ui";
import { getMySchedule, setMySchedule, type ContractorScheduleRow } from "~/data/contractor-admin";
import { driverLogout } from "~/data/driver-auth";

export const Route = createFileRoute("/driver/schedule")({ component: ScheduleView });

const DAY_LABELS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
/** "08:00" → "8:00a" for the summary line; "17:00" → "5:00p". */
function fmtTime(t: string): string {
  const [h, m] = t.split(":").map(Number);
  const period = h >= 12 ? "p" : "a";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m ? `:${String(m).padStart(2, "0")}` : ""}${period}`;
}

type Day = { day: number; start: string; end: string };
type Row = Day & { on: boolean };

function ScheduleView() {
  const toast = useToast();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [ownerOverride, setOwnerOverride] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    const r = await getMySchedule().catch(() => null);
    if (!r || !r.ok) { setLoading(false); setError("Couldn't load your schedule — pull to refresh."); return; }
    apply(r.data);
    setLoading(false);
  };
  const apply = (s: ContractorScheduleRow) => {
    setOwnerOverride(s.ownerOverride);
    const map = new Map(s.schedule.map((d) => [d.day, d]));
    setRows(DAY_LABELS.map((_, i) => {
      const day = i + 1;
      const existing = map.get(day);
      return existing ? { ...existing, on: true } : { day, start: "08:00", end: "17:00", on: false };
    }));
  };

  useEffect(() => { void load(); }, []);

  const toggle = (day: number) => setRows((prev) => prev?.map((r) => (r.day === day ? { ...r, on: !r.on } : r)) ?? prev);
  const setTime = (day: number, key: "start" | "end", value: string) =>
    setRows((prev) => prev?.map((r) => (r.day === day ? { ...r, [key]: value } : r)) ?? prev);

  const save = async () => {
    if (!rows || ownerOverride) return;
    const schedule = rows.filter((r) => r.on);
    for (const r of schedule) {
      if (r.start >= r.end) { setError(`${DAY_LABELS[r.day - 1]}: start must come before the end time.`); return; }
    }
    setError("");
    setSaving(true);
    const res = await setMySchedule({ data: { schedule: schedule.map(({ day, start, end }) => ({ day, start, end })) } }).catch(() => null);
    setSaving(false);
    if (!res || !res.ok) { setError(res && res.ok === false ? res.message : "Couldn't save your schedule — try again."); return; }
    apply(res.data);
    toast("Schedule saved — dispatch can now see when you're typically available.");
  };

  const activeCount = rows?.filter((r) => r.on).length ?? 0;
  const summary = rows && activeCount > 0
    ? rows.filter((r) => r.on).sort((a, b) => a.day - b.day).map((r) => `${DAY_LABELS[r.day - 1].slice(0, 3)} ${fmtTime(r.start)}–${fmtTime(r.end)}`).join(" · ")
    : "No days set yet — dispatch sees you as available around the clock.";

  return (
    <AppShell portal="driver" title="Schedule" description="When you're typically available — a weekly template, not a shift list.">
      <DriverToolbar loading={loading} onRefresh={() => void load()} onSignOut={() => void driverLogout()} />
      <div className="space-y-4">
        <a href="/driver/profile" className="inline-flex items-center gap-1 text-sm font-semibold text-ink-500 hover:text-ink-700">
          <ChevronLeft className="size-4" /> Profile
        </a>

        <Card className="p-4">
          <div className="flex items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
              <CalendarClock className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-ink-900">Weekly availability</p>
              <p className="mt-0.5 text-xs leading-relaxed text-ink-500">{summary}</p>
              {ownerOverride && (
                <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-bold text-amber-700">
                  <Lock className="size-3" /> Set by owner — reach out to dispatch to change it
                </p>
              )}
            </div>
          </div>
        </Card>

        {error && <InlineError message={error} />}

        <Card className="overflow-hidden">
          <p className="border-b border-ink-100 px-4 py-3 text-xs font-bold uppercase tracking-wide text-ink-400">Days you work</p>
          <ul>
            {rows?.map((r, i) => (
              <li key={r.day} className={`flex items-center gap-3 px-4 py-3 ${i > 0 ? "border-t border-ink-100" : ""}`}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={r.on}
                  aria-label={`${DAY_LABELS[r.day - 1]} available`}
                  disabled={ownerOverride}
                  onClick={() => toggle(r.day)}
                  className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:opacity-50 ${
                    r.on ? "bg-brand-500" : "bg-ink-200"
                  }`}
                >
                  <span aria-hidden="true" className={`inline-block size-5 transform rounded-full bg-white shadow transition-transform duration-150 ${r.on ? "translate-x-6" : "translate-x-1"}`} />
                </button>
                <span className={`w-24 shrink-0 text-sm font-semibold ${r.on ? "text-ink-900" : "text-ink-300"}`}>{DAY_LABELS[r.day - 1]}</span>
                <span className={`flex flex-1 items-center gap-2 ${r.on ? "" : "opacity-40"}`}>
                  <input
                    type="time"
                    value={r.start}
                    disabled={!r.on || ownerOverride}
                    onChange={(e) => setTime(r.day, "start", e.target.value)}
                    aria-label={`${DAY_LABELS[r.day - 1]} start time`}
                    className="h-11 flex-1 rounded-xl border border-ink-200 bg-surface px-2 text-sm tabular-nums text-ink-800 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:opacity-60"
                  />
                  <span className="text-xs font-semibold text-ink-400">to</span>
                  <input
                    type="time"
                    value={r.end}
                    disabled={!r.on || ownerOverride}
                    onChange={(e) => setTime(r.day, "end", e.target.value)}
                    aria-label={`${DAY_LABELS[r.day - 1]} end time`}
                    className="h-11 flex-1 rounded-xl border border-ink-200 bg-surface px-2 text-sm tabular-nums text-ink-800 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:opacity-60"
                  />
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Button className="w-full" loading={saving} disabled={ownerOverride} onClick={() => void save()}>
          <Save className="size-4" /> Save schedule
        </Button>
        {ownerOverride && (
          <p className="text-center text-xs text-ink-400">Saving is turned off because the owner set this schedule.</p>
        )}
      </div>
    </AppShell>
  );
}
