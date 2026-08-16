import {createServerFn} from "@tanstack/react-start"; const pass=(x:unknown)=>x;
async function user(){const {currentUser}=await import("./auth-server");return currentUser()}
export const listBatteryProducts=createServerFn({method:"GET"}).handler(async()=>{const u=await user();if(!u)return [];return (await import("./battery-pricebook-core")).listBatteryProductsCore(u.orgId)});
export const upsertBatteryProduct=createServerFn({method:"POST"}).validator(pass).handler(async({data})=>{const u=await user();if(!u||!["owner","admin"].includes(u.role))return {ok:false as const,message:"Owner access required."};return (await import("./battery-pricebook-core")).upsertBatteryProductCore({orgId:u.orgId,id:u.id,role:u.role},data)});
