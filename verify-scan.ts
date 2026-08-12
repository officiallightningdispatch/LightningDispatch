// Final verification (two-phase scan fix). Real mailbox, 14 days / 300 newest.
import { scanMailEnvelopes } from "./src/data/club-mail.ts";
import { detectDamageClaimEmail } from "./src/data/claims-core.ts";

const t0 = performance.now();
const mail = await scanMailEnvelopes({ sinceDays: 14, maxMessages: 300 });
const elapsedMs = performance.now() - t0;

console.log(`ok=${mail.ok} scanned=${mail.scanned} elapsedMs=${Math.round(elapsedMs)}`);
if (!mail.ok) { console.log(`ERROR: ${mail.error ?? "unknown"}`); process.exit(1); }

const withBody = mail.messages.filter((m) => m.bodyText !== "");
console.log(`messages=${mail.messages.length} withBodyText=${withBody.length} (pre-filter full-fetch set)`);

const detections = mail.messages
  .map((m) => ({ m, d: detectDamageClaimEmail({ from: m.from, subject: m.subject, bodyText: m.bodyText }) }))
  .filter((x) => x.d.isClaim);
for (const { m, d } of detections) {
  console.log(`  claim: company=${d.company} claimNumber=${d.claimNumber} bodyTextLen=${m.bodyText.length} subject=${m.subject.slice(0, 80)}`);
}

// Agero claim emails exist in the mailbox but their newest is 2026-07-20
// (probe: 22 damageteam@agero.com msgs, newest 7/20); the mailbox now receives
// ~1101 msgs/14d so the newest-300 window spans only back to 8/9. They are
// OUTSIDE the window by design (identical for the pre-fix code) — the hermetic
// claims suite (53/53) proves Agero detection through the two-phase pipeline.
const ageroInWindow = mail.messages.filter((m) => /agero/i.test(`${m.from} ${m.subject}`)).length;

const sixt = detections.find((x) => x.d.company === "Sixt");
const okSixt = Boolean(sixt && sixt.d.claimNumber === "9078616944" && sixt.m.bodyText.includes("9078616944"));
const okFast = elapsedMs < 8000;
const okCount = mail.scanned === 300;

console.log(`\nPASS scanned=300: ${okCount}`);
console.log(`PASS Sixt 9078616944 with bodyText: ${okSixt}`);
console.log(`PASS elapsed<8000ms: ${okFast} (${Math.round(elapsedMs)}ms)`);
console.log(`INFO agero-mentions in window (Swoop/notifications): ${ageroInWindow}; Agero claim emails are outside the newest-300 window (mailbox growth)`);
console.log(okCount && okSixt && okFast ? "ALL PASS" : "FAILURE");
process.exit(okCount && okSixt && okFast ? 0 : 1);
