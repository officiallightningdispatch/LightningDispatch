import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Battery, Boxes, ClipboardCheck, FileClock, FileSpreadsheet, Gauge, Package, Upload } from "lucide-react";
import { AppShell } from "~/components/app-shell";
import { Button, Card, EmptyState, StatCard } from "~/components/ui";
import {
  getBatteryOwnerPortal,
  getBatterySaleDetail,
  importOwnerBatteryCompatibility,
  importOwnerBatteryPriceBook,
} from "~/data/battery-owner";

export const Route = createFileRoute("/owner/batteries")({ component: BatteryManagement });

const money = (n: number | null | undefined) => n == null ? "—" : `$${(n / 100).toFixed(2)}`;
const date = (v: string | null | undefined) => v ? new Date(v).toLocaleDateString() : "—";

type ImportKind = "price-book" | "compatibility";

function BatteryManagement() {
  const [data, setData] = useState<any>(null);
  const [sale, setSale] = useState<any>(null);
  const [tab, setTab] = useState("overview");
  const [denied, setDenied] = useState(false);
  const load = useCallback(async () => {
    const result = await getBatteryOwnerPortal();
    if (!result.ok) { setDenied(true); return; }
    setData(result);
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (denied) return <AppShell portal="owner" title="Battery management" description="Owner-only battery operations."><Card className="p-6"><h2 className="font-bold">Owner access required</h2><p className="mt-2 text-sm text-ink-500">This management surface is restricted to owner and admin accounts.</p></Card></AppShell>;
  if (!data) return <AppShell portal="owner" title="Battery management" description="Owner-only battery operations."><Card className="p-6">Loading battery operations…</Card></AppShell>;
  const r = data.reports;
  const tabs = [["overview", "Overview", Gauge], ["products", "Products", Battery], ["operations", "Inventory & install", Boxes], ["sales", "Sales & warranties", Package], ["compat", "Compatibility", ClipboardCheck], ["audit", "Audit history", FileClock], ["import", "CSV import", FileSpreadsheet]] as const;
  return <AppShell portal="owner" title="Battery management" description="Lightning Gold Battery catalog, operations, payouts, warranties, and reporting.">
    <div className="space-y-6">
      <div className="flex gap-2 overflow-x-auto pb-1">{tabs.map(([id, label, Icon]) => <button key={id} onClick={() => setTab(id)} className={`inline-flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-sm font-bold ${tab === id ? "bg-brand-500 text-white" : "bg-surface text-ink-600 ring-1 ring-ink-100"}`}><Icon size={15} />{label}</button>)}</div>
      {tab === "overview" && <Overview r={r} />}
      {tab === "products" && <Products rows={data.products} />}
      {tab === "operations" && <Operations inventory={data.inventory} installTypes={data.installTypes} />}
      {tab === "sales" && <Sales rows={data.sales} sale={sale} setSale={setSale} />}
      {tab === "compat" && <Compatibility rows={data.compatibility} />}
      {tab === "audit" && <Audit rows={data.audits} />}
      {tab === "import" && <ImportPanel onImported={load} />}
    </div>
  </AppShell>;
}

function Overview({ r }: any) {
  return <><section className="grid grid-cols-2 gap-3 lg:grid-cols-4"><StatCard label="Sales" value={r.summary.salesCount} detail="real battery sales" /><StatCard label="Revenue" value={money(r.summary.revenueCents)} detail="recorded totals" /><StatCard label="Completed installs" value={r.summary.completedInstallations} detail="real completion rows" /><StatCard label="Warranty expiring" value={r.warrantyExpiring90Days} detail="next 90 days" /></section><div className="grid gap-4 lg:grid-cols-2"><Report title="Sales funnel" rows={r.funnel.map((x: any) => [x.status, String(x.count)])} /><Report title="Revenue by group" rows={r.byProduct.map((x: any) => [x.groupSize, `${x.units} · ${money(x.revenueCents)}`])} /><Report title="Install types" rows={r.byInstallType.map((x: any) => [x.installType, `${x.units} · ${money(x.revenueCents)}`])} /><Report title="Driver payouts" rows={r.payouts.map((x: any) => [x.contractorName, `${x.installs} · ${money(x.payoutCents)}`])} /></div><Card className="p-4"><h3 className="font-bold">Inventory value</h3><p className="mt-2 text-sm">Retail value <strong>{money(r.inventoryValueCents)}</strong> · reorder needs <strong>{r.reorderCount}</strong></p></Card></>;
}
function Report({ title, rows }: { title: string; rows: Array<[string, string]> }) { return <Card className="p-4"><h3 className="font-bold">{title}</h3>{rows.length ? rows.map(([a, b], i) => <div key={i} className="mt-2 flex justify-between text-sm"><span className="text-ink-500">{a}</span><strong>{b}</strong></div>) : <p className="mt-2 text-sm text-ink-400">No real rows recorded.</p>}</Card>; }
function Products({ rows }: any) { return <section className="space-y-3"><h2 className="text-lg font-bold">LIGHTNING GOLD BATTERY price book</h2>{rows.length ? rows.map((p: any) => <Card key={p.id} className="p-4"><p className="font-bold">{p.displayName} · GROUP {p.groupSize}</p><p className="text-sm text-ink-500">Customer price {money(p.retailCents)} · warranty {p.warrantyYears} years · {p.active ? "Active" : "Inactive"}</p><p className="text-xs text-ink-400">Updated {date(p.updatedAt)}</p></Card>) : <EmptyState icon={Battery} title="No products" body="Import the owner price book to add products." />}</section>; }
function Operations({ inventory, installTypes }: any) { return <div className="space-y-5"><section><h2 className="mb-3 text-lg font-bold">Inventory</h2>{inventory.length ? inventory.map((x: any) => <Card key={x.id} className="mb-2 p-4"><div className="flex justify-between"><div><p className="font-bold">GROUP {x.groupSize}</p><p className="text-sm text-ink-500">Available {x.available} · reserved {x.reserved} · held {x.held}</p></div><strong>{x.onHand} on hand</strong></div>{x.lowStock && <p className="mt-2 text-xs font-bold text-warning-700">REORDER REQUIRED · threshold {x.reorderThreshold}</p>}</Card>) : <EmptyState icon={Boxes} title="No inventory configured" body="Inventory appears once stock is configured." />}</section><section><h2 className="mb-3 text-lg font-bold">Installation pricing</h2>{installTypes.map((x: any) => <Card key={x.id} className="mb-2 p-4"><div className="flex justify-between gap-3"><div><p className="font-bold">{x.label}</p><p className="text-sm text-ink-500">{x.description} · {x.minutes} min</p></div><div className="text-right text-sm"><p>Customer {money(x.customerPriceCents)}</p><p className="font-bold">Driver payout {money(x.driverPayoutCents)}</p></div></div></Card>)}</section></div>; }
function Sales({ rows, sale, setSale }: any) { return <section><h2 className="mb-3 text-lg font-bold">Sales, timelines, payouts & warranties</h2>{rows.length ? rows.map((x: any) => <Card key={x.id} className="mb-2 p-4"><div className="flex flex-wrap justify-between gap-3"><div><p className="font-bold">{x.vehicle || "Vehicle unavailable"} · GROUP {x.groupSize || "—"}</p><p className="text-sm text-ink-500">{x.contractorName} · {x.status}</p><p className="text-xs text-ink-400">Battery {money(x.batteryCents)} · install {money(x.installCents)} · tax {money(x.taxCents)} · admin {money(x.adminFeeCents)} · total <strong>{money(x.totalCents)}</strong></p><p className="text-xs text-ink-400">Install job {x.installJobId || "—"} · payout {money(x.payoutCents)} · warranty {date(x.warrantyStartsAt)}–{date(x.warrantyExpiresAt)}</p></div><Button onClick={async () => { const detail = await getBatterySaleDetail({ data: { saleId: x.id } }); if (detail.ok) setSale(detail); }}>View detail</Button></div></Card>) : <EmptyState icon={Package} title="No battery sales" body="Only real sale rows appear here." />}{sale && <Card className="mt-4 border-brand-200 p-4"><div className="flex justify-between"><h3 className="font-bold">Sale detail · {sale.sale.vehicle}</h3><button onClick={() => setSale(null)} className="text-sm text-ink-500">Close</button></div><h4 className="mt-4 font-bold">Status timeline</h4>{sale.timeline.length ? sale.timeline.map((x: any, i: number) => <p key={i} className="mt-2 text-sm">{date(x.at)} · {x.from} → {x.to}</p>) : <p className="mt-2 text-sm text-ink-500">No linked status events.</p>}<p className="mt-4 text-sm text-ink-500">{sale.photos.length} photos · {sale.audits.length} audit entries · payout {money(sale.sale.payout?.amountCents)}</p></Card>}</section>; }
function Compatibility({ rows }: any) { return <section><h2 className="mb-3 text-lg font-bold">Compatibility dataset</h2>{rows.length ? rows.map((x: any) => <Card key={x.id} className="mb-2 p-3"><p className="font-semibold">{x.yearFrom}–{x.yearTo} {x.make} {x.model} · {x.groupSize}</p><p className="text-xs text-ink-400">{x.status} · {x.engine || "Any engine"} · {x.sourceReferenceInternal || "No provenance"}</p></Card>) : <EmptyState icon={ClipboardCheck} title="No compatibility rows" body="Import the authoritative compatibility CSV to add rows." />}</section>; }
function Audit({ rows }: any) { return <section><h2 className="mb-3 text-lg font-bold">Owner change history</h2>{rows.length ? rows.map((x: any) => <Card key={x.id} className="mb-2 p-3"><p className="text-sm font-semibold">{x.action} · {x.entityType} · {x.entityId}</p><p className="text-xs text-ink-400">{date(x.occurredAt)} · {x.actorRole} {x.actorUserId}</p><pre className="mt-2 overflow-x-auto text-xs text-ink-500">{JSON.stringify(x.detail)}</pre></Card>) : <EmptyState icon={FileClock} title="No battery audit rows" body="Owner changes will be recorded here." />}</section>; }

function ImportPanel({ onImported }: { onImported: () => Promise<void> }) {
  const [kind, setKind] = useState<ImportKind>("price-book");
  const [fileName, setFileName] = useState("");
  const [csv, setCsv] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const lines = useMemo(() => csv.split(/\r?\n/).filter((line) => line.trim()), [csv]);
  const preview = lines.slice(0, 6);
  const selectFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(""); setResult(""); setFileName(file.name); setCsv(await file.text());
  };
  const confirm = async () => {
    if (!csv.trim()) { setError("Choose a CSV file before confirming."); return; }
    setBusy(true); setError(""); setResult("");
    const response = kind === "price-book" ? await importOwnerBatteryPriceBook({ data: { csv } }) : await importOwnerBatteryCompatibility({ data: { csv } });
    setBusy(false);
    if (!response.ok) { setError(response.message || "Import rejected. No rows were written."); return; }
    setResult(`Validated and imported ${response.imported} row${response.imported === 1 ? "" : "s"}.`);
    await onImported();
  };
  return <Card className="p-5"><div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600"><Upload size={18} /></span><div><h2 className="text-lg font-bold">CSV import</h2><p className="mt-1 text-sm text-ink-500">Select an authoritative CSV, preview its rows, then confirm. The server validates every row before one atomic owner-only write and audit entry.</p></div></div><div className="mt-5 grid gap-4 sm:grid-cols-2"><label className="text-sm font-semibold">Dataset<select value={kind} onChange={(event) => { setKind(event.target.value as ImportKind); setFileName(""); setCsv(""); setError(""); setResult(""); }} className="mt-1 block h-11 w-full rounded-xl border border-ink-200 bg-white px-3"><option value="price-book">Price book</option><option value="compatibility">Compatibility</option></select></label><label className="text-sm font-semibold">CSV file<input type="file" accept=".csv,text/csv" onChange={selectFile} className="mt-1 block w-full rounded-xl border border-dashed border-ink-300 bg-white p-2 text-sm" /></label></div>{fileName && <p className="mt-3 text-xs text-ink-500">Selected: <strong>{fileName}</strong> · {Math.max(0, lines.length - 1)} data row{lines.length - 1 === 1 ? "" : "s"}</p>}{preview.length > 0 && <div className="mt-4 overflow-x-auto rounded-xl border border-ink-100"><table className="min-w-full text-left text-xs"><caption className="bg-ink-50 px-3 py-2 text-left font-semibold text-ink-600">Preview (first {Math.min(5, Math.max(0, preview.length - 1))} data rows)</caption><tbody>{preview.map((line, index) => <tr key={index} className="border-t border-ink-100"><td className="max-w-[680px] whitespace-pre-wrap px-3 py-2 font-mono">{line}</td></tr>)}</tbody></table></div>}{error && <p role="alert" className="mt-3 rounded-xl bg-danger-50 p-3 text-sm font-semibold text-danger-700">{error}</p>}{result && <p role="status" className="mt-3 rounded-xl bg-success-50 p-3 text-sm font-semibold text-success-700">{result}</p>}<div className="mt-5 flex flex-wrap items-center gap-3"><Button onClick={confirm} loading={busy} disabled={!csv.trim()}>Validate & import</Button><p className="text-xs text-ink-400">Invalid rows leave the database unchanged.</p></div></Card>;
}
