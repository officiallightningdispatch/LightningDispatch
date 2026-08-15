import assert from "node:assert/strict";
import { checkReservedZoneEligibility, enforceReservedZoneEligibility } from "./src/data/reserved-zone-core.ts";
const zone=(x={})=>({id:"z",is_reserved:true,unlock_jobs_required:3,...x});
assert.equal(checkReservedZoneEligibility({zone:zone(),completedJobs:3}).ok,true);
assert.equal(checkReservedZoneEligibility({zone:zone(),completedJobs:2}).ok,false);
assert.equal(checkReservedZoneEligibility({zone:zone(),completedJobs:0}).ok,false);
assert.equal(checkReservedZoneEligibility({zone:zone({unlock_jobs_required:0}),completedJobs:0}).ok,true);
assert.equal(checkReservedZoneEligibility({zone:zone({is_reserved:false}),completedJobs:0}).ok,true);
assert.equal(checkReservedZoneEligibility({zone:null,completedJobs:3}).ok,true);
assert.equal(checkReservedZoneEligibility({zone:undefined,completedJobs:null}).ok,true);

// DB gate must also preserve ordinary jobs when containment returns no zone.
let queryCalls = 0;
const fakeQuery = async () => { queryCalls++; throw new Error("must not query completion data for a missing zone"); };
assert.equal((await enforceReservedZoneEligibility(fakeQuery, {orgId:"o", userId:"u", towbookDriverId:"15", zone:null})).ok, true);
assert.equal(queryCalls, 0);

// Completion attribution uses columns that exist in migration 18, never the
// unprovisioned assigned_driver_towbook_id guess from the original review.
let capturedSql = "";
const schemaSafeQuery = async (strings, ...values) => { capturedSql = strings.join(" "); return [{completed:"4"}]; };
assert.equal((await enforceReservedZoneEligibility(schemaSafeQuery, {orgId:"o", userId:"u", towbookDriverId:"15", zone:zone()})).ok, true);
assert.match(capturedSql, /assigned_driver_towbook_id/);
assert.match(capturedSql, /status='completed'/);
assert.match(capturedSql, /org_id=/);
assert.equal(checkReservedZoneEligibility({zone:zone(),completedJobs:3,actorRole:"contractor",explicitOwnerOverride:true}).ok,true);
assert.equal(checkReservedZoneEligibility({zone:zone(),completedJobs:0,actorRole:"owner",explicitOwnerOverride:true}).ok,true);
assert.equal(checkReservedZoneEligibility({zone:zone(),completedJobs:0,actorRole:"admin",explicitOwnerOverride:true}).ok,true);
assert.equal(checkReservedZoneEligibility({zone:zone(),completedJobs:0,actorRole:"manager",explicitOwnerOverride:true}).ok,false);
assert.equal(checkReservedZoneEligibility({zone:zone({unlock_jobs_required:null}),completedJobs:99}).ok,false);
console.log("ok - reserved-zone eligibility boundary, fail-closed, non-reserved, and override tests");
