import { createFileRoute } from "@tanstack/react-router";
import { Plug, X, CheckCircle2, AlertTriangle, RefreshCw, Radar } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { AppShell } from "~/components/app-shell";
import { AiToggle } from "~/components/ai-dispatcher-views";
import { Button, Card } from "~/components/ui";
import { connectTowbook, disconnectTowbook, towbookStatus, towbookSyncNow, type TowbookSyncResult } from "~/data/server";
import { getGeofenceSettingsFn, updateGeofenceSettings } from "~/data/driver-gps";

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
    <div className="mt-6"><GeofenceSettingsCard /></div>
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
