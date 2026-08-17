import { createServerFn } from "@tanstack/react-start";
import type { FuelState } from "./fuel-payment-core";
const passthrough=(x:unknown)=>x;
export const getFuelFeeState=createServerFn({method:"POST"}).validator(passthrough).handler(async({data}):Promise<FuelState>=>{const c=await import("./fuel-payment-core");return c.fuelFeeHandler("state",data) as Promise<FuelState>});
export const chargeFuelFee=createServerFn({method:"POST"}).validator(passthrough).handler(async({data})=>{const c=await import("./fuel-payment-core");return c.fuelFeeHandler("charge",data)});
export const skipFuelFee=createServerFn({method:"POST"}).validator(passthrough).handler(async({data})=>{const c=await import("./fuel-payment-core");return c.fuelFeeHandler("skip",data)});
