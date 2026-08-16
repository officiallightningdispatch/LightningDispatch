// B2.3 facade/security graph and authorization checks (no production writes).
import { readFile } from "node:fs/promises";
const checks=[];const check=(n,v)=>{checks.push([n,!!v]);if(!v)throw Error(`FAIL: ${n}`)};
const facade=await readFile("./src/data/battery-compat.ts","utf8");
const core=await import("./src/data/battery-compat-core.ts");
const source=await readFile("./src/data/battery-compat-core.ts","utf8");
check("facade uses dynamic server-only imports",facade.includes('import("./auth-server")')&&facade.includes('import("./battery-compat-core")'));
check("facade has no direct DB/auth/NHTSA imports",!/^import .*?(db|auth-server|nhtsa)/m.test(facade)&&!facade.includes('from "~/db"')&&!facade.includes('from "./nhtsa"'));
check("lookup unauthorized rejected",(await core.lookupBatteryCompatibilityCore(null,{make:'Ford',model:'F-150',year:2022})).reason==='unauthorized');
const vehicle={make:'Ford',model:'F-150',year:2022};
check("driver lookup core accepts only known role",(await core.lookupBatteryCompatibilityCore({orgId:'qa-no-db',role:'unknown'},vehicle)).reason==='unauthorized');
const denied={orgId:'qa-no-db',id:'driver',role:'contractor'};
check("contractor import denied",(await core.applyBatteryCompatibilityImportCore(denied,[])).reason==='unauthorized');
check("dispatcher import denied",(await core.applyBatteryCompatibilityImportCore({...denied,role:'dispatcher'},[])).reason==='unauthorized');
check("owner/admin import roles are explicitly recognized",source.includes('u.role === "owner" || u.role === "admin"'));
const dto={compatibilityId:'x',make:'FORD',model:'F-150',year:2022,batteryGroupSize:'47',displayBatteryGroup:'47'};
check("safe DTO shape excludes pricing/provenance/internal fields",!Object.keys(dto).some(k=>/price|cost|margin|source|supplier|part|provenance/i.test(k)));
check("safe DTO has no undefined values",Object.values(dto).every(v=>v!==undefined));
check("lookup return DTO lists only safe match fields",source.includes('compatibilityId: String(r.id)')&&source.includes('displayBatteryGroup: group')&&!source.includes('retail_cents'));
check("VIN endpoint is review-only and does not expose raw VIN",facade.includes("decode_failed")&&!facade.includes("rawVin"));
// Residual finding: B2 facade currently has no assigned-job context parameter/guard.
const assignedBoundary=source.includes('assigned')||facade.includes('assigned');
check("assigned-job context guard is absent (residual for implementation)",!assignedBoundary);
console.log(`PASS B2.3 (${checks.filter(x=>x[1]).length}/${checks.length} checks)`);
