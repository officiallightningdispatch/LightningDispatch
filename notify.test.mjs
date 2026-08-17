// Hermetic unit tests for the pure notification-detection module (backlog #1,
// owner-directed 2026-08-11). No DOM, no DB, no network:
//   bun notify.test.mjs
// Covers: no-fire on first load, dedupe (batch + across polls), bounded
// seen-set (drops oldest), the escalated_ decision match rule, and tolerant
// parse of the persisted seen-set.
import {
  ESCALATION_PREFIX,
  SEEN_CAP,
  diffCancelledJobIds,
  diffEscalatedDecisionIds,
  diffNewCashoutIds,
  diffNewJobIds,
  isEscalationDecision,
  mergeSeen,
  mergeSeenPreserving,
  parseSeen,
  formatCountdown,
  reconcileEscalatedBanner,
} from "./src/lib/notify.ts";

const checks = [];
const check = (name, cond, extra = "") => { checks.push([name, Boolean(cond), extra]); if (!cond) throw new Error(`FAIL: ${name} ${extra}`); };

const J = (id, extra = {}) => ({ id, ...extra });
const D = (id, decision, reason = decision) => ({ id, decision, reason });
const CO = (id, amountCents = 1200, extra = {}) => ({ id, amountCents, contractorName: "Driver", rail: "cash_app", ...extra });

/* --------------------------- no-fire on first load --------------------------- */
{
  const seen = ["job-a", "job-b", "job-c"];
  const incoming = [J("job-a"), J("job-b"), J("job-c")];
  check("first load: everything already seen → nothing fires", diffNewJobIds(seen, incoming).length === 0);
}
{
  // The caller's bootstrap pattern: seed seen with everything visible, then
  // the next poll with the same visible list fires nothing.
  const visible = [J("j1"), J("j2")];
  const seeded = mergeSeen([], visible.map((j) => j.id));
  check("bootstrap seed keeps all visible ids", seeded.length === 2 && seeded.includes("j1") && seeded.includes("j2"));
  check("post-bootstrap poll of the same list fires nothing", diffNewJobIds(seeded, visible).length === 0);
}

/* --------------------------- cash-out arrival detection --------------------------- */
{
  const added = diffNewCashoutIds(["cash-a"], [CO("cash-a"), CO("cash-b", 3450)]);
  check("cash-out new id fires with real payload", added.length === 1 && added[0].id === "cash-b" && added[0].amountCents === 3450);
}
{
  const added = diffNewCashoutIds([], [CO("cash-a"), CO("cash-a"), {}, { id: "" }]);
  check("cash-out ids dedupe within poll", added.length === 1 && added[0].id === "cash-a");
  check("paid cash-outs are excluded by pending input", diffNewCashoutIds([], []).length === 0);
}

/* --------------------------- new arrival detection --------------------------- */
{
  const seen = ["job-a"];
  const incoming = [J("job-a"), J("job-b", { customerName: "Nina" })];
  const added = diffNewJobIds(seen, incoming);
  check("a genuinely new job id fires", added.length === 1 && added[0].id === "job-b");
  check("the new job keeps its payload for the banner", added[0].customerName === "Nina");
}
{
  // Empty incoming / empty seen → no fires, no crashes.
  check("empty incoming → no fires", diffNewJobIds([], []).length === 0);
  check("null-ish rows are skipped", diffNewJobIds([], [null, undefined, {}, { id: "" }, { id: 42 }]).length === 0);
}

/* --------------------------- dedupe --------------------------- */
{
  const incoming = [J("job-a"), J("job-a"), J("job-b"), J("job-b"), J("job-c")];
  const added = diffNewJobIds([], incoming);
  check("batch dedupe: duplicate ids fire once", added.length === 3 && added.map((j) => j.id).join() === "job-a,job-b,job-c");
}
{
  // Fire once per id ACROSS polls: after the seen-set absorbs the ids, a
  // repeat of the same batch fires nothing.
  const batch = [J("x1"), J("x2")];
  const seen = mergeSeen([], ["x1", "x2"]);
  check("already-fired ids never re-fire", diffNewJobIds(seen, batch).length === 0);
}

