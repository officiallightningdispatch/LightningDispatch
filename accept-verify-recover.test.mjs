// Hermetic source-contract regression suite for post-accept verification recovery.
// Reads production source only: no database, network, server, or dev process.
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const [dispatcher, pushCore, backgroundSync, banners] = await Promise.all([
  readFile(new URL("./src/data/ai-dispatcher.ts", import.meta.url), "utf8"),
  readFile(new URL("./src/data/push-core.ts", import.meta.url), "utf8"),
  readFile(new URL("./src/data/background-sync.ts", import.meta.url), "utf8"),
  readFile(new URL("./src/components/notify-banners.tsx", import.meta.url), "utf8"),
]);
const checks = [];
const check = (name, fn) => { fn(); checks.push(name); };

check("1: bounded post-accept retry is conditional on a missing call", () => {
  const verify = dispatcher.slice(dispatcher.indexOf("export async function verifyDispatch"));
  assert.match(verify, /const delay = opts\.retryDelayMs \?\? 10000/);
  assert.match(verify, /const maxAttempts = Math\.max\(1, opts\.maxAttempts \?\? 6\)/);
  assert.match(verify, /for \(let n = 1; n < maxAttempts && !v\.found && v\.error === "call not found after accept"; n\+\+\)/);
  assert.match(verify, /v = await attempt\(\)/);
  assert.ok((verify.match(/await attempt\(\)/g) ?? []).length >= 2, "verification must not be one-shot");
});

check("2: accepted-call scan covers every status and uses only deterministic ties", () => {
  const finder = dispatcher.slice(dispatcher.indexOf("export async function findAcceptedCall"), dispatcher.indexOf("/** Authoritative pickup waypoint"));
  assert.match(finder, /for \(const statusId of \[0, 1, 2, 3, 4, 5, 6, 7, 8, 9\]\)/);
  assert.match(finder, /const byPo = list\.find\(\(c\) => String\(\(c as Record<string, unknown>\)\.purchaseOrderNumber/);
  assert.match(finder, /const byRequest = list\.find\(\(c\) => callCarriesRequestId\(c, wantRequestId\)\)/);
  assert.doesNotMatch(finder, /list\.sort\(|return \{ call: list\[/);
});

check("3: durable pending sweep re-verifies before reading the offer feed", () => {
  const engine = dispatcher.slice(dispatcher.indexOf("async function runAutoDispatchInternal"));
  const pending = engine.indexOf("decision='escalated_dispatch_pending'");
  const feed = engine.indexOf("/api/callRequests/");
  assert.ok(pending >= 0 && feed > pending, "pending sweep must precede offer feed");
  assert.match(engine, /decision='escalated_dispatch_pending'/);
  assert.match(engine, /await verifyDispatch\(fetchImpl, baseUrl, cookies, offer/);
  assert.match(engine, /decision='auto_accept_with_driver', escalated=FALSE/);
  assert.match(engine, /decision='escalated_expired'/);
  assert.match(engine, /Date\.parse\(offer\.expirationDateUtc\) < Date\.now\(\)/);
});

check("4: pending owner banner is wired with grounded offer context", () => {
  assert.match(backgroundSync, /recordDispatchPendingAlert/);
  assert.match(pushCore, /export async function recordDispatchPendingAlert/);
  assert.match(dispatcher, /notifyDispatchPending\(orgId, \{ callRequestId: offer\.callRequestId, purchaseOrderNumber: offer\.purchaseOrderNumber, driverId: dispatchDriverId, reason/);
  assert.match(pushCore, /payload\.callRequestId/);
  assert.match(pushCore, /payload\.purchaseOrderNumber/);
  assert.match(pushCore, /payload\.driverId/);
  assert.match(pushCore, /payload\.reason/);
  assert.match(banners, /ACCEPTED — DISPATCH UNVERIFIED/);
  // The banner must key off the DECISION kind — the API returns reason as
  // human text ("accept POST failed after retry..."), so a d.reason === kind
  // check could never fire. d.decision === kind matches the rejected-tow pattern.
  assert.match(banners, /d\.decision === "escalated_dispatch_pending"/);
  assert.doesNotMatch(banners, /d\.reason === "escalated_dispatch_pending"/);
  // reasonCopy is keyed by decision kind; the body lookup must use d.decision.
  assert.match(banners, /reasonCopy\[d\.decision \?\? ""\]/);
  assert.doesNotMatch(banners, /reasonCopy\[d\.reason \?\? ""\]/);
});

check("5: verified calls are upserted before best-effort follow-up", () => {
  assert.match(dispatcher, /async function upsertVerifiedDispatchJob/);
  assert.match(dispatcher, /ON CONFLICT \(org_id, towbook_job_id\) DO UPDATE/);
  const verified = dispatcher.indexOf("if (verification.call) {\n            try { await upsertVerifiedDispatchJob");
  const pending = dispatcher.indexOf("if (verification.call) { try { await upsertVerifiedDispatchJob");
  assert.ok(verified >= 0, "initial verified-dispatch path must upsert");
  assert.ok(pending >= 0, "pending-recovery path must upsert");
  assert.ok(dispatcher.indexOf("fireDispatchAssignmentPush", verified) > verified, "verified upsert precedes push follow-up");
  assert.ok(dispatcher.indexOf("syncForOrg(orgId, 'sync:auto-accept-pending'", pending) > pending, "recovery upsert precedes best-effort sync");
});

console.log(`ACCEPT-VERIFY-RECOVER HERMETIC CHECKS PASSED (${checks.length})`);
for (const name of checks) console.log(`  PASS  ${name}`);
