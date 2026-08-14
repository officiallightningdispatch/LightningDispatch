import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
const pass=(x:unknown)=>x;
async function actor(){const {currentUser}=await import('./auth-server');const u=await currentUser();return u?{orgId:u.orgId,id:u.id,role:u.role}:null;}
export const driverSelectZone=createServerFn({method:'POST'}).validator(pass).handler(async({data})=>{const v=z.object({zoneId:z.string().min(1)}).safeParse(data);const a=await actor();if(!v.success||!a)return {ok:false as const,message:'Sign in as a driver first.'};return (await import('./zones-core')).selectZoneCore(a,v.data.zoneId);});
export const getZonesWithBusyness=createServerFn({method:'GET'}).handler(async()=>{const a=await actor();if(!a)return [];return (await import('./zones-core')).getZonesCore(a);});
export const ownerSetDriverZone=createServerFn({method:'POST'}).validator(pass).handler(async({data})=>{const v=z.object({userId:z.string(),zoneId:z.string().nullable(),day:z.string().optional()}).safeParse(data);const a=await actor();if(!v.success||!a)return {ok:false as const,message:'Owner access required.'};return (await import('./zones-core')).ownerSetZoneCore(a,v.data.userId,v.data.zoneId,v.data.day);});
export const saveDispatchZone=createServerFn({method:'POST'}).validator(pass).handler(async({data})=>{const a=await actor();if(!a)return {ok:false as const,message:'Owner access required.'};return (await import('./zones-core')).upsertZoneCore(a,data);});
