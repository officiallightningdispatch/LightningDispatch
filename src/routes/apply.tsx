import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Check, ChevronLeft, ChevronRight, ShieldCheck, Truck } from "lucide-react";
import { useState } from "react";
import { Button, Card } from "~/components/ui";
import { applyContractor } from "~/data/contractor-signup";

export const Route = createFileRoute("/apply")({ component: Apply });

const CAPABILITIES = [
  ["jump_start", "Jump starts"], ["tire_change", "Tire changes"],
  ["fuel_delivery", "Fuel delivery"], ["lockout", "Vehicle lockouts"],
  ["battery_standard", "Standard battery installation"],
  ["battery_advanced", "Advanced battery installation"], ["heavy_tow", "Towing"],
] as const;
const acknowledgements = [
  ["ageConfirmed", "I confirm I am at least 18 years old."],
  ["workAuthorized", "I confirm I am authorized to work in the United States."],
  ["independentContractorAgreed", "I acknowledge this is a 1099 independent-contractor opportunity."],
  ["backgroundCheckConsented", "I authorize verification of my submitted qualifications and documents."],
] as const;

function Apply() {
  const nav = useNavigate();
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name:"", phone:"", email:"", password:"", city:"", state:"", zip:"", experienceYears:"", year:"", make:"", model:"", color:"", tools:[] as string[], ageConfirmed:false, workAuthorized:false, independentContractorAgreed:false, backgroundCheckConsented:false });
  const set = (key:string, value:string|boolean|string[]) => setForm(f => ({...f,[key]:value}));
  const next = (e:React.FormEvent) => { e.preventDefault(); setError(""); setStep(s => Math.min(3,s+1)); window.scrollTo(0,0); };
  async function submit(e:React.FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const application = await applyContractor({data:{
        name:form.name, email:form.email, password:form.password,
        phone:form.phone, tools:form.tools, serviceArea:`${form.city}, ${form.state.toUpperCase()} ${form.zip}`,
        experienceYears:Number(form.experienceYears), vehicleDescription:`${form.year} ${form.make} ${form.model}, ${form.color}`,
        ageConfirmed:form.ageConfirmed, workAuthorized:form.workAuthorized,
        independentContractorAgreed:form.independentContractorAgreed, backgroundCheckConsented:form.backgroundCheckConsented,
      }});
      if (!application.ok) { setError(application.message); return; }
      void nav({to:"/driver/onboarding",replace:true});
    } catch (e) { setError(e instanceof Error ? String(e) : "Unable to submit your application. Please try again."); }
    finally { setBusy(false); }
  }
  const input="mt-1 h-12 w-full rounded-xl border border-ink-200 bg-white px-3 text-base outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100";
  return <main className="min-h-dvh bg-canvas px-4 py-6 sm:py-10"><div className="mx-auto max-w-xl">
    <div className="mb-6 flex items-center gap-3"><img src="/brand-dispatch.jpg" alt="Lightning Dispatch" className="size-12 rounded-xl object-cover"/><div><p className="text-xs font-bold uppercase tracking-[.16em] text-brand-600">Contractor application</p><h1 className="text-xl font-extrabold text-ink-900">Drive with Lightning Dispatch</h1></div></div>
    <div className="mb-5 grid grid-cols-3 gap-2" aria-label={`Step ${step} of 3`}>{["Account","Qualifications","Eligibility"].map((x,i)=><div key={x}><div className={`h-1.5 rounded-full ${i+1<=step?"bg-brand-600":"bg-ink-200"}`}/><p className={`mt-1 text-[11px] font-bold ${i+1===step?"text-brand-700":"text-ink-400"}`}>{i+1}. {x}</p></div>)}</div>
    <Card className="p-5 sm:p-7">
      {step===1&&<form onSubmit={next} className="space-y-4"><Header n="1" title="Create your account" body="Use contact details you check regularly."/>
        <Field label="Legal full name"><input required autoComplete="name" value={form.name} onChange={e=>set("name",e.target.value)} className={input}/></Field>
        <Field label="Mobile phone"><input required type="tel" autoComplete="tel" inputMode="tel" value={form.phone} onChange={e=>set("phone",e.target.value)} className={input}/></Field>
        <Field label="Email"><input required type="email" autoComplete="email" inputMode="email" autoCapitalize="none" value={form.email} onChange={e=>set("email",e.target.value)} className={input}/></Field>
        <Field label="Password"><input required type="password" minLength={10} autoComplete="new-password" value={form.password} onChange={e=>set("password",e.target.value)} className={input}/><small className="text-ink-500">At least 10 characters.</small></Field>
        {error&&<Error text={error}/>}<Button className="w-full" type="submit">Continue <ChevronRight className="size-4"/></Button></form>}
      {step===2&&<form onSubmit={next} className="space-y-4"><Header n="2" title="Your qualifications" body="Tell us where and how you can help motorists."/>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-6"><Field label="City" cls="sm:col-span-3"><input required value={form.city} onChange={e=>set("city",e.target.value)} className={input}/></Field><Field label="State" cls="sm:col-span-1"><input required pattern="[A-Za-z]{2}" maxLength={2} value={form.state} onChange={e=>set("state",e.target.value)} className={`${input} uppercase`}/></Field><Field label="ZIP code" cls="sm:col-span-2"><input required inputMode="numeric" pattern="[0-9]{5}(-[0-9]{4})?" value={form.zip} onChange={e=>set("zip",e.target.value)} className={input}/></Field></div>
        <Field label="Years of roadside experience"><input required type="number" min={0} max={80} inputMode="numeric" value={form.experienceYears} onChange={e=>set("experienceYears",e.target.value)} className={input}/></Field>
        <fieldset><legend className="mb-2 text-sm font-bold text-ink-800">Work vehicle</legend><div className="grid grid-cols-2 gap-3">{[["year","Year"],["make","Make"],["model","Model"],["color","Color"]].map(([k,l])=><Field key={k} label={l}><input required value={(form as any)[k]} onChange={e=>set(k,e.target.value)} className={input}/></Field>)}</div></fieldset>
        <fieldset className="space-y-2"><legend className="mb-2 text-sm font-bold text-ink-800">Roadside capabilities</legend>{CAPABILITIES.map(([key,label])=><label key={key} className="flex min-h-12 items-center gap-3 rounded-xl border border-ink-200 px-3 py-2 text-sm font-semibold text-ink-700"><input type="checkbox" checked={form.tools.includes(key)} onChange={()=>set("tools",form.tools.includes(key)?form.tools.filter(x=>x!==key):[...form.tools,key])} className="size-5 accent-brand-600"/>{label}</label>)}</fieldset>
        <div className="flex gap-2"><Button type="button" variant="secondary" onClick={()=>setStep(1)}><ChevronLeft className="size-4"/> Back</Button><Button className="flex-1" type="submit">Continue <ChevronRight className="size-4"/></Button></div></form>}
      {step===3&&<form onSubmit={submit} className="space-y-4"><Header n="3" title="Confirm your eligibility" body="Read and confirm each statement before submitting."/>
        <div className="rounded-xl border border-brand-100 bg-brand-50 p-4 text-sm leading-6 text-brand-900"><strong>Compensation</strong><br/>New contractors start at $16 per completed eligible job, with $0.25 performance-based increases every 90 days when required metrics are met. Job details and applicable pay are shown in the app.</div>
        <div className="space-y-2">{acknowledgements.map(([key,label])=><label key={key} className="flex items-start gap-3 rounded-xl border border-ink-200 p-3 text-sm leading-5 text-ink-700"><input required type="checkbox" checked={form[key]} onChange={e=>set(key,e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-brand-600"/>{label}</label>)}</div>
        <p className="text-xs leading-5 text-ink-500">By submitting, you agree to the <Link to="/terms" className="font-bold text-brand-700 underline">Terms of Service</Link> and acknowledge the <Link to="/privacy" className="font-bold text-brand-700 underline">Privacy Policy</Link>.</p>
        <div className="rounded-xl bg-warning-50 p-3 text-xs leading-5 text-warning-800"><ShieldCheck className="mr-1 inline size-4"/>Submitting does not activate you for dispatch. An owner must review and approve your application, documents, dispatch connection, and all compliance requirements.</div>
        {error&&<Error text={error}/>}<div className="flex gap-2"><Button type="button" variant="secondary" onClick={()=>setStep(2)}><ChevronLeft className="size-4"/> Back</Button><Button className="flex-1" type="submit" loading={busy}><Check className="size-4"/> Submit application</Button></div></form>}
    </Card><p className="mt-5 text-center text-sm text-ink-500">Already applied? <Link to="/login" className="font-bold text-brand-700">Sign in</Link></p>
  </div></main>;
}
function Header({n,title,body}:{n:string,title:string,body:string}) { return <div className="mb-5"><div className="mb-2 flex items-center gap-2"><span className="grid size-8 place-items-center rounded-lg bg-brand-100 font-bold text-brand-700">{n}</span><Truck className="size-5 text-brand-600"/></div><h2 className="text-xl font-extrabold text-ink-900">{title}</h2><p className="mt-1 text-sm text-ink-500">{body}</p></div> }
function Field({label,children,cls=""}:{label:string,children:React.ReactNode,cls?:string}) { return <label className={`block text-sm font-bold text-ink-700 ${cls}`}>{label}{children}</label> }
function Error({text}:{text:string}) { return <p role="alert" className="rounded-xl bg-danger-50 p-3 text-sm text-danger-700">{text}</p> }