/* --------------------------- bounded seen-set (drop oldest) --------------------------- */
{
  const many = Array.from({ length: SEEN_CAP }, (_, i) => `job-${i}`); // job-0 … job-199
  const seen = mergeSeen([], many);
  check("mergeSeen respects the cap", seen.length === SEEN_CAP);
  const next = mergeSeen(seen, ["job-200"]);
  check("beyond cap: newest kept", next.length === SEEN_CAP);
  check("beyond cap: oldest dropped first", !next.includes("job-0"));
  check("beyond cap: newest id present", next.includes("job-200"));
  check("beyond cap: order is oldest→newest", next[0] === "job-1" && next[next.length - 1] === "job-200");
}
{
  // Dedupe on merge: existing + repeated additions don't grow the set.
  const seen = mergeSeen(["a", "b"], ["b", "c"]);
  check("mergeSeen dedupes", seen.join() === "a,b,c");
  check("mergeSeen skips empty ids", mergeSeen(["a"], ["", "a", null]).join() === "a");
}

/* --------------------------- feed-preserving seen-set regression --------------------------- */
{
  const jobs = Array.from({ length: 250 }, (_, i) => J(`job-${i}`));
  let seen = mergeSeen([], jobs.slice(0, 200).map((j) => j.id));
  for (let tick = 0; tick < 20; tick++) {
    const added = diffNewJobIds(seen, jobs);
    seen = mergeSeenPreserving(seen, added.map((j) => j.id), jobs.map((j) => j.id));
    check(`long feed tick ${tick}: previously seen jobs do not re-fire`, tick === 0 ? added.length === 50 : added.length === 0);
  }
  check("preserving merge retains every current feed id", jobs.every((j) => seen.includes(j.id)));
  const archiveSeed = ["job:job-42", "cashout:cash-1", "escalation:dec-1"];
  const strip = (kind, id) => id.replace(new RegExp(`^${kind}:`), "");
  const seeded = archiveSeed.map((id) => strip(id.split(":")[0], id));
  check("archive job source id matches raw job id space", diffNewJobIds(seeded, [J("job-42")]).length === 0);
}

/* --------------------------- escalation match rule --------------------------- */
{
  check("escalated_expired matches", isEscalationDecision("escalated_expired") === true);
  check("escalated_contractor_push_failed matches", isEscalationDecision("escalated_contractor_push_failed") === true);
  check("auto_accept_with_driver does NOT match", isEscalationDecision("auto_accept_with_driver") === false);
  check("auto_accept_no_driver does NOT match", isEscalationDecision("auto_accept_no_driver") === false);
  check("empty decision does not match", isEscalationDecision("") === false);
  check("prefix constant is exposed for the UI", ESCALATION_PREFIX === "escalated_");
}
{
  const decisions = [
    D("dec-1", "escalated_expired", "escalated_expired"),
    D("dec-2", "escalated_missing_coords", "escalated_missing_coords"),
    D("dec-3", "auto_accept_with_driver", "Auto-accepted"),
  ];
  const seen = ["dec-1"]; // dec-1 already surfaced → must not fire again
  const fired = diffEscalatedDecisionIds(seen, decisions);
  check("escalations fire once per decision id", fired.length === 1 && fired[0].id === "dec-2");
  check("fired escalation keeps its reason text", fired[0].reason === "escalated_missing_coords");
}
{
  const fired = diffEscalatedDecisionIds([], [D("a", "auto_accept_no_driver"), D("b", "accepted_manual")]);
  check("non-escalated decisions never fire even when unseen", fired.length === 0);
}

{
  check("expired escalation is excluded", diffEscalatedDecisionIds([], [D("x", "escalated_expired", "escalated_expired")]).length === 0);
  check("unknown escalation is excluded", diffEscalatedDecisionIds([], [D("x", "escalated_out_of_zone", "escalated_out_of_zone")]).length === 0);
  check("countdown formats mm:ss", formatCountdown(181) === "03:01");
  check("countdown clamps zero", formatCountdown(-4) === "00:00");
  check("unknown countdown is null", formatCountdown(null) === null);
}

