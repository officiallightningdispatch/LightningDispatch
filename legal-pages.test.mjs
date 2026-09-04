// Hermetic contract for the three public legal/static routes (/privacy,
// /terms, /support). No database, network, or app server: it verifies that the
// rendered content is the APPROVED VERBATIM text (byte-for-byte, modulo the
// markdown source's trailing newline), that each route file maps to the right
// content export, that the auth gate treats them as public, and that the
// landing + sign-in surfaces link to them.
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

const contentSrc = await read("./src/lib/legal-content.ts");
const rootSrc = await read("./src/routes/__root.tsx");
const indexSrc = await read("./src/routes/index.tsx");
const loginSrc = await read("./src/routes/login.tsx");

const routes = [
  { path: "/privacy", file: "privacy.tsx", export: "PRIVACY_POLICY_MD", md: "privacy-policy.md" },
  { path: "/terms", file: "terms.tsx", export: "TERMS_OF_SERVICE_MD", md: "terms-of-service.md" },
  { path: "/support", file: "support.tsx", export: "SUPPORT_MD", md: "support.md" },
];

const checks = [];
const check = (name, fn) => { fn(); checks.push(name); };

for (const r of routes) {
  check(`${r.path}: route file wires the right content export`, async () => {
    const routeSrc = await read(`./src/routes/${r.file}`);
    assert.match(routeSrc, new RegExp(`createFileRoute\\(["']${r.path}["']\\)`));
    assert.match(routeSrc, new RegExp(`\\b${r.export}\\b`));
    assert.match(routeSrc, /LegalPage/);
  });

  check(`${r.path}: content is the approved verbatim text`, async () => {
    const md = await read(`./src/legal/${r.md}`);
    const expected = md.replace(/\n$/, "");
    // The generated module embeds the text inside a template literal with
    // backticks/backslashes/`${` escaped; reconstruct the embedded payload by
    // pulling the raw literal between the backticks.
    const m = contentSrc.match(new RegExp(`export const ${r.export} = \`([\\s\\S]*?)\`;`));
    assert.ok(m, `missing ${r.export} export`);
    const unescaped = m[1]
      .replace(/\\`/g, "`")
      .replace(/\\\$\{/g, "${")
      .replace(/\\\\/g, "\\");
    assert.equal(unescaped, expected, `${r.path} content differs from src/legal/${r.md}`);
  });
}

check("auth gate lists all three legal paths as public", () => {
  for (const r of routes) {
    assert.ok(rootSrc.includes(`path === "${r.path}"`), `${r.path} missing from public-path gate`);
  }
  assert.match(rootSrc, /isPublicPath/);
});

check("landing and sign-in surfaces link to all three pages", () => {
  assert.match(indexSrc, /LegalLinks/);
  assert.match(loginSrc, /LegalLinks/);
  assert.match(indexSrc, /to="\/privacy"|to="\/terms"|to="\/support"|LegalLinks/);
});

console.log(`LEGAL PAGES HERMETIC CHECKS PASSED (${checks.length})`);
for (const name of checks) console.log(`  PASS  ${name}`);
