import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const applicantAndContractorSurfaces = [
  "./src/routes/apply.tsx",
  "./src/routes/driver/onboarding.tsx",
  "./src/legal/privacy-policy.md",
  "./src/legal/terms-of-service.md",
  "./src/legal/support.md",
  "./src/lib/legal-content.ts",
];

for (const path of applicantAndContractorSurfaces) {
  const source = await read(path);
  assert.doesNotMatch(source, /Towbook/i, `${path} exposes an internal integration name`);
}

const jobDetail = await read("./src/components/job-detail.tsx");
assert.doesNotMatch(jobDetail, />\s*Towbook\s*</i, "job details expose an internal integration heading");

const driverAuth = await read("./src/data/driver-auth.ts");
assert.match(driverAuth, /The dispatch username or password didn't match/);
assert.match(driverAuth, /Dispatch sign-in is temporarily unavailable/);
assert.doesNotMatch(driverAuth, /`Towbook job \$\{callId\}`/);

const driverPhotos = await read("./src/data/driver-photos-core.ts");
assert.doesNotMatch(driverPhotos, /could not (?:attach|be confirmed)[^\n]*Towbook/i);

console.log("CONTRACTOR WHITE-LABEL CHECKS PASSED");
