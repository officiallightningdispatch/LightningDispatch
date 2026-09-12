import { createFileRoute, Link } from "@tanstack/react-router";
import { Bell, CalendarClock, CheckCircle2, ChevronRight, Circle, FileCheck2, GraduationCap, ShieldCheck, UserRound, Wallet, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import { AppShell } from "~/components/app-shell";
import { Button, Card } from "~/components/ui";
import { getMyCompliance, getMyDocuments, type MyCompliance, type ContractorDocumentRow } from "~/data/contractor-admin";
import { getMyApplicationStatus, type ContractorApplicationRow } from "~/data/contractor-signup";

export const Route = createFileRoute("/driver/onboarding")({ component: Onboarding });

type PermissionState = "done" | "needed" | "unsupported";
function Onboarding() {
  const [application,setApplication]=useState<ContractorApplicationRow|null>(null);
  const [docs,setDocs]=useState<ContractorDocumentRow[]>([]);
  const [compliance,setCompliance]=useState<MyCompliance|null>(null);
  const [loading,setLoading]=useState(true);
  const [permissions,setPermissions]=useState<PermissionState>("needed");
  useEffect(()=>{ void Promise.all([getMyApplicationStatus(),getMyDocuments(),getMyCompliance()]).then(([a,d,c])=>{if(a.ok)setApplication(a.data);if(d.ok)setDocs(d.data);if(c.ok)setCompliance(c.data);}).finally(()=>setLoading(false)); },[]);
  const askPermissions=async()=>{
    let supported=false, notificationsOk=("Notification" in window && Notification.permission==="granted"), locationOk=false;
    if("Notification" in window){supported=true;notificationsOk=(await Notification.requestPermission())==="granted";}
    if(navigator.geolocation){supported=true;locationOk=await new Promise<boolean>(r=>navigator.geolocation.getCurrentPosition(()=>r(true),()=>r(false),{timeout:10000}));}
    setPermissions(!supported?"unsupported":notificationsOk&&locationOk?"done":"needed");
  };
  const approvedDocs=docs.filter(d=>d.status==="verified").length;
  const status=application?.status==="activated"?"Approved":application?.status==="waitlisted"?"Waitlisted":"Under review";
  const statusCls=status==="Approved"?"bg-success-50 text-success-700":status==="Waitlisted"?"bg-accent-100 text-accent-800":"bg-info-50 text-info-700";
  const complete=[Boolean(application?.agreementsAcceptedAt),compliance!=null&&compliance.required>0&&compliance.approved>=compliance.required,permissions==="done"].filter(Boolean).length;
  const percent=Math.round((complete/3)*100);
  const license=docs.find(d=>/driver.?s? license/i.test(d.docTypeName));
  const items=[
    {title:"Application profile",detail:application?`${application.serviceArea??"Service area pending"} · ${application.experienceYears??0} years experience`:"Application details",to:"/driver/onboarding",done:Boolean(application?.agreementsAcceptedAt),icon:UserRound},
    {title:"Required documents",detail:compliance?`${approvedDocs}/${compliance.required} approved by owner`:"Upload and track protected documents",to:"/driver/documents",done:Boolean(compliance&&compliance.required>0&&compliance.approved>=compliance.required),icon:FileCheck2},
    {title:"Driver’s-license front and back",detail:license?`Current status: ${license.status}`:"Upload both sides in protected documents",to:"/driver/documents",done:license?.status==="verified",icon:FileCheck2},
    {title:"Live selfie / facial verification",detail:"Capture a live selfie with your license submission",to:"/driver/documents",done:license?.status==="verified",icon:ShieldCheck},
    {title:"Insurance information",detail:"Upload current insurance and expiration details",to:"/driver/documents",done:docs.some(d=>/insurance/i.test(d.docTypeName)&&d.status==="verified"),icon:ShieldCheck},
    {title:"W-9 and required forms",detail:"Complete existing secure forms; sensitive values are protected",to:"/driver/documents",done:docs.filter(d=>/w-?9|required form/i.test(d.docTypeName)).every(d=>d.status==="verified")&&docs.some(d=>/w-?9/i.test(d.docTypeName)),icon:FileCheck2},
    {title:"Notifications and location",detail:permissions==="done"?"Permissions enabled":"Required for offers and accurate dispatch location",action:true,done:permissions==="done",icon:Bell},
    {title:"Selected services and equipment",detail:application?.tools.length?application.tools.join(", "):"Choose services you are equipped to perform",to:"/driver/services",done:Boolean(application?.tools.length),icon:Wrench},
    {title:"Availability schedule",detail:"Set the days and hours you want to work",to:"/driver/schedule",done:false,icon:CalendarClock},
    {title:"Payout setup",detail:"Connect and verify how you get paid",to:"/driver/payout",done:false,icon:Wallet},
    {title:"Lightning Academy",detail:"Complete required training lessons",to:"/driver/academy",done:false,icon:GraduationCap},
  ];
  return <AppShell portal="driver" title="Onboarding" description="Finish your checklist and track owner approval."><div className="mx-auto max-w-2xl space-y-4">
    <Card className="overflow-hidden p-5"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wider text-ink-400">Application status</p><h1 className="mt-1 text-xl font-extrabold text-ink-900">{loading?"Loading…":status}</h1></div><span className={`rounded-full px-3 py-1 text-xs font-bold ${statusCls}`}>{status}</span></div><div className="mt-5 flex items-center justify-between text-xs font-semibold text-ink-500"><span>Onboarding progress</span><span>{percent}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-ink-100"><div className="h-full rounded-full bg-brand-600 transition-all" style={{width:`${percent}%`}}/></div><p className="mt-3 text-xs leading-5 text-ink-500">Application approval is not activation. You cannot receive dispatches until an owner activates you and all document-verification, secure dispatch-connection, and compliance requirements pass.</p></Card>
    <h2 className="px-1 text-sm font-extrabold text-ink-900">Onboarding checklist</h2>
    <div className="space-y-2">{items.map((item,i)=>{const Icon=item.icon;const body=<><span className={`grid size-10 shrink-0 place-items-center rounded-xl ${item.done?"bg-success-50 text-success-700":"bg-ink-100 text-ink-500"}`}>{item.done?<CheckCircle2 className="size-5"/>:<Icon className="size-5"/>}</span><span className="min-w-0 flex-1"><span className="block text-sm font-bold text-ink-800">{item.title}</span><span className="block text-xs leading-5 text-ink-500">{item.detail}</span></span>{item.action?<Button type="button" size="sm" variant="secondary" onClick={()=>void askPermissions()}>Enable</Button>:<ChevronRight className="size-4 shrink-0 text-ink-400"/>}</>;return item.action?<Card key={i} className="flex items-center gap-3 p-4">{body}</Card>:<Link key={i} to={item.to as any} className="flex items-center gap-3 rounded-2xl bg-surface p-4 ring-1 ring-ink-100 hover:bg-hover">{body}</Link>})}</div>
    <Card className="flex items-start gap-3 border border-warning-100 bg-warning-50 p-4"><Circle className="mt-0.5 size-4 shrink-0 text-warning-700"/><div><p className="text-sm font-bold text-warning-900">Owner approval and activation</p><p className="mt-1 text-xs leading-5 text-warning-800">{status}. Dispatch eligibility remains off until the owner completes activation and every compliance check passes.</p></div></Card>
  </div></AppShell>;
}
