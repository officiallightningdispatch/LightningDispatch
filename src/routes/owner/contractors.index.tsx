import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertTriangle, ChevronDown, ChevronRight, CloudDownload, FileText, Loader2, Pencil, Plus, Trash2, UserCog, Users, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { AppShell } from "~/components/app-shell";
import { ComplianceBadge, DocumentTypeEditorRow, PayRateField, formatCents } from "~/components/contractor-admin";
import { ContractorProfileEditor, type EditorSection } from "~/components/contractor-profile-editor";
import { InlineError } from "~/components/mutation-status";
import { Avatar, Button, Card, EmptyState, StatusBadge, useToast } from "~/components/ui";
import {
  addContractor,
  importContractors,
  listContractors,
  removeContractor,
  setOwnerConfirmedDispatch,
  type ContractorRow,
  type ImportSummary,
  type TowbookPushOutcome,
} from "~/data/contractor-management";
import {
  addDocType,
  listRequiredDocTypes,
  seedMandatedDocTypes,
  removeDocType,
  renameDocType,
  reorderDocTypes,
  setContractorPayrate,
  setDocTypeActive,
  type DocTypeRow,
} from "~/data/contractor-admin";
import { timeAgo } from "~/lib/job-ui";
import { OwnerServiceSelection } from "~/components/service-selection";

export const Route = createFileRoute("/owner/contractors/")({ component: OwnerContractors });

/** Owner command center — contractor accounts (payrate + compliance), driver
 *  import, and the org's required-document types. Real data only. The roster
 *  row now carries the per-job payrate (inline immediate-save) and a
 *  compliance badge; the Required documents segment is the org-level editor
 *  (add / rename / reorder / toggle / soft-remove types). The per-contractor
 *  detail screen (/owner/contractors/:id) hosts the Documents section, payrate
 *  card and danger zone (part 2). */
