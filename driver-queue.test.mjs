import assert from "node:assert/strict";
import { orderDriverQueue, applyDriverQueueEvent, normalizeDutyType } from "./src/lib/driver-queue-core.ts";

const call = (id, lat, statusId = 2, extra = {}) => ({ id, callNumber: id, statusId, serviceName: "Roadside", pickupAddress: "Pickup", zip: "", vehicle: "", vehicleYear: null, vehicleMake: null, vehicleModel: null, vehicleDutySignal: null, arrivalETA: null, purchaseOrderNumber: null, customerName: "", customerPhone: "", pickupLat: lat, pickupLng: -72, updatedAtIso: null, arrivedAtIso: null, goalSeconds: null, serviceKey: null, ...extra });
const loc = { latitude: 41, longitude: -72 };
let q = orderDriverQueue([call("greenwich", 41.2)], loc); assert.equal(q.length, 1); assert.equal(q[0].id, "greenwich");
q = orderDriverQueue([call("greenwich", 41.2), call("norwalk", 41.05)], loc); assert.deepEqual(q.map(x => x.id), ["norwalk", "greenwich"]);
q = applyDriverQueueEvent([], { type: "assigned", call: call("greenwich", 41.2) }); q = applyDriverQueueEvent(q, { type: "assigned", call: call("norwalk", 41.05) }); assert.equal(q.length, 2);
q = applyDriverQueueEvent(q, { type: "completed", call: call("norwalk", 41.05, 5) }); assert.deepEqual(q.map(x => x.id), ["greenwich"]);
q = applyDriverQueueEvent(q, { type: "cancelled", call: call("greenwich", 41.2, 255) }); assert.equal(q.length, 0);
const vehicle = call("v", 41, 2, { vehicleYear: "2022", vehicleMake: "Ford", vehicleModel: "Transit", vehicleDutySignal: "medium class 4" }); assert.equal(vehicle.vehicleYear, "2022"); assert.equal(normalizeDutyType(vehicle.vehicleDutySignal), "Medium Duty");
assert.equal(normalizeDutyType(null), null); assert.equal(normalizeDutyType("unknown"), null);
const tied = orderDriverQueue([call("b", 41.1), call("a", 41.1)], loc); assert.deepEqual(tied.map(x => x.id), ["a", "b"]);
console.log("driver queue: 8/8");
