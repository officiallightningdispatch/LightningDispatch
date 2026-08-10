import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { authStatus, type Role } from "~/data/auth";

export function PortalGate({children,roles}:{children:ReactNode;roles:Role[]}) {
  const nav=useNavigate(); const loc=useLocation();
  useEffect(()=>{
    // A failed auth check is an infrastructure error, not proof the user is
    // signed out. Never turn a transient server-function failure into a login loop.
    void authStatus().then(s=>{
      if(s.mode!=="demo"&&!s.user) void nav({to:"/login",search:{next:loc.pathname} as any,replace:true});
      else if(s.mode!=="demo"&&s.user&&!roles.includes(s.user.role)) void nav({to:"/403",replace:true});
    }).catch(()=>{ /* retain the portal; allow a later check/retry */ });
  },[nav,loc.pathname,roles]);
  return <>{children}</>;
}
export const DriverGate=({children}:{children:ReactNode})=><PortalGate roles={["contractor"]}>{children}</PortalGate>;
export const OpsGate=({children}:{children:ReactNode})=><PortalGate roles={["dispatcher","admin"]}>{children}</PortalGate>;
export const OwnerGate=({children}:{children:ReactNode})=><PortalGate roles={["owner","admin"]}>{children}</PortalGate>;
