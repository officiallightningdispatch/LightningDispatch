import { createServerFn } from "@tanstack/react-start";
import type { TirePlugRow } from "./tire-plug-core";
export type { TirePlugRow } from "./tire-plug-core";
const pass=(x:unknown)=>x;
async function user(){const {currentUser}=await import("./auth-server"); return currentUser();}
export const offerTirePlug=createServerFn({method:"POST"}).validator(pass).handler(async({data})=>{const u=await user();if(!u)return {ok:false as const,message:"Sign in required."};return (await import("./tire-plug-core")).offerTirePlugCore(u,data);});
export const approveTirePlug=createServerFn({method:"POST"}).validator(pass).handler(async({data})=>{const u=await user();if(!u)return {ok:false as const,message:"Sign in required."};return (await import("./tire-plug-core")).approveTirePlugCore(u,data);});
export const declineTirePlug=createServerFn({method:"POST"}).validator(pass).handler(async({data})=>{const u=await user();if(!u)return {ok:false as const,message:"Sign in required."};return (await import("./tire-plug-core")).declineTirePlugCore(u,data);});
export const chargeTirePlug=createServerFn({method:"POST"}).validator(pass).handler(async({data})=>{const u=await user();if(!u)return {ok:false as const,message:"Sign in required."};return (await import("./tire-plug-core")).chargeTirePlugCore(u,data);});
export const listTirePlugs=createServerFn({method:"GET"}).handler(async():Promise<TirePlugRow[]>=>{const u=await user();if(!u||!['owner','admin'].includes(u.role))return [];return (await import("./tire-plug-core")).listTirePlugsCore(u.orgId);});
export const tirePlugRate=createServerFn({method:"GET"}).handler(async():Promise<number>=>{const u=await user();if(!u)return 4500;return (await import("./tire-plug-core")).tirePlugRateCore(u.orgId);});
export const setTirePlugRate=createServerFn({method:"POST"}).validator(pass).handler(async({data})=>{const u=await user();if(!u||!['owner','admin'].includes(u.role))return {ok:false as const,message:"Owner access required."};return (await import("./tire-plug-core")).setTirePlugRateCore(u.orgId,data);});
