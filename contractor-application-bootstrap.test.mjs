import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./src/data/contractor-signup-core.ts", import.meta.url), "utf8");

assert.match(source, /function ensureApplicationSchema\(\)/);
assert.match(source, /CREATE TABLE IF NOT EXISTS contractor_applications/);
assert.match(source, /CREATE UNIQUE INDEX IF NOT EXISTS contractor_applications_org_user_idx/);
assert.doesNotMatch(source, /import\("\.\/migrations"\)/, "public onboarding must not run the full historical migration chain");
assert.match(source, /verify\(signup\.data\.password/);
assert.match(source, /application_id == null/);
assert.match(source, /if \(!recoverableUserId\) await sql\(\)`DELETE FROM users/);

console.log("CONTRACTOR APPLICATION BOOTSTRAP CHECKS PASSED");
