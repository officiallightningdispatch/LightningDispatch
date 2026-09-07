// Hermetic coverage for the three owner-reported native-app defects
// (2026-09-06, TestFlight build): (1) login blocked behind a full-screen
// authStatus spinner; (2) iOS auto-zoom from sub-16px inputs; (3) the driver
// queue "load failed / unassigned" error loop.
// Source-level where behavior is UI-only (login render, CSS zoom rule) and
// direct for the pure logic (backoff cadence, driver-name attribution).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

/* ---------- (3) queue poll backoff + attribution (pure) ---------- */
const { nextQueuePollDelayMs, QUEUE_POLL_BASE_MS, QUEUE_POLL_BACKOFF_MAX_MS } = await import("./src/lib/driver-queue-core.ts");
check("backoff: zero failures → base interval", nextQueuePollDelayMs(0) === QUEUE_POLL_BASE_MS);
check("backoff: first failure doubles", nextQueuePollDelayMs(1) === QUEUE_POLL_BASE_MS * 2);
check("backoff: second failure quadruples", nextQueuePollDelayMs(2) === QUEUE_POLL_BASE_MS * 4);
check("backoff: caps at ceiling", nextQueuePollDelayMs(99) === QUEUE_POLL_BACKOFF_MAX_MS, `got ${nextQueuePollDelayMs(99)}`);
check("backoff: monotonic non-decreasing", [0, 1, 2, 3, 4, 5, 6].every((n) => nextQueuePollDelayMs(n) <= nextQueuePollDelayMs(n + 1)));

const { jobDriverName } = await import("./src/lib/job-ui.ts");
const contractors = [
  { id: "u-1", name: "Ada Driver", status: "online", location: { lat: 0, lng: 0, area: "" }, vehicleTypes: [], rating: 0, completedJobCount: 0, responseTimeHistoryMinutes: [], towbookDriverId: "9001" },
  { id: "u-2", name: "Bob Owner", status: "offline", location: { lat: 0, lng: 0, area: "" }, vehicleTypes: [], rating: 0, completedJobCount: 0, responseTimeHistoryMinutes: [] },
];
check("attribution: synced name wins", jobDriverName({ assignedDriverName: "Synced Name", assignedDriverTowbookId: "9001" }, contractors) === "Synced Name");
check("attribution: id-only resolves name from roster", jobDriverName({ assignedDriverTowbookId: "9001" }, contractors) === "Ada Driver");
check("attribution: unknown id → null (honest Unassigned)", jobDriverName({ assignedDriverTowbookId: "9999" }, contractors) === null);
check("attribution: legacy contractor id still resolves", jobDriverName({ assignedContractorId: "u-1" }, contractors) === "Ada Driver");
check("attribution: nothing → null", jobDriverName({}, contractors) === null);

/* ---------- (3) queue poll error-loop guards (source-level) ---------- */
const queueSrc = readFileSync("./src/components/driver-queue.tsx", "utf8");
const loadBody = queueSrc.slice(queueSrc.indexOf("const load = useCallback"), queueSrc.indexOf("useEffect(() => {\n    void load();"));
check("queue: identical error is not re-written each tick", loadBody.includes("r.message !== errorRef.current"), "dedupe guard missing");
check("queue: expired session stops the auto-poll", loadBody.includes("reschedule = false"), "expired must halt the retry loop");
check("queue: transient failure backoff is used", loadBody.includes("nextQueuePollDelayMs(failCountRef.current)"), "backoff not wired");
check("queue: no unconditional 20s interval remains", !queueSrc.includes("setInterval(() => void load(true), 20000)"), "old fixed 20s poll still present");

/* ---------- (1) login renders immediately (source-level) ---------- */
const loginSrc = readFileSync("./src/routes/login.tsx", "utf8");
check("login: no full-screen spinner gated on authStatus", !loginSrc.includes("if(checking)") && !loginSrc.includes("animate-spin"), "blocking spinner still present");
check("login: no `checking` state remains", !loginSrc.includes("setChecking") && !loginSrc.includes("useState(true)"), "checking state still present");
check("login: authStatus still redirects a signed-in user in background", loginSrc.includes("authStatus()") && loginSrc.includes("nav({to:") && loginSrc.includes("replace:true"));
check("login: single form render path (not gated behind a branch)", (loginSrc.match(/return <main/g) ?? []).length === 1, "multiple return branches — form still gated");

/* ---------- (2) global 16px input rule (source-level) ---------- */
const css = readFileSync("./src/styles/app.css", "utf8");
const baseLayer = css.slice(css.indexOf("@layer base"), css.indexOf("@keyframes toast-in"));
check("zoom: global input/textarea/select font-size ≥16px rule", /input\s*,\s*textarea\s*,\s*select\s*\{[^}]*font-size\s*:\s*16px/.test(css), "16px rule missing");
check("zoom: rule lives in the base layer (overrides utility text-sm)", baseLayer.includes("font-size: 16px"), "rule not in @layer base");

console.log(`native-login-zoom-errorloop: ${checks.filter((c) => c[1]).length}/${checks.length} checks passed`);
