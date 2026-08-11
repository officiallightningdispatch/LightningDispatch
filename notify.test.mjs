// Hermetic unit tests for the pure notification-detection module (backlog #1,
// owner-directed 2026-08-11). No DOM, no DB, no network:
//   bun notify.test.mjs
// Covers: no-fire on first load, dedupe (batch + across polls), bounded
// seen-set (drops oldest), the escalated_ decision match rule, and tolerant
// parse of the persisted seen-set.
import {
  ESCALATION_PREFIX,
  SEEN_CAP,
  diffEscalatedDecisionIds,
  diffNewJobIds,
  isEscalationDecision,
  mergeSeen,
  parseSeen,
} from "./src/lib/notify.ts";

const checks = [];
const check = (name, cond, extra = "") => { checks.push([name, Boolean(cond), extra]); if (!cond) throw new Error(`FAIL: ${name} ${extra}`); };

const J = (id, extra = {}) => ({ id, ...extra });
const D = (id, decision, reason = "") => ({ id, decision, reason });

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
    D("dec-1", "escalated_expired", "Towbook session expired"),
    D("dec-2", "escalated_out_of_zone", "Outside the service zone"),
    D("dec-3", "auto_accept_with_driver", "Auto-accepted"),
  ];
  const seen = ["dec-1"]; // dec-1 already surfaced → must not fire again
  const fired = diffEscalatedDecisionIds(seen, decisions);
  check("escalations fire once per decision id", fired.length === 1 && fired[0].id === "dec-2");
  check("fired escalation keeps its reason text", fired[0].reason === "Outside the service zone");
}
{
  const fired = diffEscalatedDecisionIds([], [D("a", "auto_accept_no_driver"), D("b", "accepted_manual")]);
  check("non-escalated decisions never fire even when unseen", fired.length === 0);
}

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
