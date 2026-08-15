// Hermetic license two-capture compliance transitions: no DB/network.
import { deriveComplianceSnapshot } from "./src/data/contractor-admin-core.ts";
const checks=[]; const check=(name, ok)=>{checks.push(name); if(!ok) throw Error(`FAIL: ${name}`)};
const front=(status="verified")=>({docTypeName:"Driver's License — Front", requiresFacialVerification:true, storedStatus:status, hasSelfie:true});
const back=(status="verified")=>({docTypeName:"Driver's License — Back", storedStatus:status});
const snap=(rows)=>deriveComplianceSnapshot(rows);
check("missing front incomplete", snap([front(null),back()]).approved===1 && snap([front(null),back()]).neededNames.includes("Driver's License — Front"));
check("missing back incomplete", snap([front(),back(null)]).approved===1 && snap([front(),back(null)]).neededNames.includes("Driver's License — Back"));
check("both present complete", snap([front(),back()]).approved===2 && snap([front(),back()]).neededCount===0);
check("front replacement leaves back approved", snap([front("uploaded"),back()]).approved===1 && snap([front("uploaded"),back()]).pendingNames.includes("Driver's License — Front"));
check("back replacement leaves front approved", snap([front(),back("uploaded")]).approved===1 && snap([front(),back("uploaded")]).pendingNames.includes("Driver's License — Back"));
check("front rejected independently", snap([front("rejected"),back()]).approved===1 && snap([front("rejected"),back()]).neededNames.includes("Driver's License — Front"));
check("back rejected independently", snap([front(),back("rejected")]).approved===1 && snap([front(),back("rejected")]).neededNames.includes("Driver's License — Back"));
check("GO blocked until both approved", snap([front(),back("uploaded")]).approved < snap([front(),back("uploaded")]).required);
check("GO opens once both approved", snap([front(),back()]).approved===snap([front(),back()]).required);
console.log(`driver-license-state.test.mjs: ${checks.length}/${checks.length} assertions passed`);