function OwnerContractors() {
  const [segment, setSegment] = useState<"roster" | "docs">("roster");
  const toast = useToast();
  /** Contractor Management v2: the full-screen profile editor (opens at a
   *  section from the roster pencil / detail-page affordances). */
  const [editing, setEditing] = useState<{ id: string; section: EditorSection } | null>(null);
  /** Roster compliance filter pills: All / Missing docs / Expiring soon. */
  const [rosterFilter, setRosterFilter] = useState<"all" | "missing" | "expiring">("all");
  const [servicesOpen, setServicesOpen] = useState(false);

  /* ---- roster ---- */
  const [rows, setRows] = useState<ContractorRow[] | null>(null);
  const [listError, setListError] = useState("");
  // Records-on-demand (owner batch 2026-08-12): removed/inactive contractors
  // stay hidden by default; the owner can explicitly include them.
  const [includeRemoved, setIncludeRemoved] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportSummary | null>(null);
  const [importError, setImportError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [driverId, setDriverId] = useState("");
  const [email, setEmail] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [added, setAdded] = useState<ContractorRow | null>(null);

  /* ---- required doc types ---- */
  const [docTypes, setDocTypes] = useState<DocTypeRow[] | null>(null);
  const [docTypesError, setDocTypesError] = useState("");
  const [newTypeName, setNewTypeName] = useState("");
  const [newTypeExpiry, setNewTypeExpiry] = useState(false);
  const [addingType, setAddingType] = useState(false);
  const [typeBusy, setTypeBusy] = useState(false);

  const refresh = async () => {
    const r = await listContractors({ data: { includeRemoved } });
    if (r.ok) { setRows(r.data); setListError(""); } else setListError(r.message);
  };
  useEffect(() => { void refresh(); }, [includeRemoved]);

  const loadDocTypes = async () => {
    const r = await listRequiredDocTypes();
    if (r.ok) { setDocTypes(r.data); setDocTypesError(""); } else setDocTypesError(r.message);
  };
  useEffect(() => { void loadDocTypes(); }, []);

  /* ---- import / add ---- */
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

  /* ---- payrate (optimistic + toast + revert) ---- */
  const savePayrate = async (c: ContractorRow, cents: number | null) => {
    const prev = rows;
    setRows((rs) => (rs ? rs.map((r) => (r.id === c.id ? { ...r, payrateCents: cents } : r)) : rs));
    const r = await setContractorPayrate({ data: { contractorId: c.id, payrateCents: cents } });
    if (!r.ok) {
      setRows(prev);
      throw new Error(r.message);
    }
    toast(cents == null ? "Rate removed — payday math won't count it" : `${formatCents(cents)} / job saved — applies to all completed jobs`);
  };

  /* ---- required doc types ---- */
  const reloadTypes = async () => { const r = await listRequiredDocTypes(); if (r.ok) setDocTypes(r.data); };

  const submitAddType = async (e: FormEvent) => {
    e.preventDefault();
    const t = newTypeName.trim();
    if (!t) return;
    setAddingType(true);
    const r = await addDocType({ data: { name: t, requiresExpiry: newTypeExpiry } });
    setAddingType(false);
    if (r.ok) { setNewTypeName(""); setNewTypeExpiry(false); setDocTypesError(""); await reloadTypes(); }
    else setDocTypesError(r.message);
  };

  const addSuggestion = async (s: string) => {
    setTypeBusy(true);
    const r = await addDocType({ data: { name: s, requiresExpiry: s.includes("License") || s.includes("Certificate") || s.includes("Medical") } });
    setTypeBusy(false);
    if (r.ok) { setDocTypesError(""); await reloadTypes(); }
    else setDocTypesError(r.message);
  };

  const [seedingStandard, setSeedingStandard] = useState(false);
  /** Owner-directed 2026-08-12: add the mandated standard set (W-9, I-9,
   *  Driver's license with facial verification, Insurance information) —
   *  idempotent; existing types are left untouched. Nothing auto-seeds. */
  const seedStandard = async () => {
    setSeedingStandard(true);
    setDocTypesError("");
    const r = await seedMandatedDocTypes();
    setSeedingStandard(false);
    if (r.ok) {
      toast(r.data.length
        ? `Added the standard set — ${r.data.map((t) => t.name).join(", ")}`
        : "The standard document set is already in place.");
      setDocTypesError("");
      await reloadTypes();
    } else setDocTypesError(r.message);
  };
  const handleRename = async (id: string, n: string) => {
    setTypeBusy(true);
    const r = await renameDocType({ data: { id, name: n } });
    setTypeBusy(false);
    if (!r.ok) throw new Error(r.message);
    await reloadTypes();
  };
  const handleToggle = async (id: string, active: boolean) => {
    setTypeBusy(true);
    const r = await setDocTypeActive({ data: { id, active } });
    setTypeBusy(false);
    if (!r.ok) throw new Error(r.message);
    await reloadTypes();
  };
  const handleRemove = async (id: string) => {
    setTypeBusy(true);
    const r = await removeDocType({ data: { id } });
    setTypeBusy(false);
    if (!r.ok) throw new Error(r.message);
    await reloadTypes();
  };
  const handleMove = async (id: string, dir: "up" | "down") => {
    if (!docTypes) return;
    const active = docTypes.filter((t) => t.active).sort((a, b) => a.sortOrder - b.sortOrder);
    const i = active.findIndex((t) => t.id === id);
    const j = dir === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= active.length) return;
    const next = [...active];
    [next[i], next[j]] = [next[j], next[i]];
    setTypeBusy(true);
    const r = await reorderDocTypes({ data: { orderedIds: next.map((t) => t.id) } });
    setTypeBusy(false);
    if (!r.ok) throw new Error(r.message);
    await reloadTypes();
  };

  const signedIn = (rows ?? []).filter((c) => c.status === "signed_in" && !c.removedAt).length;
  const removedCount = (rows ?? []).filter((c) => c.removedAt).length;
  const notSignedIn = (rows ?? []).length - signedIn - removedCount;
  // Compliance strip: contractors with at least one ACTIVE required type that
  // has no file on file (missing / expired / rejected).
  const missingDocs = (rows ?? []).filter((c) => !c.removedAt && c.requiredDocCount > 0 && c.onFileDocCount < c.requiredDocCount).length;
  const expiringSoon = (rows ?? []).filter((c) => !c.removedAt && c.expiringSoonCount > 0);
  const visibleRows = (rows ?? []).filter((c) =>
    rosterFilter === "all" ? true
    : rosterFilter === "missing" ? (!c.removedAt && c.requiredDocCount > 0 && c.onFileDocCount < c.requiredDocCount)
    : (!c.removedAt && c.expiringSoonCount > 0));

  const activeTypes = (docTypes ?? []).filter((t) => t.active).sort((a, b) => a.sortOrder - b.sortOrder);
  const pausedTypes = (docTypes ?? []).filter((t) => !t.active).sort((a, b) => a.sortOrder - b.sortOrder);
  const SUGGESTIONS = ["W-9", "Driver's License", "Insurance Certificate", "Medical Examiner Card", "Towing License"];

  return (
    <AppShell
      portal="owner"
      title="Contractors"
      description="Every contractor account in Lightning Dispatch. Set per-job payrates, review document compliance, and define the required documents every contractor must keep on file."
    >
      <div className="space-y-6">
        {/* ---- segmented control ---- */}
        <div className="flex w-full max-w-sm items-center rounded-xl border border-ink-200 bg-surface p-1" role="tablist" aria-label="Contractor views">
          {(["roster", "docs"] as const).map((seg) => (
            <button
              key={seg}
              type="button"
              role="tab"
              aria-selected={segment === seg}
              onClick={() => setSegment(seg)}
              className={`h-10 flex-1 rounded-lg text-sm font-bold transition-colors ${segment === seg ? "bg-ink-950 text-white" : "text-ink-500 hover:text-ink-700"}`}
            >
              {seg === "roster" ? "Roster" : "Required documents"}
            </button>
          ))}
        </div>

        {segment === "roster" ? (
          <>
            <Card className="overflow-hidden">
              <button
                type="button"
                aria-expanded={servicesOpen}
                aria-controls="owner-roster-contractor-services"
                onClick={() => setServicesOpen((open) => !open)}
                className="flex min-h-14 w-full items-center justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-ink-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand-500"
              >
                <span className="min-w-0">
                  <span className="block text-sm font-bold text-ink-900">Contractor services</span>
                  <span className="mt-0.5 block text-xs text-ink-500">Set the capabilities used for dispatch qualification.</span>
                </span>
                {servicesOpen ? <ChevronDown className="size-5 shrink-0 text-ink-400" aria-hidden="true" /> : <ChevronRight className="size-5 shrink-0 text-ink-400" aria-hidden="true" />}
              </button>
              {servicesOpen && (
                <div id="owner-roster-contractor-services" className="border-t border-ink-100 p-3 sm:p-4">
                  <OwnerServiceSelection />
                </div>
              )}
            </Card>
            {/* ---- compliance strip ---- */}
            {missingDocs > 0 && (
              <Card className="border-danger-200 bg-danger-50/60 p-4">
                <button type="button" onClick={() => setSegment("docs")} className="flex w-full items-center gap-3 text-left">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-danger-100 text-danger-700">
                    <AlertTriangle className="size-5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="font-bold text-danger-800">{missingDocs} contractor{missingDocs === 1 ? " is" : "s are"} missing documents</span>
                    <span className="block text-xs text-danger-700">Review the required types and ask contractors to upload — see Required documents.</span>
                  </span>
                  <span className="text-xs font-bold uppercase tracking-wide text-danger-700">Review</span>
                </button>
              </Card>
            )}

            {/* ---- expiring-docs strip (accent — attention state) ---- */}
            {expiringSoon.length > 0 && (
              <Card className="border-accent-200 bg-accent-50/60 p-4">
                <div className="flex items-center gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-100 text-accent-700">
                    <AlertTriangle className="size-5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="font-bold text-accent-800">{expiringSoon.length} contractor{expiringSoon.length === 1 ? " has" : "s have"} document{expiringSoon.length === 1 ? "" : "s"} expiring within 14 days</span>
                    <span className="block text-xs text-accent-700">Expired documents flag automatically — ask for reuploads before they lapse.</span>
                  </span>
                  <span className="text-xs font-bold uppercase tracking-wide text-accent-700">Expiring soon</span>
                </div>
              </Card>
            )}
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
                <p className="text-xs font-bold uppercase tracking-wider text-ink-400">{removedCount > 0 ? "Removed" : "Not yet"}</p>
                <p className="mt-1 text-2xl font-extrabold tabular-nums">{rows === null ? "—" : removedCount > 0 ? removedCount : notSignedIn}</p>
              </div>
            </section>

            {/* ---- roster ---- */}
            <section>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-bold uppercase tracking-wider text-ink-500">Roster</h3>
                <div className="flex items-center gap-1 rounded-xl border border-ink-200 bg-surface p-1" role="tablist" aria-label="Compliance filter">
                  {([["all", "All"], ["missing", "Missing docs"], ["expiring", "Expiring soon"]] as const).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      aria-selected={rosterFilter === key}
                      onClick={() => setRosterFilter(key)}
                      className={`h-10 rounded-lg px-3 text-[13px] font-semibold transition-colors ${rosterFilter === key ? "bg-ink-950 text-white" : "text-ink-500 hover:text-ink-700"}`}
                    >
                      {label}
                      {key === "missing" && missingDocs > 0 && <span className="ml-1 tabular-nums text-danger-600">{missingDocs}</span>}
                      {key === "expiring" && expiringSoon.length > 0 && <span className="ml-1 tabular-nums text-accent-600">{expiringSoon.length}</span>}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {/* Records-on-demand: removed/inactive contractors are hidden
                      unless the owner explicitly asks to include them. */}
                  <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs font-semibold text-ink-500">
                    <input
                      type="checkbox"
                      checked={includeRemoved}
                      onChange={(e) => setIncludeRemoved(e.target.checked)}
                      className="size-4 accent-brand-500"
                    />
                    Include removed/inactive
                  </label>
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => { setShowImport((v) => !v); setShowAdd(false); }}>
                      <CloudDownload className="size-3.5" aria-hidden="true" /> Import
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => { setShowAdd((v) => !v); setShowImport(false); }}>
                      <Plus className="size-3.5" aria-hidden="true" /> Add
                    </Button>
                  </div>
                </div>
              </div>
              {includeRemoved && rows && rows.some((c) => c.removedAt) && (
                <p className="mb-3 rounded-xl border border-ink-100 bg-ink-50/60 px-3 py-2 text-xs text-ink-500">
                  Showing {rows.filter((c) => c.removedAt).length} removed/inactive record{rows.filter((c) => c.removedAt).length === 1 ? "" : "s"} — removed contractors can&apos;t sign in or be dispatched.
                </p>
              )}

              {showImport && (
                <Card className="mb-4 p-5">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex gap-4">
                      <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
                        <CloudDownload className="size-5" aria-hidden="true" />
                      </span>
                      <div>
                        <p className="text-sm font-bold">Import from Towbook</p>
                        <p className="mt-0.5 max-w-lg text-xs text-ink-500">
                          Pulls the real contractor list from your connected Towbook account (read-only — nothing is changed in Towbook).
                          New drivers are added; existing ones get their name refreshed; inactive, disabled and malformed rows are skipped.
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
              )}

              {showAdd && (
                <Card className="mb-4 p-5">
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
                    <div className="flex items-end gap-2">
                      <Button type="submit" loading={adding} className="w-full sm:w-auto">
                        {adding ? "Adding…" : "Add contractor"}
                      </Button>
                      <Button type="button" variant="secondary" onClick={() => { setShowAdd(false); setAddError(""); }} className="sm:hidden">
                        <X className="size-4" aria-hidden="true" />
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
              )}

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
                  {visibleRows.length === 0 ? (
                    <div className="grid place-items-center p-10 text-center">
                      <p className="text-sm text-ink-400">{rosterFilter === "all" ? "No contractors match." : rosterFilter === "missing" ? "No contractors missing documents — everyone's compliant." : "Nothing expiring within 14 days."}</p>
                    </div>
                  ) : (
                    visibleRows.map((c, i) => (
                      <ContractorRowView
                        key={c.id}
                        c={c}
                        last={i === visibleRows.length - 1}
                        onChanged={() => void refresh()}
                        onPayrate={(cents) => savePayrate(c, cents)}
                        onEdit={() => setEditing({ id: c.id, section: "profile" })}
                      />
                    ))
                  )}
                </Card>
              )}
            </section>
          </>
        ) : (
          <>
            {editing && (
              <ContractorProfileEditor
                contractorId={editing.id}
                initialSection={editing.section}
                onClose={() => setEditing(null)}
                onChanged={() => void refresh()}
              />
            )}
            <RequiredDocsSegment
            docTypes={docTypes}
            docTypesError={docTypesError}
            activeTypes={activeTypes}
            pausedTypes={pausedTypes}
            newTypeName={newTypeName}
            newTypeExpiry={newTypeExpiry}
            addingType={addingType}
            typeBusy={typeBusy}
            setNewTypeName={setNewTypeName}
            setNewTypeExpiry={setNewTypeExpiry}
            setDocTypesError={setDocTypesError}
            suggestions={SUGGESTIONS}
            onAddType={submitAddType}
            onAddSuggestion={addSuggestion}
            onSeedStandard={seedStandard}
            seedingStandard={seedingStandard}
            onRename={handleRename}
            onToggle={handleToggle}
            onRemove={handleRemove}
            onMove={handleMove}
          />
          </>
        )}
      </div>
    </AppShell>
  );
}

