import { createFileRoute, Link } from "@tanstack/react-router";
import { Plug, X, CheckCircle2, AlertTriangle, RefreshCw, Radar, CarFront, UserRound, Unlink, Link2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { AppShell } from "~/components/app-shell";
import { AiToggle } from "~/components/ai-dispatcher-views";
import { Button, Card } from "~/components/ui";
import { connectTowbook, disconnectTowbook, towbookStatus, towbookSyncNow, type TowbookSyncResult } from "~/data/server";
import { getGeofenceSettingsFn, updateGeofenceSettings } from "~/data/driver-gps";
import { driverLinkStatus, linkDriverAccount, unlinkDriverAccount, type DriverLinkStatus } from "~/data/auth";
import { tirePlugRate, setTirePlugRate } from "~/data/tire-plug";
import { listBatteryProducts, upsertBatteryProduct } from "~/data/battery-pricebook";

export const Route = createFileRoute("/owner/settings")({ component: OwnerSettings });
function OwnerSettings() {
  const [open, setOpen] = useState(false), [username,setUsername]=useState(""), [password,setPassword]=useState("");
  const [status,setStatus]=useState<{connected:boolean;lastSyncAt:string|null;lastResult:TowbookSyncResult|null}>({connected:false,lastSyncAt:null,lastResult:null});
  const [pending,setPending]=useState(false), [error,setError]=useState(""), [success,setSuccess]=useState(false);
  const [sync,setSync]=useState<{pending:boolean;result:TowbookSyncResult|null}>({pending:false,result:null});
  const refresh=async()=>{const r=await towbookStatus();if(r.ok)setStatus({connected:!!r.connected,lastSyncAt:r.lastSyncAt,lastResult:r.lastResult});};
  useEffect(()=>{void refresh()},[]);
  const submit=async(e:FormEvent)=>{e.preventDefault();setPending(true);setError("");setSuccess(false);const r=await connectTowbook({data:{username,password}});setPending(false);if(r.ok){setPassword("");setOpen(false);setSuccess(true);void refresh()}else setError(r.error.message)};
  const disconnect=async()=>{setPending(true);const r=await disconnectTowbook();setPending(false);if(r.ok){setStatus({connected:false,lastSyncAt:null,lastResult:null});setSuccess(false);setSync({pending:false,result:null})}else setError(r.error.message)};
  const syncNow=async()=>{setSync((s)=>({...s,pending:true}));const r=await towbookSyncNow();setSync({pending:false,result:r});void refresh()};
  const lastShown = sync.result ?? status.lastResult;
  return <AppShell portal="owner" title="Settings" description="Keep your organization and integrations connected.">
    <Card className="border-brand-200 bg-gradient-to-br from-brand-50/70 to-surface p-6 sm:p-8"><div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between"><div className="flex gap-4"><span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-brand-500 text-white"><Plug className="size-6" /></span><div><p className="text-xs font-bold uppercase tracking-wider text-brand-700">Dispatch integration</p><h2 className="mt-1 text-xl font-bold">Towbook</h2><p className="mt-1 max-w-lg text-sm text-ink-500">Bring live roadside jobs into Lightning Dispatch and keep your queue current.</p>{status.connected&&<p className="mt-3 flex items-center gap-2 text-sm font-semibold text-success-700"><CheckCircle2 className="size-4"/>Connected{status.lastSyncAt&&` · Last sync ${new Date(status.lastSyncAt).toLocaleString()}`}</p>}</div></div><div className="flex shrink-0 flex-col gap-2 sm:items-end">{status.connected?<div className="flex gap-2"><Button variant="secondary" onClick={syncNow} loading={sync.pending}><RefreshCw className="size-4"/>Sync now</Button><Button variant="ghost" className="border border-ink-200" onClick={disconnect} loading={pending}>Disconnect</Button></div>:<Button className="shrink-0" onClick={()=>{setOpen(true);setError("")}}>Connect Towbook</Button>}</div></div>
    {lastShown&&<SyncResultLine result={lastShown}/>}
    {success&&<p className="mt-5 rounded-xl bg-success-50 p-3 text-sm text-success-700">Towbook connected securely. The background puller can now use this session.</p>}{error&&!open&&<p className="mt-5 flex gap-2 rounded-xl bg-danger-50 p-3 text-sm text-danger-700"><AlertTriangle className="size-4 shrink-0"/>{error}</p>}</Card>
    <div className="mt-6"><DriverAccountCard /></div>
    <div className="mt-6"><GeofenceSettingsCard /></div>
    <div className="mt-6"><TirePlugRateCard /></div>
    <div className="mt-6"><BatteryRatesCard /></div>
    <div className="mt-6"><BatteryPriceBookCard /></div>
    <div className="mt-6"><Link to="/owner/batteries" className="text-sm font-semibold text-brand-600 underline">Battery compatibility reviews</Link></div>
    {open&&<div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/40 p-4" role="dialog" aria-modal="true" aria-labelledby="towbook-title"><Card className="w-full max-w-md p-6"><div className="flex items-start justify-between gap-4"><div><span className="grid size-10 place-items-center rounded-xl bg-brand-50 text-brand-600"><Plug className="size-5"/></span><h2 id="towbook-title" className="mt-4 text-xl font-bold">Connect Towbook</h2></div><button className="grid size-11 place-items-center rounded-xl text-ink-400 hover:bg-ink-50" aria-label="Close" onClick={()=>setOpen(false)}><X className="size-5"/></button></div><p className="mt-4 text-sm leading-relaxed text-ink-600">Enter your Towbook login once. Your password is used only to establish an encrypted session and is never stored.</p><form onSubmit={submit} className="mt-5 space-y-4"><label className="block text-sm font-semibold">Towbook username<input required type="text" value={username} onChange={e=>setUsername(e.target.value)} placeholder="e.g. mjohnson — often your email" className="mt-1 h-11 w-full rounded-xl border border-ink-200 px-3"/></label><label className="block text-sm font-semibold">Towbook password<input required type="password" value={password} onChange={e=>setPassword(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-ink-200 px-3"/></label>{error&&<p className="flex gap-2 rounded-xl bg-danger-50 p-3 text-sm text-danger-700"><AlertTriangle className="size-4 shrink-0"/>{error}</p>}<Button type="submit" className="w-full" loading={pending}>Connect securely</Button></form></Card></div>}
  </AppShell>;
}

/** One result line for a sync run — the fresh run after clicking Sync now, or the
 *  last persisted run (read from towbook_sessions.last_result on page load). */
function SyncResultLine({ result }: { result: TowbookSyncResult }) {
  const t = result.ranAt ? new Date(result.ranAt) : null;
  const time = t ? t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
  const tone = result.ok ? "bg-success-50 text-success-700" : "bg-amber-50 text-amber-800";
  const noJobs = result.ok && result.added === 0 && result.updated === 0 && result.failed === 0;
  return (
    <div className={`mt-5 rounded-xl p-3 text-sm ${tone}`}>
      <p className="flex items-start gap-2 font-semibold">
        {result.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
        <span>
          Last sync {time} — {result.added} added · {result.updated} updated · {result.failed} failed
        </span>
      </p>
      <p className="mt-1.5 pl-6 text-xs leading-relaxed opacity-90">{result.message}</p>
      {noJobs && (
        <p className="mt-2 rounded-lg bg-amber-100/60 p-2.5 pl-6 text-xs font-medium">
          No jobs imported yet — the Towbook job-list mapping is being refined. This run's diagnostics were saved to the database so the next release can target the exact endpoint; click Sync now again after an update.
        </p>
      )}
      {result.diagnostics.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer pl-6 text-xs font-semibold text-ink-500">Sync diagnostics ({result.diagnostics.length} probes)</summary>
          <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto pl-6 font-mono text-[11px] leading-relaxed text-ink-500">
            {result.diagnostics.map((d, i) => (
              <li key={i} className="truncate">
                <span className="font-bold">{d.status ?? "—"}</span> {d.url.replace("https://app.towbook.com", "") || "/"} <span className="text-ink-400">— {d.hint}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Arrival detection card (milestone #3): geofence auto-arrive radius + the
 *  pre-arrival-photos gate flag. The photos flag stays OFF until the photo
 *  workflow (#4) ships — flipping it on makes auto-arrive require 4 pre-arrival
 *  photos + a vehicle-match confirmation on the job. */
function GeofenceSettingsCard() {
  const [radius, setRadius] = useState<string>("150");
  const [photosRequired, setPhotosRequired] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    void (async () => {
      const r = await getGeofenceSettingsFn();
      if (r) { setRadius(String(r.geofenceRadiusMeters)); setPhotosRequired(r.photosRequired); }
      setLoaded(true);
    })();
  }, []);
  const save = async () => {
    const n = Number(radius);
    if (!Number.isFinite(n) || n < 0 || n > 5000) { setMessage({ ok: false, text: "Enter a radius between 0 and 5000 meters." }); return; }
    setPending(true); setMessage(null);
    const r = await updateGeofenceSettings({ data: { geofenceRadiusMeters: Math.round(n), photosRequired } });
    setPending(false);
    if (r.ok) setMessage({ ok: true, text: `Saved — auto-arrive radius ${Math.round(n)} m${photosRequired ? ", photos required before arrival" : ""}.` });
    else setMessage({ ok: false, text: r.error });
  };
  return (
    <Card className="p-6 sm:p-8">
      <div className="flex gap-4">
        <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-ink-950 text-white"><Radar className="size-6" /></span>
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-ink-500">Arrival detection</p>
          <h2 className="mt-1 text-xl font-bold">Geofence auto-arrive</h2>
          <p className="mt-1 max-w-lg text-sm text-ink-500">When an en-route driver comes within the radius of the job's pickup point, the job is marked arrived in Lightning Dispatch and Towbook automatically.</p>
        </div>
      </div>
      {!loaded ? (
        <div className="mt-5 h-10 animate-pulse rounded-xl bg-ink-100/70" />
      ) : (
        <div className="mt-5 grid gap-4 sm:max-w-lg">
          <label className="block text-sm font-semibold">
            Arrival radius (meters)
            <input
              type="number" min={0} max={5000} inputMode="numeric" value={radius}
              onChange={(e) => setRadius(e.target.value)}
              className="mt-1 h-11 w-full rounded-xl border border-ink-200 px-3"
            />
          </label>
          <div className="flex items-center justify-between gap-3 rounded-xl bg-ink-50 px-4 py-3">
            <div>
              <p className="text-sm font-semibold">Require 4 pre-arrival photos</p>
              <p className="text-xs text-ink-500">Photos + vehicle-match confirmation gate auto-arrive. Turns on when the photo workflow ships (milestone #4).</p>
            </div>
            <AiToggle checked={photosRequired} onChange={setPhotosRequired} label="Require pre-arrival photos before auto-arrive" />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void save()} loading={pending}>Save arrival settings</Button>
            {message && <p className={`text-sm font-medium ${message.ok ? "text-success-700" : "text-danger-600"}`}>{message.text}</p>}
          </div>
        </div>
      )}
    </Card>
  );
}


/** "My driver account" card (owner↔contractor view toggle, 2026-08-12, spec
 *  §5). Owner/admin only (server-gated): shape-a accounts (own dispatch id)
 *  get a read-only note + the Driver view shortcut; shape-b shows the linked
 *  driver (sign-in + last activity + unlink); nothing shows an idle state with
 *  the link picker (bottom sheet, confirmable). A linked driver later removed
 *  shows a warning and the link UI is disabled. */
function DriverAccountCard() {
  const [status, setStatus] = useState<DriverLinkStatus | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [confirm, setConfirm] = useState<null | { kind: "link"; driverId: string; driverName: string } | { kind: "unlink" }>(null);
  useEffect(() => {
    void driverLinkStatus().then(setStatus).catch(() => setStatus({ ok: false, error: "Unable to load driver account info." }));
  }, []);
  if (!status) return <Card className="p-6"><div className="h-24 animate-pulse rounded-xl bg-ink-100/70" aria-busy="true" /></Card>;
  if (!status.ok) return <Card className="p-6"><p className="text-sm text-danger-600">{status.error}</p></Card>;
  const linked = status.linked;
  const candidates = filter.trim() ? status.candidates.filter((c) => c.name.toLowerCase().includes(filter.trim().toLowerCase())) : status.candidates;
  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setPending(true); setError("");
    const r = await fn();
    setPending(false);
    if (!r.ok) setError(r.error ?? "Something went wrong.");
    else {
      setConfirm(null); setPickOpen(false); setFilter("");
      const next = await driverLinkStatus();
      setStatus(next);
    }
  };
  return (
    <Card className="p-6">
      <div className="flex items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600"><UserRound className="size-5" /></span>
        <div>
          <h2 className="text-lg font-bold">My driver account</h2>
          <p className="text-sm text-ink-500">Drive jobs from the same sign-in — the Driver view switch appears in your header.</p>
        </div>
      </div>
      <div className="mt-5 space-y-4 text-sm">
        {status.ownDriverId ? (
          <div className="flex items-center justify-between gap-3 rounded-xl bg-ink-50 p-4">
            <div>
              <p className="font-bold text-ink-800">You are a driver</p>
              <p className="text-xs text-ink-500">Your account carries dispatch driver ID <span className="font-mono font-semibold">{status.ownDriverId}</span>. Open the Driver view switch in the top-right of any owner page.</p>
            </div>
            <Link to="/driver" className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full bg-ink-950 px-4 text-xs font-bold text-white"><CarFront className="size-4" /> Driver view</Link>
          </div>
        ) : linked ? (
          <div className="rounded-xl bg-ink-50 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="break-words font-bold text-ink-800">{linked.name} <span className="ml-1 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700">{linked.deactivated ? "Removed from roster" : "Linked"}</span></p>
                <p className="text-xs text-ink-500">Driver ID <span className="font-mono font-semibold">{linked.towbookDriverId}</span>{linked.signedIn ? " · signed in" : " · hasn't signed in yet"}{linked.lastActivityAt ? ` · last active ${new Date(linked.lastActivityAt).toLocaleDateString()}` : ""}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Link to="/driver" className="inline-flex h-10 items-center gap-2 rounded-full bg-ink-950 px-4 text-xs font-bold text-white"><CarFront className="size-4" /> Driver view</Link>
                <button type="button" disabled={pending} onClick={() => setConfirm({ kind: "unlink" })} className="inline-flex h-10 items-center gap-1.5 rounded-full border border-ink-200 px-3 text-xs font-bold text-ink-600 hover:bg-ink-50"><Unlink className="size-3.5" /> Unlink</button>
              </div>
            </div>
            {linked.deactivated && <p className="mt-3 flex gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-800"><AlertTriangle className="size-4 shrink-0" /> This driver was removed from the roster. The Driver view switch is hidden until you unlink and link an active driver.</p>}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-ink-200 p-4">
            <p className="font-bold text-ink-800">No driver account linked</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-500">If you also drive, link one of your active contractors and the Driver view switch appears in the header. The linked driver still uses their own login — this only lets you step into their driver view with your sign-in.</p>
            <button type="button" disabled={pending || !status.candidates.length} onClick={() => setPickOpen(true)} className="mt-3 inline-flex h-10 items-center gap-2 rounded-full bg-ink-950 px-4 text-xs font-bold text-white disabled:opacity-40"><Link2 className="size-4" /> Link driver account</button>
            {!status.candidates.length && <p className="mt-2 text-xs text-ink-400">No linkable drivers yet — a driver becomes linkable once they've signed in from their phone.</p>}
          </div>
        )}
        {error && <p className="flex gap-2 rounded-xl bg-danger-50 p-3 text-xs text-danger-700"><AlertTriangle className="size-4 shrink-0" /> {error}</p>}
      </div>
      {pickOpen && (
        <div className="fixed inset-0 z-50 grid place-items-end bg-ink-950/40 p-0 sm:place-items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="link-driver-title" onClick={() => setPickOpen(false)}>
          <div className="max-h-[80dvh] w-full overflow-y-auto rounded-t-3xl bg-surface p-5 sm:max-w-md sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3">
              <h2 id="link-driver-title" className="text-lg font-bold">Link a driver</h2>
              <button className="grid size-10 place-items-center rounded-xl text-ink-400 hover:bg-ink-50" aria-label="Close" onClick={() => setPickOpen(false)}><X className="size-5" /></button>
            </div>
            <p className="mt-1 text-sm text-ink-500">This adds the Driver view switch to your header. Only drivers who've signed in once from their phone are listed.</p>
            <input autoFocus type="text" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search drivers…" className="mt-4 h-11 w-full rounded-xl border border-ink-200 px-3 text-sm" />
            <div className="mt-3 space-y-2">
              {candidates.map((c) => (
                <button key={c.id} type="button" onClick={() => setConfirm({ kind: "link", driverId: c.id, driverName: c.name })} className="flex w-full items-center gap-3 rounded-xl border border-ink-100 p-3 text-left hover:bg-ink-50">
                  <span className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-50 text-sm font-bold text-brand-700">{c.name.trim().slice(0, 1).toUpperCase() || "D"}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-sm font-bold text-ink-800">{c.name}</span>
                    <span className="block text-xs text-ink-500">Driver ID {c.towbookDriverId}{c.signedIn ? " · signed in" : ""}</span>
                  </span>
                  <span className="shrink-0 rounded-full bg-ink-950 px-3 py-1 text-xs font-bold text-white">Link</span>
                </button>
              ))}
              {!candidates.length && <p className="py-6 text-center text-sm text-ink-400">No drivers match{filter ? ` “${filter}”` : ""}.</p>}
            </div>
          </div>
        </div>
      )}
      {confirm?.kind === "link" && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/40 p-4" role="alertdialog" aria-modal="true" aria-labelledby="link-confirm-title">
          <Card className="w-full max-w-sm p-6">
            <h2 id="link-confirm-title" className="text-lg font-bold">Link {confirm.driverName}?</h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-600">You'll be able to switch to the driver app from your header and work jobs as this driver. Their own login is unaffected.</p>
            <div className="mt-5 flex gap-3">
              <Button className="flex-1" loading={pending} onClick={() => void act(() => linkDriverAccount({ data: { driverUserId: confirm.driverId } }))}>Link driver</Button>
              <button type="button" onClick={() => setConfirm(null)} className="rounded-xl border border-ink-200 px-4 text-sm font-bold text-ink-600 hover:bg-ink-50">Cancel</button>
            </div>
          </Card>
        </div>
      )}
      {confirm?.kind === "unlink" && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/40 p-4" role="alertdialog" aria-modal="true" aria-labelledby="unlink-confirm-title">
          <Card className="w-full max-w-sm p-6">
            <h2 id="unlink-confirm-title" className="text-lg font-bold">Unlink driver account?</h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-600">The Driver view switch will disappear until you link another driver. Nothing changes for the driver's own login.</p>
            <div className="mt-5 flex gap-3">
              <Button className="flex-1" loading={pending} onClick={() => void act(() => unlinkDriverAccount())}>Unlink</Button>
              <button type="button" onClick={() => setConfirm(null)} className="rounded-xl border border-ink-200 px-4 text-sm font-bold text-ink-600 hover:bg-ink-50">Cancel</button>
            </div>
          </Card>
        </div>
      )}
    </Card>
  );
}


function TirePlugRateCard() {
  const [rate, setRate] = useState("45.00"); const [loaded, setLoaded] = useState(false); const [saving, setSaving] = useState(false); const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { void tirePlugRate().then((c) => { setRate((c / 100).toFixed(2)); setLoaded(true); }); }, []);
  const save = async () => { const cents = Math.round(Number(rate) * 100); if (!Number.isFinite(cents) || cents < 0 || cents > 100000) { setMessage("Enter a valid rate from $0 to $1,000."); return; } setSaving(true); const r = await setTirePlugRate({ data: cents }); setSaving(false); setMessage(r.ok ? `Saved — new tire-plug offers will use ${(r.rateCents / 100).toFixed(2)}.` : r.message); };
  return <Card className="p-6 sm:p-8"><p className="text-xs font-bold uppercase tracking-wider text-ink-500">Battery services</p><h2 className="mt-1 text-xl font-bold">Tire-plug rate</h2><p className="mt-1 text-sm text-ink-500">Set the customer charge for new tire-plug offers. Existing jobs keep their captured rate.</p>{loaded ? <div className="mt-5 flex max-w-sm items-end gap-3"><label className="flex-1 text-sm font-semibold">Customer charge ($)<input type="number" min="0" max="1000" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-ink-200 px-3" /></label><Button onClick={() => void save()} loading={saving}>Save</Button></div> : <div className="mt-5 h-11 animate-pulse rounded-xl bg-ink-100" />}{message && <p className="mt-3 rounded-xl bg-success-50 p-3 text-sm text-success-700">{message}</p>}</Card>;
}

/* ------------------- Battery sale rates (owner-spec'd 2026-08-13) ------------------- */
import { Zap } from "lucide-react";
import { getBatteryRates, updateBatteryRates } from "~/data/battery-sales";
function BatteryRatesCard() {
  const [loaded, setLoaded] = useState(false);
  const [tax, setTax] = useState("6.35");
  const [admin, setAdmin] = useState("8.75");
  const [std, setStd] = useState("45");
  const [adv, setAdv] = useState("65");
  const [warehouse, setWarehouse] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    void (async () => {
      const r = await getBatteryRates();
      if (r.ok) {
        setTax((r.rates.taxRateBps / 100).toFixed(2));
        setAdmin((r.rates.adminFeeBps / 100).toFixed(2));
        setStd((r.rates.installStandardCents / 100).toFixed(2));
        setAdv((r.rates.installAdvancedCents / 100).toFixed(2));
        setWarehouse(r.rates.warehouseAddress);
      }
      setLoaded(true);
    })();
  }, []);
  const save = async () => {
    const taxN = Number(tax), adminN = Number(admin), stdN = Number(std), advN = Number(adv);
    if (![taxN, adminN, stdN, advN].every((n) => Number.isFinite(n) && n >= 0) || taxN > 50 || adminN > 50 || stdN > 1000 || advN > 1000) {
      setMessage({ ok: false, text: "Enter valid values — tax and admin fee as %, install fees in dollars." });
      return;
    }
    setPending(true);
    setMessage(null);
    const r = await updateBatteryRates({ data: { taxRateBps: Math.round(taxN * 100), adminFeeBps: Math.round(adminN * 100), installStandardCents: Math.round(stdN * 100), installAdvancedCents: Math.round(advN * 100), warehouseAddress: warehouse.trim() } });
    setPending(false);
    if (r.ok) setMessage({ ok: true, text: "Saved — new battery rates are live for the next quote." });
    else setMessage({ ok: false, text: r.message });
  };
  return (
    <Card className="p-6 sm:p-8">
      <div className="flex gap-4">
        <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-brand-500 text-white"><Zap className="size-6" /></span>
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-ink-500">Battery sales</p>
          <h2 className="mt-1 text-xl font-bold">Battery sale rates</h2>
          <p className="mt-1 max-w-lg text-sm text-ink-500">
            Tax and admin fee apply to the BATTERY PRICE ONLY — the install fee is never taxed and carries no admin fee (owner-corrected formula).
          </p>
        </div>
      </div>
      {!loaded ? (
        <div className="mt-5 h-10 animate-pulse rounded-xl bg-ink-100/70" />
      ) : (
        <div className="mt-5 grid gap-4 sm:max-w-lg">
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm font-semibold">Sales tax %<input type="number" step="0.01" min={0} max={50} value={tax} onChange={(e) => setTax(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-ink-200 px-3" /></label>
            <label className="block text-sm font-semibold">Admin fee %<input type="number" step="0.01" min={0} max={50} value={admin} onChange={(e) => setAdmin(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-ink-200 px-3" /></label>
            <label className="block text-sm font-semibold">Standard install ($)<input type="number" step="1" min={0} max={1000} value={std} onChange={(e) => setStd(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-ink-200 px-3" /></label>
            <label className="block text-sm font-semibold">Advanced install ($)<input type="number" step="1" min={0} max={1000} value={adv} onChange={(e) => setAdv(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-ink-200 px-3" /></label>
          </div>
          <label className="block text-sm font-semibold">Warehouse pickup address
            <input type="text" value={warehouse} onChange={(e) => setWarehouse(e.target.value)} placeholder="Where contractors pick up sold batteries" className="mt-1 h-11 w-full rounded-xl border border-ink-200 px-3" />
          </label>
          <Button onClick={() => void save()} loading={pending}>Save rates</Button>
          {message && <p className={`rounded-xl p-3 text-sm ${message.ok ? "bg-success-50 text-success-700" : "bg-danger-50 text-danger-600"}`}>{message.text}</p>}
        </div>
      )}
    </Card>
  );
}

function BatteryPriceBookCard() {
  type Product = Awaited<ReturnType<typeof listBatteryProducts>>[number];
  const [products,setProducts]=useState<Product[]>([]); const [loaded,setLoaded]=useState(false); const [message,setMessage]=useState("");
  const [newGroup,setNewGroup]=useState(""); const [adding,setAdding]=useState(false);
  useEffect(()=>{void listBatteryProducts().then(p=>{setProducts(p);setLoaded(true)})},[]);
  const save=async(p:Product, patch:Partial<Product>)=>{const next={...p,...patch};const r=await upsertBatteryProduct({data:{id:next.id,groupSize:next.groupSize,retailCents:next.retailCents,availability:next.availability as "in_stock"|"limited"|"unavailable"|"special_order",active:next.active,imageKey:next.imageKey,warrantyYears:next.warrantyYears,freeReplacementYears:next.freeReplacementYears}});if(r.ok)setProducts(xs=>xs.map(x=>x.id===p.id?r.product:x));setMessage(r.ok?`Saved GROUP ${p.groupSize}.`:r.message);};
  const add=async()=>{const group=newGroup.trim().toUpperCase();if(!group){setMessage("Enter a battery group size.");return}setAdding(true);const r=await upsertBatteryProduct({data:{groupSize:group,retailCents:0,availability:"special_order",active:false,imageKey:null,warrantyYears:3,freeReplacementYears:3}});setAdding(false);if(r.ok){setProducts(xs=>[...xs,r.product]);setNewGroup("");setMessage(`Added GROUP ${group}.`)}else setMessage(r.message)};
  return <Card className="p-6 sm:p-8"><p className="text-xs font-bold uppercase tracking-wider text-ink-500">Lightning Gold Battery</p><h2 className="mt-1 text-xl font-bold">Price book</h2><p className="mt-1 text-sm text-ink-500">Manage customer retail price, availability, active status, and warranty terms. Changes are audited and apply to future sales.</p>{!loaded?<div className="mt-5 h-12 animate-pulse rounded-xl bg-ink-100"/>:<><div className="mt-5 space-y-3">{products.map(p=><div key={p.id} className="grid gap-3 rounded-xl border border-ink-100 p-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end"><p className="font-bold">GROUP {p.groupSize}<span className="block text-xs font-normal text-ink-500">LIGHTNING GOLD BATTERY</span></p><label className="text-sm font-semibold">Retail ($)<input aria-label={`Retail GROUP ${p.groupSize}`} type="number" min="0" step="0.01" defaultValue={(p.retailCents/100).toFixed(2)} onBlur={e=>void save(p,{retailCents:Math.round(Number(e.target.value)*100)})} className="mt-1 h-10 w-full rounded-lg border border-ink-200 px-2" /></label><label className="text-sm font-semibold">Availability<select value={p.availability} onChange={e=>void save(p,{availability:e.target.value})} className="mt-1 h-10 w-full rounded-lg border border-ink-200 px-2"><option value="in_stock">In stock</option><option value="limited">Limited</option><option value="unavailable">Unavailable</option><option value="special_order">Special order</option></select></label><label className="text-sm font-semibold">Warranty years<input type="number" min="0" max="20" value={p.warrantyYears} onChange={e=>setProducts(xs=>xs.map(x=>x.id===p.id?{...x,warrantyYears:Number(e.target.value)}:x))} onBlur={e=>void save(p,{warrantyYears:Number(e.target.value)})} className="mt-1 h-10 w-full rounded-lg border border-ink-200 px-2" /></label><label className="text-sm font-semibold">Free replacement years<input type="number" min="0" max="20" value={p.freeReplacementYears} onChange={e=>setProducts(xs=>xs.map(x=>x.id===p.id?{...x,freeReplacementYears:Number(e.target.value)}:x))} onBlur={e=>void save(p,{freeReplacementYears:Number(e.target.value)})} className="mt-1 h-10 w-full rounded-lg border border-ink-200 px-2" /></label><label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={p.active} onChange={e=>void save(p,{active:e.target.checked})} /> Active</label></div>)}</div><div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-end"><label className="text-sm font-semibold">Add group size<input value={newGroup} onChange={e=>setNewGroup(e.target.value)} placeholder="e.g. 25 or 31" className="mt-1 h-10 w-full rounded-lg border border-ink-200 px-2" /></label><Button onClick={()=>void add()} loading={adding}>Add group</Button></div></>}{message&&<p className="mt-3 rounded-xl bg-success-50 p-3 text-sm text-success-700">{message}</p>}</Card>;
}
