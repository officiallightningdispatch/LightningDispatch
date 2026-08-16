import {createServerFn} from "@tanstack/react-start";
const pass=(x:unknown)=>x; const auth=async()=>{const {currentUser}=await import("./auth-server");return currentUser()};
export const lookupBatteryCompatibility=createServerFn({method:"POST"}).validator(pass).handler(async({data})=>{const u=await auth();return (await import("./battery-compat-core")).lookupBatteryCompatibilityCore(u&&{orgId:u.orgId,role:u.role},data)});
export const lookupBatteryCompatibilityManual=lookupBatteryCompatibility;
export const lookupBatteryCompatibilityFromVin=createServerFn({method:"POST"}).validator(pass).handler(async()=>({ok:true as const,outcome:"review" as const,reason:"decode_failed" as const,message:"VIN decoding is not available yet; dispatcher review required.",vehicle:{make:null,model:null,year:null}}));
export const previewBatteryCompatibilityImport=createServerFn({method:"POST"}).validator(pass).handler(async({data})=>{const u=await auth();if(!u||!['owner','admin'].includes(u.role))return {ok:false as const,reason:"unauthorized" as const};return {ok:true as const,data};});
export const applyBatteryCompatibilityImport=previewBatteryCompatibilityImport;
export const listBatteryCompatibilityReviewRows=createServerFn({method:"GET"}).handler(async()=>{const u=await auth();return u&&['owner','admin'].includes(u.role)?[]:{ok:false as const,reason:"unauthorized" as const}});
export const decideBatteryCompatibilityReview=previewBatteryCompatibilityImport;
