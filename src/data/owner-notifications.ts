import { createServerFn } from "@tanstack/react-start";
import type { OwnerNotificationInput } from "./owner-notifications-core";
export type { OwnerNotification, OwnerNotificationInput } from "./owner-notifications-core";
const pass=(x:unknown)=>x;
async function getUser(){const {currentUser}=await import("./auth-server");return currentUser();}
export const listOwnerNotifications=createServerFn({method:"GET"}).validator(pass).handler(async({data}:{data?:{limit?:number;beforeId?:string}})=>{const u=await getUser();if(!u)return {ok:false as const,data:[]};const c=await import("./owner-notifications-core");return {ok:true as const,data:await c.listOwnerNotifications(u.orgId,data)};});
export const countUnreadOwnerNotifications=createServerFn({method:"GET"}).handler(async()=>{const u=await getUser();if(!u)return {ok:false as const,count:0};const c=await import("./owner-notifications-core");return {ok:true as const,count:await c.countUnreadOwnerNotifications(u.orgId)};});
export const markOwnerNotificationRead=createServerFn({method:"POST"}).validator(pass).handler(async({data}:{data:{id:string}})=>{const u=await getUser();if(!u)return {ok:false as const};const c=await import("./owner-notifications-core");return {ok:await c.markOwnerNotificationRead(u.orgId,data.id)};});
export const markAllOwnerNotificationsRead=createServerFn({method:"POST"}).handler(async()=>{const u=await getUser();if(!u)return {ok:false as const,count:0};const c=await import("./owner-notifications-core");return {ok:true as const,count:await c.markAllOwnerNotificationsRead(u.orgId)};});
export const recordOwnerNotification=createServerFn({method:"POST"}).validator(pass).handler(async({data}:{data:OwnerNotificationInput})=>{const u=await getUser();if(!u)return {ok:false as const};const c=await import("./owner-notifications-core");return {ok:true as const,data:await c.recordOwnerNotification(u.orgId,data)};});
