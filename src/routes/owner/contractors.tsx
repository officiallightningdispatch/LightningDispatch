import { createFileRoute } from "@tanstack/react-router";
import { CloudDownload, Loader2, UserCog, Users } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { AppShell } from "~/components/app-shell";
import { InlineError } from "~/components/mutation-status";
import { Avatar, Button, Card, EmptyState, StatusBadge } from "~/components/ui";
import {
  addContractor,
  importContractors,
  listContractors,
  type ContractorRow,
  type ImportSummary,
} from "~/data/contractor-management";
import { timeAgo } from "~/lib/job-ui";

export const Route = createFileRoute("/owner/contractors")({ component: OwnerContractors });

/** Owner command center — contractor accounts + driver import. Real data only:
 *  every row is a users record (role 'contractor') in the owner's org, with
 *  sign-in status derived from the stored per-driver Towbook sessions. The
 *  import pulls the real contractor list from Towbook (GET /api/drivers) using
 *  the owner's connected session — the same roster endpoint the driver
 *  sign-in flow reads. */
function OwnerContractors() {
  const [rows, setRows] = useState<ContractorRow[] | null>(null);
  const [listError, setListError] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportSummary | null>(null);
  const [importError, setImportError] = useState("");

  const [name, setName] = useState("");
  const [driverId, setDriverId] = useState("");
  const [email, setEmail] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [added, setAdded] = useState<ContractorRow | null>(null);

  const refresh = async () => {
    const r = await listContractors();
    if (r.ok) { setRows(r.data); setListError(""); } else setListError(r.message);
  };
  useEffect(() => { void refresh(); }, []);

  const runImport = async () => {
    setImporting(true);
    setImportResult(null);
    setImportError("");
    const r = await importContractors();
    if (r.ok) { setImportResult(r.data); setImportError(""); void refresh(); }
    else setImportError(r.message);
    setImporting(false);
  };

  const submitAdd = async (e: FormEvent) => {
    e.preventDefault();
    setAdding(true);
    setAddError("");
    setAdded(null);
    const r = await addContractor({ data: { name, towbookDriverId: driverId, email } });
    if (r.ok) {
      setAdded(r.data);
      setName(""); setDriverId(""); setEmail("");
      void refresh();
    } else setAddError(r.message);
    setAdding(false);
  };

  const signedIn = (rows ?? []).filter((c) => c.status === "signed_in").length;
  const notSignedIn = (rows ?? []).length - signedIn;

  return (
    <AppShell
      portal="owner"
      title="Contractors"
      description="Every contractor account in Lightning Dispatch. Drivers sign in with their existing Towbook credentials; import the real list from Towbook to add them all at once."
    >
      <div className="space-y-6">
        {/* ---- stats ---- */}
        <section className="grid grid-cols-3 gap-3">
          <div className="rounded-2xl border border-ink-100 bg-surface p-4 shadow-card">
            <p className="text-xs font-bold uppercase tracking-wider text-ink-400">Contractors</p>
            <p className="mt-1 text-2xl font-extrabold tabular-nums">{rows === null ? "—" : rows.length}</p>
          </div>
          <div className="rounded-2xl border border-ink-100 bg-surface p-4 shadow-card">
            <p className="text-xs font-bold uppercase tracking-wider text-success-600">Signed in</p>
            <p className="mt-1 text-2xl font-extrabold tabular-nums text-success-700">{rows === null ? "—" : signedIn}</p>
          </div>
          <div className="rounded-2xl border border-ink-100 bg-surface p-4 shadow-card">
            <p className="text-xs font-bold uppercase tracking-wider text-ink-400">Not yet</p>
            <p className="mt-1 text-2xl font-extrabold tabular-nums">{rows === null ? "—" : notSignedIn}</p>
          </div>
        </section>

        {/* ---- import from Towbook ---- */}
        <Card className="p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex gap-4">
              <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
                <CloudDownload className="size-5" aria-hidden="true" />
              </span>
              <div>
                <p className="text-sm font-bold">Import from Towbook</p>
                <p className="mt-0.5 max-w-lg text-xs text-ink-500">
                  Pulls the real contractor list from your connected Towbook account (read-only — nothing is changed in Towbook).
                  New drivers are added; existing ones get their name refreshed; inactive and malformed rows are skipped.
                </p>
              </div>
            </div>
            <Button onClick={() => void runImport()} loading={importing} className="shrink-0">
              {importing ? "Importing…" : "Import from Towbook"}
            </Button>
          </div>
          {importError && <div className="mt-4"><InlineError message={importError} /></div>}
          {importResult && (
            <div className="mt-4 rounded-xl border border-success-100 bg-success-50 px-4 py-3 text-sm">
              <p className="font-bold text-success-700">
                Imported {importResult.imported} · Updated {importResult.updated} · Skipped {importResult.skipped.length}
              </p>
              {importResult.skipped.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs text-ink-600">
                  {importResult.skipped.map((s, i) => (
                    <li key={i} className="flex flex-wrap gap-x-2">
                      <span className="font-mono tabular-nums">{s.towbookDriverId}</span>
                      {s.name && <span className="font-medium">{s.name}</span>}
                      <span className="text-ink-400">— {s.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Card>

        {/* ---- add manually ---- */}
        <Card className="p-5">
          <div className="mb-4 flex items-center gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
              <UserCog className="size-5" aria-hidden="true" />
            </span>
            <div>
              <p className="text-sm font-bold">Add a contractor</p>
              <p className="text-xs text-ink-400">
                They&apos;ll sign in with their existing Towbook credentials — no password needed here.
              </p>
            </div>
          </div>
          <form onSubmit={(e) => void submitAdd(e)} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_180px_1fr_auto]">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-ink-500">Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={120}
                placeholder="e.g. Antone Jerret"
                className="h-11 w-full rounded-xl border border-ink-200 bg-surface px-3 text-sm outline-none placeholder:text-ink-300 focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-ink-500">Towbook driver ID</span>
              <input
                value={driverId}
                onChange={(e) => setDriverId(e.target.value.replace(/\D/g, ""))}
                required
                inputMode="numeric"
                maxLength={24}
                placeholder="e.g. 603482"
                className="h-11 w-full rounded-xl border border-ink-200 bg-surface px-3 text-sm outline-none placeholder:text-ink-300 focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-ink-500">Email <span className="font-normal text-ink-300">(optional)</span></span>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                type="email"
                maxLength={200}
                placeholder="antone@example.com"
                className="h-11 w-full rounded-xl border border-ink-200 bg-surface px-3 text-sm outline-none placeholder:text-ink-300 focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              />
            </label>
            <div className="flex items-end">
              <Button type="submit" loading={adding} className="w-full sm:w-auto">
                {adding ? "Adding…" : "Add contractor"}
              </Button>
            </div>
          </form>
          {addError && <div className="mt-4"><InlineError message={addError} /></div>}
          {added && (
            <div className="mt-4 rounded-xl border border-success-100 bg-success-50 px-4 py-3 text-sm text-success-700">
              <strong>{added.name}</strong> added — they can now sign in with their Towbook credentials.
            </div>
          )}
        </Card>

        {/* ---- roster ---- */}
        <section>
          <div className="mb-3 flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-bold uppercase tracking-wider text-ink-500">Roster</h3>
            <span className="text-xs text-ink-400">signed in at least once = has a Towbook driver session</span>
          </div>
          {listError && <div className="mb-3"><InlineError message={listError} /></div>}
          {rows === null ? (
            <Card className="grid place-items-center gap-3 p-10 text-center">
              <Loader2 className="size-5 animate-spin text-brand-500 motion-reduce:animate-none" aria-hidden="true" />
              <p className="text-sm text-ink-400">Loading contractors…</p>
            </Card>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No contractors yet"
              body="Add one manually or import the real list from Towbook — drivers can then sign in with their existing Towbook credentials."
            />
          ) : (
            <Card className="overflow-hidden">
              {rows.map((c, i) => (
                <ContractorRowView key={c.id} c={c} last={i === rows.length - 1} />
              ))}
            </Card>
          )}
        </section>
      </div>
    </AppShell>
  );
}

function ContractorRowView({ c, last }: { c: ContractorRow; last: boolean }) {
  const signedIn = c.status === "signed_in";
  return (
    <div className={`flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-3 ${last ? "" : "border-b border-ink-100"}`}>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar name={c.name} />
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-semibold">
            <span className="truncate">{c.name}</span>
            <StatusBadge
              dot
              className={signedIn ? "bg-success-50 text-success-700" : "bg-ink-100 text-ink-500"}
            >
              {signedIn ? "Signed in" : "Not signed in yet"}
            </StatusBadge>
          </p>
          <p className="mt-0.5 truncate text-xs text-ink-500">
            {c.email}
            {c.loginHandle ? ` · handle ${c.loginHandle}` : ""}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-12 text-xs tabular-nums text-ink-500 sm:shrink-0 sm:pl-0 sm:text-right">
        <span className="min-w-28">
          <span className="block text-[10px] font-bold uppercase tracking-wide text-ink-300 sm:hidden">Towbook ID</span>
          {c.towbookDriverId ? <span className="font-mono">{c.towbookDriverId}</span> : "—"}
        </span>
        <span className="min-w-28">
          <span className="block text-[10px] font-bold uppercase tracking-wide text-ink-300 sm:hidden">Last activity</span>
          {c.lastActivityAt ? `active ${timeAgo(c.lastActivityAt)}` : "never"}
        </span>
        <span className="min-w-28">
          <span className="block text-[10px] font-bold uppercase tracking-wide text-ink-300 sm:hidden">Added</span>
          {c.createdAt ? timeAgo(c.createdAt) : "—"}
        </span>
      </div>
    </div>
  );
}
