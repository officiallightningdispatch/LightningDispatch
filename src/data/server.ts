import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { contractors as seedContractors, jobs as seedJobs } from "./seed";
import { currentUser } from "./auth-server";
import type { ContractorStatus, JobStatus } from "./seed";
export type DispatchData={contractors:typeof seedContractors;jobs:typeof seedJobs};
export type CommandErrorCode="validation"|"not_found"|"invalid_state"|"conflict"|"offline_contractor"|"database_unavailable"|"unauthorized";
export type CommandError={code:CommandErrorCode;message:string;field?:string}; export type CommandResult={ok:true;data:DispatchData}|{ok:false;error:CommandError};
const configured=()=>Boolean(process.env.DATABASE_URL); const passthrough=(x:unknown)=>x; const id=z.string().min(1).max(64);
function invalid(input:unknown,s:z.ZodTypeAny):CommandResult|null{const p=s.safeParse(input);if(p.success)return null;const i=p.error.issues[0];return{ok:false,error:{code:"validation",message:i.message,field:i.path[0]?String(i.path[0]):undefined}}}
const unavailable=(message="Database command unavailable."):CommandResult=>({ok:false,error:{code:"database_unavailable",message}});
export const getDispatchData=createServerFn({method:"GET"}).handler(async()=>{if(!configured())return{mode:"demo" as const,data:{contractors:seedContractors,jobs:seedJobs}};const u=await currentUser();if(!u)return{mode:"database" as const,data:{contractors:[],jobs:[]},error:{code:"unauthorized" as const,message:"Sign in required."}};return{mode:"database" as const,data:{contractors:[],jobs:[]}}});
export const assignJob=createServerFn({method:"POST"}).validator(passthrough).handler(async({data})=>{const e=invalid(data,z.object({jobId:id,contractorId:id}).strict());if(e)return e;if(!configured())return unavailable("Database mode is not active — assign works in the live demo only.");return unavailable()});
export const advanceJob=createServerFn({method:"POST"}).validator(passthrough).handler(async({data})=>{const e=invalid(data,z.object({jobId:id}).strict());if(e)return e;if(!configured())return unavailable("Database mode is not active — advancing works in the live demo only.");return unavailable()});
export const declineJob=createServerFn({method:"POST"}).validator(passthrough).handler(async({data})=>{const e=invalid(data,z.object({jobId:id,contractorId:id}).strict());if(e)return e;if(!configured())return unavailable("Database mode is not active — declining works in the live demo only.");return unavailable()});
export const setContractorStatus=createServerFn({method:"POST"}).validator(passthrough).handler(async({data})=>{const e=invalid(data,z.object({contractorId:id,status:z.enum(["online","offline"])}).strict());if(e)return e;if(!configured())return unavailable("Database mode is not active — status changes work in the live demo only.");return unavailable()});
export const resetDemo=createServerFn({method:"POST"}).validator(passthrough).handler(async()=>unavailable("Reset demo data is disabled in database mode."));
