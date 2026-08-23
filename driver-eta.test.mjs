// Hermetic regression tests for the SUB B ETA fixes (2026-08-23) — NO React
// render, NO DB: pure unit tests only.
//   - defect 4: duration-based driver countdown (src/lib/driver-eta-core.ts) —
//     the countdown runs from `now + ldEtaMinutes` (a DURATION) rather than a
//     fixed absolute Towbook arrivalETA, and re-anchors when the quote changes.
//   - defect 1b: the driver ETA surface (normalizeDriverCall) exposes
//     `ldEtaMinutes`, and the pure preference helpers prefer the LD quote over
//     Towbook's raw `arrivalETA`, falling back to arrivalETA when the quote is
//     NULL (legacy rows).
//     bun driver-eta.test.mjs
import { normalizeDriverCall } from "./src/data/driver-auth.ts";
import {
  etaQuoteKey,
  etaTargetMs,
  etaRemainingSeconds,
  formatCountdown,
  anchorEta,
  preferredEtaIso,
} from "./src/lib/driver-eta-core.ts";

const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

/* ---------------- defect 4: duration-based countdown ---------------- */
{
  // A duration quote (ldEtaMinutes) anchors from now + N minutes, NOT the
  // (possibly stale) absolute Towbook arrivalETA.
  const now = Date.parse("2026-08-23T12:00:00.000Z");
  const eta = { arrivalETA: "2026-08-23T09:00:00.000Z", ldEtaMinutes: 12 }; // stale absolute arrivalETA
  const target = etaTargetMs(eta, now);
  check("etaTargetMs: duration quote anchors now + 12 min (ignores stale absolute arrivalETA)", target === now + 12 * 60000, String(target));
  check("etaRemainingSeconds: 12-min duration → 720s at anchor", etaRemainingSeconds(target, now) === 720, String(etaRemainingSeconds(target, now)));
  check("etaRemainingSeconds: floors and never negative", etaRemainingSeconds(target, now + 13 * 60000) === 0, "");
  check("formatCountdown: mm:ss zero-padded", formatCountdown(725) === "12:05" && formatCountdown(-5) === "00:00" && formatCountdown(60) === "01:00", "");
}

/* ---------------- defect 1b: prefer LD quote over arrivalETA ---------------- */
{
  const now = Date.parse("2026-08-23T08:50:00.000Z");
  // Legacy row: ldEtaMinutes NULL → fall back to the Towbook absolute arrivalETA.
  const legacy = { arrivalETA: "2026-08-23T09:00:00.000Z", ldEtaMinutes: null };
  check("etaQuoteKey: NULL ldEtaMinutes → Towbook arrivalETA key", etaQuoteKey(legacy) === "2026-08-23T09:00:00.000Z", etaQuoteKey(legacy));
  check("etaTargetMs: NULL ldEtaMinutes → absolute arrivalETA timestamp", etaTargetMs(legacy, now) === Date.parse("2026-08-23T09:00:00.000Z"), String(etaTargetMs(legacy, now)));
  check("preferredEtaIso: NULL ldEtaMinutes → Towbook arrivalETA", preferredEtaIso(legacy, now) === "2026-08-23T09:00:00.000Z", preferredEtaIso(legacy, now));
  // LD quote present → prefer the duration over the raw arrivalETA.
  const quoted = { arrivalETA: "2026-08-23T09:00:00.000Z", ldEtaMinutes: 12 };
  check("etaQuoteKey: ldEtaMinutes present → 'ld:12' key", etaQuoteKey(quoted) === "ld:12", etaQuoteKey(quoted));
  check("preferredEtaIso: LD quote preferred over Towbook arrivalETA", preferredEtaIso(quoted, now) === new Date(now + 12 * 60000).toISOString(), preferredEtaIso(quoted, now));
  // Re-anchor on requote: same key keeps the anchor, a changed quote re-anchors.
  const a1 = anchorEta(null, quoted, now);
  check("anchorEta: first quote anchors at now", a1.key === "ld:12" && a1.at === now, JSON.stringify(a1));
  const a2 = anchorEta(a1, { ...quoted }, now + 5000);
  check("anchorEta: stable quote keeps the original anchor (no reset)", a2.key === "ld:12" && a2.at === now, JSON.stringify(a2));
  const a3 = anchorEta(a2, { arrivalETA: "2026-08-23T09:00:00.000Z", ldEtaMinutes: 18 }, now + 9000);
  check("anchorEta: changed quote re-anchors at the new now", a3.key === "ld:18" && a3.at === now + 9000, JSON.stringify(a3));
}

/* ---------------- defect 1b: normalizeDriverCall surface ---------------- */
{
  const card = normalizeDriverCall({
    id: 880001, callNumber: 880001, reason: { id: 365, name: "Jump Start" },
    status: { id: 2 },
    waypoints: [{ address: "70 Pitt Street", zip: "06606" }],
    arrivalETA: "2026-08-23T21:07:00",
  });
  check("normalizeDriverCall: exposes ldEtaMinutes (null default; DB enrichment fills it)", card !== null && card.ldEtaMinutes === null && card.arrivalETA === "2026-08-23T21:07:00" && card.statusId === 2, JSON.stringify(card));
}

/* ------------------------------ summary ------------------------------ */
const failed = checks.filter(([, ok]) => !ok);
console.log(`driver-eta.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
  console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n"));
  process.exit(1);
}
