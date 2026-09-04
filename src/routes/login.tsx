import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button, Card } from "~/components/ui";
import { LegalLinks } from "~/components/legal-page";
import { authStatus, createOwner, login, shouldFallThroughToDriverLogin } from "~/data/auth";
import { driverLogin } from "~/data/driver-auth";
import { signupContractor, submitContractorApplication } from "~/data/contractor-signup";
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

/** Contractor capability keys offered at sign-up (owner's service-selection
 *  list). Keep in sync with SERVICE_SELECTION_SERVICE_TYPES in
 *  src/data/service-time-core.ts — duplicated here so this client component
 *  never imports a server-only module. */
const TOOL_OPTIONS = [
  { key: "jump_start", label: "Jump start" },
  { key: "tire_change", label: "Tire change" },
  { key: "fuel_delivery", label: "Fuel delivery" },
  { key: "lockout", label: "Unlock / lockout" },
  { key: "battery_standard", label: "Battery — standard" },
  { key: "battery_advanced", label: "Battery — advanced" },
  { key: "heavy_tow", label: "Heavy tow" },
] as const;

function Login(){ const nav=useNavigate(); const search=useSearch({from:"/login" as any}) as {next?:string}; const [first,setFirst]=useState(false); const [mode,setMode]=useState<"signin"|"signup">("signin"); const [name,setName]=useState(""); const [identifier,setIdentifier]=useState(""); const [password,setPassword]=useState(""); const [phone,setPhone]=useState(""); const [serviceArea,setServiceArea]=useState(""); const [tools,setTools]=useState<string[]>([]); const [error,setError]=useState(""); const [driverNotice,setDriverNotice]=useState(""); const [busy,setBusy]=useState(false); const [checking,setChecking]=useState(true); const geo = useGeoFix();
 useEffect(()=>{void authStatus().then((s)=>{if(s.mode==="database" && s.user) void nav({to:s.user.role==="contractor"?"/driver":s.user.role==="dispatcher"?"/ops":"/owner",replace:true}); else if(s.mode==="database") setFirst(!!s.needsOwner);}).catch(()=>{ /* keep login available when auth check fails */ }).finally(()=>setChecking(false));},[nav]);
 // One login routes every role to its own workspace — the server decides the role.
 const portal=(role:string)=>role==="contractor"?"/driver":role==="dispatcher"?"/ops":"/owner";
 const toggleTool=(key:string)=>setTools(t=>t.includes(key)?t.filter(k=>k!==key):[...t,key]);
 async function submit(e:React.FormEvent){e.preventDefault();setBusy(true);setError("");setDriverNotice(""); try {
   // Owner bootstrap (first run) — never falls through to the Towbook driver sign-in.
   if(first){const r=await createOwner({data:{name,email:identifier,password}});if(r.ok)void nav({to:typeof search.next==="string"&&search.next?search.next:"/owner",replace:true});else setError(r.error);return;}
   // 1) LD account (owner/admin/dispatcher/contractor). The LD failure carries a
   //    machine-readable reason; only an unknown identifier (likely a Towbook
   //    driver) or a contractor account (drivers authenticate via Towbook) may
   //    fall through to the driver sign-in below.
   const r=await login({data:{identifier,password}});
   if(r.ok){ const role: string = ("role" in r && typeof r.role === "string") ? r.role : "owner"; void nav({to:typeof search.next === "string" && search.next ? search.next : portal(role),replace:true}); return; }
   // 2) Owner/admin/dispatcher LD account: a wrong LD password STOPS here — never
   //    hit Towbook (it surfaced a misleading "Towbook could not be connected"
   //    error; the interactive-reconnect hint belongs to the Connect Towbook card).
   if(!shouldFallThroughToDriverLogin(r)){setError(r.reason==="invalid_password"?"That Lightning Dispatch password didn't match — try again, or contact dispatch for help.":r.error);return;}
   // 3) Driver: their username+password ARE their dispatch credentials (unknown
   //    identifier or contractor account) — one form, server decides.
   const d=await driverLogin({data:{username:identifier,password,latitude:geo.latitude,longitude:geo.longitude,locationDenied:geo.denied}});
   if(d.ok){ if(d.checkinWarning) setDriverNotice(d.checkinWarning); void nav({to:portal(d.role),replace:true}); return; }
   setError(d.error || r.error);
 } catch (err) { setError(err instanceof Error ? err.message : "Unable to sign in. Please try again."); } finally { setBusy(false); }}
 async function submitSignup(e:React.FormEvent){e.preventDefault();setBusy(true);setError(""); try {
   const s=await signupContractor({data:{name,email:identifier,password}});
   if(!s.ok){setError(s.error);return;}
   const a=await submitContractorApplication({data:{tools,serviceArea,phone}});
   if(!a.ok){setError(a.message);return;}
   void nav({to:"/driver",replace:true});
 } catch (err) { setError(err instanceof Error ? err.message : "Unable to create your account. Please try again."); } finally { setBusy(false); }}
 if(checking) return <main className="grid min-h-dvh place-items-center bg-canvas px-4"><div className="flex flex-col items-center gap-3" role="status" aria-live="polite"><div className="size-8 animate-spin rounded-full border-2 border-brand-500 border-t-transparent motion-reduce:animate-none" aria-hidden="true" /><p className="text-sm font-medium text-ink-400">Loading…</p></div></main>;
 return <main className="grid min-h-dvh place-items-center bg-canvas px-4"><Card className="w-full max-w-md p-7"><div className="mb-7"><p className="text-xs font-bold uppercase tracking-[.18em] text-brand-600">Lightning Dispatch OS</p><h1 className="mt-2 text-2xl font-bold text-ink-800">{first?"Create owner account":mode==="signup"?"Become a contractor":"Welcome back"}</h1><p className="mt-2 text-sm text-ink-400">{first?"Set the owner credentials for your organization.":mode==="signup"?"Tell us about you and the services you provide. We'll review your application and get back to you.":"Sign in with your Lightning Dispatch login — one account for drivers, dispatchers, and owners."}</p></div>
 {mode==="signup"&&!first?<form onSubmit={submitSignup} className="space-y-4">
   <label className="block text-sm font-semibold text-ink-700">Full name<input required value={name} onChange={e=>setName(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-ink-200 px-3" /></label>
   <label className="block text-sm font-semibold text-ink-700">Email<input required type="email" inputMode="email" autoCapitalize="none" autoComplete="email" value={identifier} onChange={e=>setIdentifier(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-ink-200 px-3" /></label>
   <label className="block text-sm font-semibold text-ink-700">Password<input required type="password" minLength={10} autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-ink-200 px-3" /><span className="mt-1 block text-xs font-normal text-ink-400">At least 10 characters.</span></label>
   <label className="block text-sm font-semibold text-ink-700">Phone<input type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={e=>setPhone(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-ink-200 px-3" /></label>
   <label className="block text-sm font-semibold text-ink-700">Service area<input type="text" placeholder="City, ST (e.g. Bridgeport, CT)" value={serviceArea} onChange={e=>setServiceArea(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-ink-200 px-3" /></label>
   <fieldset className="space-y-2"><legend className="text-sm font-semibold text-ink-700">Services you provide</legend>{TOOL_OPTIONS.map((t)=><label key={t.key} className="flex items-center gap-3 rounded-xl border border-ink-200 px-3 py-2.5 text-sm text-ink-700"><input type="checkbox" checked={tools.includes(t.key)} onChange={()=>toggleTool(t.key)} className="size-4 accent-brand-600" /><span>{t.label}</span></label>)}</fieldset>
   {error&&<p role="alert" className="rounded-xl bg-danger-50 p-3 text-sm text-danger-600">{error}</p>}
   <Button type="submit" loading={busy} className="w-full">Submit application</Button>
   <p className="text-center text-xs leading-5 text-ink-400">Your application is reviewed before you can receive jobs. We'll never turn you away — if we're not in your area yet, we'll add you to the waitlist.</p>
   <p className="text-center text-sm"><button type="button" onClick={()=>{setMode("signin");setError("");}} className="font-semibold text-brand-600 hover:text-brand-700">Already have an account? Sign in</button></p>
 </form>
 :<form onSubmit={submit} className="space-y-4">{first&&<label className="block text-sm font-semibold text-ink-700">Name<input required value={name} onChange={e=>setName(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-ink-200 px-3" /></label>}<label className="block text-sm font-semibold text-ink-700">{first?"Email":"Email or username"}<input required type="text" inputMode="email" autoCapitalize="none" autoComplete="username" value={identifier} onChange={e=>setIdentifier(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-ink-200 px-3" /></label><label className="block text-sm font-semibold text-ink-700">Password<input required type="password" minLength={1} autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-ink-200 px-3" /><span className="mt-1 block text-xs font-normal text-ink-400">Drivers: this is your dispatch password.</span></label>{geo.denied&&<p className="rounded-xl bg-warning-50 p-3 text-xs text-warning-700">Location is off — allow location access so the AI can dispatch you. Without it you may not be dispatchable.</p>}{driverNotice&&<p role="status" className="rounded-xl bg-warning-50 p-3 text-sm text-warning-700">{driverNotice}</p>}{error&&<p role="alert" className="rounded-xl bg-danger-50 p-3 text-sm text-danger-600">{error}</p>}<Button type="submit" loading={busy} className="w-full">{first?"Create owner account":"Sign in"}</Button>{!first&&<p className="text-center text-sm"><button type="button" onClick={()=>{setMode("signup");setError("");}} className="font-semibold text-brand-600 hover:text-brand-700">New contractor? Sign up</button></p>}<p className="text-center text-xs leading-5 text-ink-400">One login for drivers, dispatchers, and owners — we'll route you to your workspace. Drivers are checked in when you sign in.</p></form>}<div className="mt-6 border-t border-ink-100 pt-4"><LegalLinks className="justify-center" /></div></Card></main> }