/* --------------------------- backend evidence transitions --------------------------- */
{
  check("claimed transition uses refreshed backend evidence", reconcileEscalatedBanner(D("c", "escalated_missing_coords", "escalated_missing_coords"), Date.now()) === null);
  check("claimed transition resolves", reconcileEscalatedBanner({ ...D("c", "escalated_missing_coords"), offerStatus: "claimed" }) === "claimed");
  check("expired transition requires authoritative expiry plus evidence", reconcileEscalatedBanner({ ...D("e", "escalated_missing_coords"), offerStatus: "expired", offerExpiresAt: new Date(Date.now() - 1000).toISOString() }) === "expired");
  check("expired evidence before deadline does not transition", reconcileEscalatedBanner({ ...D("e2", "escalated_missing_coords"), offerStatus: "expired", offerExpiresAt: new Date(Date.now() + 60000).toISOString() }) === null);
  check("status unknown never transitions", reconcileEscalatedBanner({ ...D("u", "escalated_missing_coords"), offerExpiresAt: new Date(Date.now() - 1000).toISOString() }) === null);
  check("dismissal is local-only (pure reconciliation does not mutate decision)", (() => { const d = { ...D("d", "escalated_missing_coords"), offerStatus: "claimed" }; reconcileEscalatedBanner(d); return d.offerStatus === "claimed" && d.decision === "escalated_missing_coords"; })());
}
/* --------------------------- cancelled-job detection --------------------------- */
// The driver queue diff (owner-directed 2026-08-12, "like Uber — notify the
// driver and move it to history"): a call that was LIVE (offered → towing) in
// the previous poll and is now cancelled (255) — or gone from the queue — is
// the cancellation signal. The PREVIOUS row comes back so the banner can carry
// pickup/vehicle context.
{
  const live = (id, extra = {}) => ({ id, statusId: 2, serviceName: "Jump Start", pickupAddress: "14 Elm St", zip: "06606", ...extra });
  const next = [live("job-a"), live("job-b")];
  check("stable live queue → no cancellations", diffCancelledJobIds(next, next).length === 0);
}
{
  const prev = [C("1", { statusId: 2, serviceName: "Jump Start", pickupAddress: "14 Elm St", zip: "06606" }), C("2", { statusId: 3, serviceName: "Tow", vehicle: "Honda" })];
  const next = [C("1", { statusId: 255 }), C("2", { statusId: 5 })];
  const fired = diffCancelledJobIds(prev, next);
  check("live→255 fires once with context", fired.length === 1 && fired[0].id === "1" && fired[0].serviceName === "Jump Start" && fired[0].pickupAddress === "14 Elm St" && fired[0].zip === "06606", JSON.stringify(fired));
  check("live→completed (5) never fires", fired.every((c) => c.id !== "2"));
}
{
  // A live call that VANISHED from the queue counts as cancelled (Towbook
  // removes voided calls); a completed call that vanished does not.
  const prev = [C("vanish", { statusId: 2, serviceName: "Lockout" }), C("done", { statusId: 5 })];
  const fired = diffCancelledJobIds(prev, [C("done", { statusId: 5 })]);
  check("live→gone fires", fired.length === 1 && fired[0].id === "vanish" && fired[0].serviceName === "Lockout", JSON.stringify(fired));
}
{
  // Already-cancelled (255) or already-finished calls in the PREVIOUS snapshot
  // never fire; first-load (prev === first snapshot) fires nothing.
  const prev = [C("x", { statusId: 255 }), C("y", { statusId: 5 }), C("z", { statusId: 2 })];
  const next = [C("x", { statusId: 255 }), C("y", { statusId: 5 }), C("z", { statusId: 2 })];
  check("first snapshot (prev===next) → nothing fires", diffCancelledJobIds(prev, next).length === 0);
}
{
  // Offers (statusId 1) count as live — an offered job cancelled fires too.
  const prev = [C("off", { statusId: 1, serviceName: "Tire Change" })];
  const fired = diffCancelledJobIds(prev, [C("off", { statusId: 255 })]);
  check("offered→255 fires", fired.length === 1 && fired[0].id === "off");
}
{
  // Batch dedupe + malformed rows are tolerated.
  const prev = [C("a", { statusId: 2 }), C("a", { statusId: 2 }), C("b", { statusId: 2 })];
  const fired = diffCancelledJobIds(prev, [C("a", { statusId: 255 }), C("b", { statusId: 255 })]);
  check("batch dedupe: one per id", fired.length === 2 && fired.map((c) => c.id).join() === "a,b");
  check("null-ish prev rows skipped", diffCancelledJobIds([null, undefined, {}, { id: "" }, { id: 42, statusId: 2 }], []).length === 0);
  check("null/empty inputs → empty", diffCancelledJobIds(null, []).length === 0 && diffCancelledJobIds([], null).length === 0);
}

function C(id, extra = {}) { return { id, ...extra }; }

/* --------------------------- parseSeen (persisted set) --------------------------- */
{
  check("parses a JSON array", parseSeen('["a","b"]').join() === "a,b");
  check("garbage → empty", parseSeen("not json").length === 0);
  check("null/undefined → empty", parseSeen(null).length === 0 && parseSeen(undefined).length === 0);
  check("non-array JSON → empty", parseSeen('{"a":1}').length === 0);
  check("filters non-strings", parseSeen('[1,"a",null]').join() === "a");
}

/* --------------------------- summary --------------------------- */
const failed = checks.filter(([, ok]) => !ok);
console.log(`notify.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }
