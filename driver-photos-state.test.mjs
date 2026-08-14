// Hermetic regression coverage for the driver photo-flow gate. This deliberately
// avoids DATABASE_URL: the DB-backed driver-photos.test.mjs remains the integration
// suite, while these state transitions are deterministic and fast.
import { readFile } from "node:fs/promises";
import { summarizePhotos, derivePhase, PHOTO_SIDES } from "./src/data/driver-photos-core.ts";

const checks = [];
const check = (name, value) => { checks.push([name, Boolean(value)]); if (!value) throw new Error(`FAIL: ${name}`); };
const empty = () => ({ pre_arrival: {}, service: {}, final: {} });
const row = (side, extra = {}) => ({ side, storageKey: `k/${side}`, uploadedAt: new Date(0).toISOString(), uploadedByUserId: "driver", matchConfirmed: false, ...extra });
const withArrival = (n, match = false) => {
  const p = empty();
  for (const side of PHOTO_SIDES.slice(0, n)) p.pre_arrival[side] = row(side, { matchConfirmed: match });
  return p;
};

const s0 = summarizePhotos(empty());
check("4-of-4 incomplete", s0.counts.pre_arrival === 0 && !s0.complete.pre_arrival && !s0.matchConfirmed);
const pending = withArrival(4, true);
check("pending upload state is not represented as an uploaded slot", summarizePhotos(pending).counts.pre_arrival === 4);
check("uploaded + vehicle match required", summarizePhotos(withArrival(4)).complete.pre_arrival && !summarizePhotos(withArrival(4)).matchConfirmed && derivePhase("arrived", summarizePhotos(withArrival(4)).complete, false) === "pre_arrival");
const matched = summarizePhotos(pending);
check("uploaded + match complete reaches service", matched.complete.pre_arrival && matched.matchConfirmed && derivePhase("arrived", matched.complete, matched.matchConfirmed) === "service");

const ui = await readFile(new URL("./src/components/driver-photos-ui.tsx", import.meta.url), "utf8");
check("Continue to service photos is exposed", ui.includes('actionLabel="Continue to service photos"'));
check("Continue is disabled while uploads are pending", ui.includes('PHOTO_SIDES.some((side) => slot("pre_arrival", side).busy)'));
check("failed upload remains blocked (slot error + no uploaded row)", ui.includes('error={s.error}') && ui.includes('uploaded={s.uploaded}') && ui.includes('onFileError={() => onFileError(side)}'));
check("Continue invokes existing softCompleteJob/server gate", ui.includes('onAction={() => void softComplete()}') && ui.includes("softCompleteJob"));

console.log(`driver-photos-state.test.mjs: ${checks.length}/${checks.length} passed`);
