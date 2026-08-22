// Hermetic pure tests for the GPS-coverage metrics fix (2026-08-22,
// GPS-reliability hardening): the job↔ping join no longer corrupts jobId from a
// null job_id. gpsCoveragePingedJobs credits an explicit job link
// authoritatively, and credits a job-LESS ping to a job only when EXACTLY ONE
// of that driver's jobs was active at the ping's captured instant — ambiguous
// pings are deliberately not credited, and a job is never double-credited.
// Pure (no DB). Run:
//   bun gps-coverage-metrics.test.mjs
import assert from "node:assert/strict";
import { gpsCoveragePingedJobs } from "./src/data/metrics-core.ts";

const MIN = 60_000;
const now = 1_800_000_000_000;

const driver = { id: "u1", name: "Driver", towbookDriverId: "tb1", payrateCents: null, online: true };
const other = { id: "u2", name: "Other", towbookDriverId: "tb2", payrateCents: null, online: true };

/** A created-in-period JobRow assigned to `assignedTowbookId` (default tb1). */
const job = (id, opts = {}) => ({
  id,
  towbookJobId: null,
  customerName: "",
  status: opts.status ?? "completed",
  createdAt: opts.createdAt ?? now - 3 * 3600_000,
  completedAt: opts.completedAt ?? now - 3600_000,
  arrivedAt: opts.arrivedAt ?? null,
  assignedAt: opts.assignedAt ?? now - 2 * 3600_000,
  assignedDriverTowbookId: opts.assignedDriverTowbookId ?? "tb1",
  assignedContractorId: opts.assignedContractorId ?? null,
  serviceType: "",
  durationSeconds: null,
});

const ping = (o = {}) => ({ jobId: o.jobId ?? null, driverId: o.driverId ?? "u1", capturedAt: o.capturedAt ?? now });

const asSet = (s) => [...s].sort();

let n = 0;
const ok = (cond, msg) => { if (!cond) throw new Error(`FAIL: ${msg}`); n += 1; };

/* Explicit job link is authoritative, even while another job overlaps. */
{
  const created = [job("j1"), job("j2")];
  const out = gpsCoveragePingedJobs([ping({ jobId: "j1" })], created, created, driver, now);
  ok(asSet(out).join(",") === "j1", `explicit link credits only j1: ${asSet(out)}`);
}

/* Null job ping, unambiguous single active job → credited. */
{
  const created = [job("j1")]; // active [now-2h, now-1h]
  const capturedAt = now - 1.5 * 3600_000;
  const out = gpsCoveragePingedJobs([ping({ capturedAt })], created, created, driver, now);
  ok(asSet(out).join(",") === "j1", `unambiguous null ping credits j1: ${asSet(out)}`);
}

/* Null job ping, two overlapping active jobs → NOT credited (ambiguous). */
{
  const created = [job("j1"), job("j2")]; // both active [now-2h, now-1h]
  const capturedAt = now - 1.5 * 3600_000;
  const out = gpsCoveragePingedJobs([ping({ capturedAt })], created, created, driver, now);
  ok(asSet(out).length === 0, `ambiguous null ping not credited: ${asSet(out)}`);
}

/* Null job ping outside every active window → NOT credited. */
{
  const created = [job("j1")]; // completed at now-1h
  const out = gpsCoveragePingedJobs([ping({ capturedAt: now })], created, created, driver, now); // after completion
  ok(asSet(out).length === 0, `post-completion null ping not credited: ${asSet(out)}`);
}

/* A job is never double-credited by multiple pings. */
{
  const created = [job("j1")];
  const pings = [
    ping({ capturedAt: now - 1.5 * 3600_000 }), // null, in-window
    ping({ capturedAt: now - 1.4 * 3600_000 }), // null, in-window
    ping({ jobId: "j1" }),                      // explicit
  ];
  const out = gpsCoveragePingedJobs(pings, created, created, driver, now);
  ok(asSet(out).join(",") === "j1", `j1 credited once: ${asSet(out)} (size ${out.size})`);
}

/* Another driver's ping is ignored. */
{
  const created = [job("j1")];
  const out = gpsCoveragePingedJobs([ping({ driverId: "u2", capturedAt: now - 1.5 * 3600_000 })], created, created, driver, now);
  ok(asSet(out).length === 0, `other driver's ping ignored: ${asSet(out)}`);
}

/* A job assigned to a different driver is not credited via a null ping. */
{
  const created = [job("j1", { assignedDriverTowbookId: "tb9" })]; // not this driver
  const out = gpsCoveragePingedJobs([ping({ capturedAt: now - 1.5 * 3600_000 })], created, created, driver, now);
  ok(asSet(out).length === 0, `foreign-assigned job not credited: ${asSet(out)}`);
}

/* Explicit link to a job outside the period is ignored (createdIds guard). */
{
  const created = [job("j1")];
  const out = gpsCoveragePingedJobs([ping({ jobId: "jX" })], created, created, driver, now);
  ok(asSet(out).length === 0, `explicit link to out-of-period job ignored: ${asSet(out)}`);
}

console.log(`gps-coverage-metrics.test.mjs: ${n} assertions passed`);