/* ------------------------------ roster row ------------------------------ */

function ContractorRowView({ c, last, onChanged, onPayrate, onEdit }: {
  c: ContractorRow;
  last: boolean;
  onChanged: () => void;
  onPayrate: (cents: number | null) => Promise<void>;
  onEdit: () => void;
}) {
  const removed = Boolean(c.removedAt);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);

  /** Renders the Towbook outcome from remove as a user-facing notice. */
  const noticeFor = (t: TowbookPushOutcome): { kind: "ok" | "warn"; text: string } => {
    if (t.status === "verified") return { kind: "ok", text: t.notice };
    if (t.status === "skipped" || t.status === "unsupported") return { kind: "warn", text: t.notice };
    return { kind: "warn", text: t.notice + " This was escalated to the ops queue for review." };
  };

  const confirmRemove = async () => {
    setBusy(true); setError(""); setNotice(null);
    const r = await removeContractor({ data: { contractorId: c.id, reason } });
    setBusy(false);
    if (r.ok) {
      setNotice(noticeFor(r.data.towbook));
      setConfirmingRemove(false);
      setReason("");
      onChanged();
    } else setError(r.message);
  };

  return (
    <div className={`px-4 py-3.5 ${last ? "" : "border-b border-ink-100"} ${removed ? "bg-ink-50/60" : ""}`}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Link to="/owner/contractors/$id" params={{ id: c.id }} aria-label={`Open ${c.name} details`} className="shrink-0 rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500">
            <Avatar name={c.name} />
          </Link>
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-semibold">
              <Link to="/owner/contractors/$id" params={{ id: c.id }} className={`break-words hover:underline ${removed ? "text-ink-400 line-through decoration-ink-300" : "hover:text-ink-700"}`}>
                {c.name}
              </Link>
              {removed ? (
                <StatusBadge dot className="bg-ink-200 text-ink-600">
                  Removed {c.removedAt ? timeAgo(c.removedAt) : ""}
                </StatusBadge>
              ) : (
                <StatusBadge dot className={c.status === "signed_in" ? "bg-success-50 text-success-700" : "bg-ink-100 text-ink-500"}>
                  {c.status === "signed_in" ? "Signed in" : "Not signed in yet"}
                </StatusBadge>
              )}
            </p>
            <p className="mt-0.5 break-words text-xs text-ink-500">
              {c.email}
              {c.loginHandle ? ` · handle ${c.loginHandle}` : ""}
              {c.vehicleType ? ` · ${{car: "Car", "tow truck": "Tow truck", other: "Other"}[c.vehicleType] ?? c.vehicleType}` : ""}
            </p>
            {!removed && (
              <>
              <p className="mt-1.5 flex flex-wrap items-center gap-2">
                <ComplianceBadge approved={c.approvedDocCount} required={c.requiredDocCount} />
                {c.onFileDocCount > c.approvedDocCount && (
                  <Link
                    to="/owner/contractors/$id"
                    params={{ id: c.id }}
                    title={`${c.onFileDocCount - c.approvedDocCount} document${c.onFileDocCount - c.approvedDocCount === 1 ? "" : "s"} submitted and waiting for your approval`}
                    className="inline-flex items-center gap-1 rounded-full bg-accent-50 px-2 py-0.5 text-[11px] font-bold text-accent-700 transition-colors hover:bg-accent-100"
                  >
                    <AlertTriangle className="size-3" aria-hidden="true" />
                    {c.onFileDocCount - c.approvedDocCount} to review
                  </Link>
                )}
                <PayRateField valueCents={c.payrateCents} onSave={onPayrate} />
                {c.expiringSoonCount > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-accent-50 px-2 py-0.5 text-[11px] font-bold text-accent-700" title="A required document expires within 14 days">
                    <AlertTriangle className="size-3" aria-hidden="true" />
                    {c.expiringSoonCount} doc{c.expiringSoonCount === 1 ? "" : "s"} expire soon
                  </span>
                )}
              </p>
              <OwnerConfirmedDispatchEditor c={c} onSaved={onChanged} />
              </>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-12 text-xs tabular-nums text-ink-500 sm:shrink-0 sm:pl-0 sm:text-right">
          <Link to="/owner/contractors/$id" params={{ id: c.id }} aria-label={`Open ${c.name} details`}
            className="order-last grid size-10 shrink-0 place-items-center rounded-lg text-ink-300 transition-colors hover:bg-ink-50 hover:text-ink-600 sm:order-first sm:-mr-1">
            <ChevronRight className="size-4" aria-hidden="true" />
          </Link>
          {/* Mobile: Towbook ID and Added live behind the detail link (rework #2);
              Last activity stays inline. Desktop shows all three columns. */}
          <span className="hidden min-w-28 sm:block">
            <span className="block text-[10px] font-bold uppercase tracking-wide text-ink-300 sm:hidden">Towbook ID</span>
            {c.towbookDriverId ? <span className="font-mono">{c.towbookDriverId}</span> : "—"}
          </span>
          <span className="min-w-28">
            <span className="block text-[10px] font-bold uppercase tracking-wide text-ink-300 sm:hidden">Last activity</span>
            {c.lastActivityAt ? `active ${timeAgo(c.lastActivityAt)}` : "never"}
          </span>
          <span className="hidden min-w-28 sm:block">
            <span className="block text-[10px] font-bold uppercase tracking-wide text-ink-300 sm:hidden">Added</span>
            {c.createdAt ? timeAgo(c.createdAt) : "—"}
          </span>
          {!removed && (
            <span className="flex gap-1.5 sm:ml-2">
              <button
                type="button"
                title="Edit contractor"
                aria-label={`Edit ${c.name}`}
                onClick={() => onEdit()}
                className="grid size-10 place-items-center rounded-lg border border-ink-200 bg-surface text-ink-500 transition-colors hover:border-brand-300 hover:text-brand-700"
              >
                <Pencil className="size-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                title="Remove contractor"
                aria-label={`Remove ${c.name}`}
                onClick={() => { setConfirmingRemove(true); setError(""); setNotice(null); }}
                className="grid size-10 place-items-center rounded-lg border border-danger-200 bg-danger-50/60 text-danger-600 transition-colors hover:bg-danger-100"
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </button>
            </span>
          )}
        </div>
      </div>

      {error && <div className="mt-3"><InlineError message={error} /></div>}
      {notice && (
        <div className={`mt-3 rounded-xl border px-4 py-3 text-sm ${notice.kind === "ok" ? "border-success-100 bg-success-50 text-success-700" : "border-accent-200 bg-accent-50 text-accent-800"}`}>
          {notice.text}
        </div>
      )}

      {confirmingRemove && !removed && (
        <div className="mt-3 rounded-xl border border-danger-200 bg-danger-50/60 p-4">
          <p className="text-sm font-bold text-danger-800">Remove {c.name}?</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-600">
            They will <strong>stop receiving new jobs</strong> and lose portal access immediately (their session is revoked).
            Their job history, photos and records are <strong>kept</strong>. If Towbook is connected, they&apos;ll also be
            disabled as a driver in Towbook.
          </p>
          <label className="mt-3 block">
            <span className="mb-1 block text-xs font-semibold text-ink-500">Reason <span className="font-normal text-ink-300">(optional, recorded in the audit log)</span></span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. Left the company"
              className="h-11 w-full rounded-xl border border-ink-200 bg-surface px-3 text-sm outline-none placeholder:text-ink-300 focus:border-danger-500 focus:ring-2 focus:ring-danger-100" />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="danger" loading={busy} onClick={() => void confirmRemove()}>Remove contractor</Button>
            <Button variant="secondary" disabled={busy} onClick={() => { setConfirmingRemove(false); setError(""); setNotice(null); setReason(""); }}>Keep them</Button>
          </div>
        </div>
      )}
    </div>
  );
}
function OwnerConfirmedDispatchEditor({ c, onSaved }: { c: ContractorRow; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState(c.ownerConfirmedDispatchState ?? "");
  const [latitude, setLatitude] = useState(c.ownerConfirmedDispatchLat == null ? "" : String(c.ownerConfirmedDispatchLat));
  const [longitude, setLongitude] = useState(c.ownerConfirmedDispatchLng == null ? "" : String(c.ownerConfirmedDispatchLng));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const enabled = c.ownerConfirmedDispatchEnabled;
  const save = async (nextEnabled: boolean) => {
    setBusy(true); setError("");
    const r = await setOwnerConfirmedDispatch({ data: {
      contractorId: c.id, enabled: nextEnabled, state: state.trim().toUpperCase() || undefined,
      latitude: latitude.trim() ? Number(latitude) : undefined, longitude: longitude.trim() ? Number(longitude) : undefined,
    }});
    setBusy(false);
    if (!r.ok) { setError(r.message); return; }
    onSaved();
  };
  return (
    <div className="mt-2 max-w-2xl">
      <button type="button" onClick={() => setOpen((v) => !v)} className={`rounded-full px-2 py-1 text-[11px] font-bold transition-colors ${enabled ? "bg-brand-50 text-brand-700" : "bg-ink-100 text-ink-500 hover:bg-ink-200"}`}>
        {enabled ? `Owner-confirmed ${c.ownerConfirmedDispatchState ?? "location"}` : "Set owner-confirmed location"}
      </button>
      {open && (
        <div className="mt-2 rounded-xl border border-brand-200 bg-brand-50/40 p-3">
          <p className="text-xs font-bold text-brand-900">Owner-confirmed dispatch fallback</p>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-600">For staff/supervisor drivers who work from Towbook without a fresh Lightning GPS fix. This explicit exception supplies state proof and ETA origin only while enabled. The driver must still be currently available: Towbook checked in OR Lightning GO.</p>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label><span className="mb-1 block text-[11px] font-semibold text-ink-500">Dispatch state</span><input value={state} onChange={(e) => setState(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2))} placeholder="CT" maxLength={2} className="h-9 w-full rounded-lg border border-ink-200 bg-surface px-2 text-sm uppercase" /></label>
            <label><span className="mb-1 block text-[11px] font-semibold text-ink-500">Confirmed latitude</span><input value={latitude} onChange={(e) => setLatitude(e.target.value)} inputMode="decimal" placeholder="41.21" className="h-9 w-full rounded-lg border border-ink-200 bg-surface px-2 text-sm" /></label>
            <label><span className="mb-1 block text-[11px] font-semibold text-ink-500">Confirmed longitude</span><input value={longitude} onChange={(e) => setLongitude(e.target.value)} inputMode="decimal" placeholder="-73.19" className="h-9 w-full rounded-lg border border-ink-200 bg-surface px-2 text-sm" /></label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button loading={busy} onClick={() => void save(true)}>Enable fallback</Button>
            {enabled && <Button variant="secondary" disabled={busy} onClick={() => void save(false)}>Clear fallback</Button>}
          </div>
          {error && <p className="mt-2 text-xs font-semibold text-danger-700">{error}</p>}
        </div>
      )}
    </div>
  );
}
/* ------------------------- required documents segment ------------------------- */

function RequiredDocsSegment({
  docTypes, docTypesError, activeTypes, pausedTypes,
  newTypeName, newTypeExpiry, addingType, typeBusy,
  setNewTypeName, setNewTypeExpiry, setDocTypesError, suggestions,
  onAddType, onAddSuggestion, onSeedStandard, seedingStandard, onRename, onToggle, onRemove, onMove,
}: {
  docTypes: DocTypeRow[] | null;
  docTypesError: string;
  activeTypes: DocTypeRow[];
  pausedTypes: DocTypeRow[];
  newTypeName: string;
  newTypeExpiry: boolean;
  addingType: boolean;
  typeBusy: boolean;
  setNewTypeName: (v: string) => void;
  setNewTypeExpiry: (v: boolean) => void;
  setDocTypesError: (v: string) => void;
  suggestions: string[];
  onAddType: (e: FormEvent) => Promise<void>;
  onAddSuggestion: (s: string) => Promise<void>;
  onSeedStandard: () => Promise<void>;
  seedingStandard: boolean;
  onRename: (id: string, name: string) => Promise<void>;
  onToggle: (id: string, active: boolean) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onMove: (id: string, dir: "up" | "down") => Promise<void>;
}) {
  if (docTypes === null) {
    return (
      <Card className="grid place-items-center gap-3 p-10 text-center">
        <Loader2 className="size-5 animate-spin text-brand-500 motion-reduce:animate-none" aria-hidden="true" />
        <p className="text-sm text-ink-400">Loading required documents…</p>
      </Card>
    );
  }
  return (
    <div className="space-y-5">
      {docTypesError && <InlineError message={docTypesError} />}

      <Card className="p-5">
        <div className="mb-4 flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
            <FileText className="size-5" aria-hidden="true" />
          </span>
          <div>
            <p className="text-sm font-bold">New required type</p>
            <p className="text-xs text-ink-400">Every contractor must keep each type on file — you review their uploads.</p>
          </div>
        </div>
        <form onSubmit={(e) => void onAddType(e)} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="block flex-1">
            <span className="mb-1 block text-xs font-semibold text-ink-500">Name</span>
            <input
              value={newTypeName}
              onChange={(e) => { setNewTypeName(e.target.value); setDocTypesError(""); }}
              maxLength={40}
              required
              placeholder="e.g. W-9"
              className="h-11 w-full rounded-xl border border-ink-200 bg-surface px-3 text-sm outline-none placeholder:text-ink-300 focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </label>
          <label className="flex h-11 items-center gap-2 text-sm font-semibold text-ink-600">
            <input
              type="checkbox"
              checked={newTypeExpiry}
              onChange={(e) => setNewTypeExpiry(e.target.checked)}
              className="size-4 rounded border-ink-300 accent-brand-500"
            />
            Requires expiry date
          </label>
          <Button type="submit" loading={addingType} className="sm:w-auto">
            <Plus className="size-4" aria-hidden="true" /> Add
          </Button>
        </form>
      </Card>

      {activeTypes.length === 0 && pausedTypes.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No required documents yet"
          body="Add the types every contractor must keep on file — W-9, license, insurance certificate and more. Contractors upload them from their app."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <button
                type="button"
                disabled={typeBusy || seedingStandard}
                onClick={() => void onSeedStandard()}
                className="h-9 rounded-full bg-brand-500 px-3.5 text-[13px] font-bold text-white transition-colors hover:bg-brand-600 disabled:opacity-50"
              >
                + Add the standard set (W-9, I-9, license + selfie, insurance)
              </button>
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={typeBusy}
                  onClick={() => void onAddSuggestion(s)}
                  className="h-9 rounded-full border border-ink-200 bg-surface px-3.5 text-[13px] font-semibold text-ink-600 transition-colors hover:border-brand-300 hover:text-brand-700 disabled:opacity-50"
                >
                  + {s}
                </button>
              ))}
            </div>
          }
        />
      ) : (
        <Card className="overflow-hidden">
          {activeTypes.map((t, i) => (
            <DocumentTypeEditorRow
              key={t.id}
              type={t}
              isFirst={i === 0}
              isLast={i === activeTypes.length - 1}
              busy={typeBusy}
              onRename={(n) => onRename(t.id, n)}
              onToggle={(a) => onToggle(t.id, a)}
              onRemove={() => onRemove(t.id)}
              onMove={(dir) => onMove(t.id, dir)}
            />
          ))}
          {pausedTypes.length > 0 && (
            <div className="border-t border-ink-100 bg-ink-50/40 px-4 py-2.5">
              <p className="text-[11px] font-bold uppercase tracking-wide text-ink-400">Paused — not required</p>
            </div>
          )}
          {pausedTypes.map((t, i) => (
            <DocumentTypeEditorRow
              key={t.id}
              type={t}
              isFirst={false}
              isLast={i === pausedTypes.length - 1}
              busy={typeBusy}
              onRename={(n) => onRename(t.id, n)}
              onToggle={(a) => onToggle(t.id, a)}
              onRemove={() => onRemove(t.id)}
              onMove={() => Promise.resolve()}
            />
          ))}
        </Card>
      )}

      {activeTypes.length === 0 && pausedTypes.length > 0 && (
        <p className="px-1 text-xs text-ink-400">All types are paused — contractors aren&apos;t asked for any documents right now.</p>
      )}
    </div>
  );
}
