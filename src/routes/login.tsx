import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button, Card } from "~/components/ui";
import { authStatus, createOwner, login } from "~/data/auth";
import { driverLogin } from "~/data/driver-auth";
export const Route = createFileRoute('/login')({ component: Login });

type GeoFix = { latitude: number | null; longitude: number | null; denied: boolean };
/** Mobile-first geolocation capture for the driver auto check-in: best-effort,
 *  never blocks the form. Denied/unavailable → denied:true (the server checks
 *  the driver in with 0,0 and surfaces the "may not be dispatchable" warning). */
function useGeoFix(): GeoFix {
  const [fix, setFix] = useState<GeoFix>({ latitude: null, longitude: null, denied: false });
  useEffect(() => {
    let cancelled = false;
    const n = navigator as Navigator & { permissions?: unknown };
    if (!n || typeof n.geolocation === "undefined" || typeof n.geolocation.getCurrentPosition !== "function") {
      setFix({ latitude: null, longitude: null, denied: true });
      return;
    }
    try {
      n.geolocation.getCurrentPosition(
        (pos) => { if (!cancelled) setFix({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, denied: false }); },
        () => { if (!cancelled) setFix({ latitude: null, longitude: null, denied: true }); },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
      );
    } catch {
      if (!cancelled) setFix({ latitude: null, longitude: null, denied: true });
    }
    return () => { cancelled = true; };
  }, []);
  return fix;
}

function Login(){ const nav=useNavigate(); const search=useSearch({from:"/login" as any}) as {next?:string}; const [first,setFirst]=useState(false); const [name,setName]=useState(""); const [identifier,setIdentifier]=useState(""); const [password,setPassword]=useState(""); const [error,setError]=useState(""); const [driverNotice,setDriverNotice]=useState(""); const [busy,setBusy]=useState(false); const [checking,setChecking]=useState(true); const geo = useGeoFix();
 useEffect(()=>{void authStatus().then((s)=>{if(s.mode!=="demo" && s.user) void nav({to:s.user.role==="contractor"?"/driver":s.user.role==="dispatcher"?"/ops":"/owner",replace:true}); else if(s.mode!=="demo") setFirst(!!s.needsOwner);}).catch(()=>{ /* keep login available when auth check fails */ }).finally(()=>setChecking(false));},[nav]);
 // One login routes every role to its own workspace — the server decides the role.
 const portal=(role:string)=>role==="contractor"?"/driver":role==="dispatcher"?"/ops":"/owner";
 async function submit(e:React.FormEvent){e.preventDefault();setBusy(true);setError("");setDriverNotice(""); try {
   // 1) LD account (owner/dispatcher/admin)
   const r=first?await createOwner({data:{name,email:identifier,password}}):await login({data:{identifier,password}});
   if(r.ok){ const role=("role" in r && r.role)?r.role:"owner"; void nav({to:search.next||portal(role),replace:true}); return; }
   // 2) Driver: their username+password ARE their Towbook credentials. Only
   //    attempted when the LD path did not match — one form, server decides.
   const d=await driverLogin({data:{username:identifier,password,latitude:geo.latitude,longitude:geo.longitude,locationDenied:geo.denied}});
   if(d.ok){ if(d.checkinWarning) setDriverNotice(d.checkinWarning); void nav({to:"/driver",replace:true}); return; }
   setError(d.error || r.error);
 } catch (err) { setError(err instanceof Error ? err.message : "Unable to sign in. Please try again."); } finally { setBusy(false); }}
 if(checking) return <main className="grid min-h-dvh place-items-center bg-canvas px-4"><div className="flex flex-col items-center gap-3" role="status" aria-live="polite"><div className="size-8 animate-spin rounded-full border-2 border-brand-500 border-t-transparent motion-reduce:animate-none" aria-hidden="true" /><p className="text-sm font-medium text-ink-400">Loading…</p></div></main>;
 return <main className="grid min-h-dvh place-items-center bg-canvas px-4"><Card className="w-full max-w-md p-7"><div className="mb-7"><p className="text-xs font-bold uppercase tracking-[.18em] text-brand-600">Lightning Dispatch OS</p><h1 className="mt-2 text-2xl font-bold text-ink-800">{first?"Create owner account":"Welcome back"}</h1><p className="mt-2 text-sm text-ink-400">{first?"Set the owner credentials for your organization.":"Sign in with your platform credentials — drivers use their Towbook login."}</p></div><form onSubmit={submit} className="space-y-4">{first&&<label className="block text-sm font-semibold text-ink-700">Name<input required value={name} onChange={e=>setName(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-ink-200 px-3" /></label>}<label className="block text-sm font-semibold text-ink-700">{first?"Email":"Email or username"}<input required type="text" inputMode="email" autoCapitalize="none" autoComplete="username" value={identifier} onChange={e=>setIdentifier(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-ink-200 px-3" /></label><label className="block text-sm font-semibold text-ink-700">Password<input required type="password" minLength={1} value={password} onChange={e=>setPassword(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-ink-200 px-3" /><span className="mt-1 block text-xs font-normal text-ink-400">Drivers: this is your Towbook password.</span></label>{geo.denied&&<p className="rounded-xl bg-warning-50 p-3 text-xs text-warning-700">Location is off — allow location access so the AI can dispatch you. Without it you may not be dispatchable.</p>}{driverNotice&&<p role="status" className="rounded-xl bg-warning-50 p-3 text-sm text-warning-700">{driverNotice}</p>}{error&&<p role="alert" className="rounded-xl bg-danger-50 p-3 text-sm text-danger-600">{error}</p>}<Button type="submit" loading={busy} className="w-full">{first?"Create owner account":"Sign in"}</Button><p className="text-center text-xs leading-5 text-ink-400">One login for drivers, dispatchers, and owners — we'll route you to your workspace. Drivers are checked in when you sign in.</p></form></Card></main> }
