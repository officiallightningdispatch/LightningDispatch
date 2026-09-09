// Hermetic test for the Towbook owner report-credential resolution (payday
// manifest regression, 2026-09-08/09: the owner money page computed "0
// contractors" on the LIVE host).
//
// Root cause: `bearer()` (in towbook-reports-core.ts) authenticates the Towbook
// report API with `readOwnerCreds()`. That reader only looked at the
// machine-local sibling dir (<site-parent>/.secrets), which the hosted live
// deployment (a CloudFront snapshot of dist/) cannot read — so the Driver
// Activity / CallWorkflow report fetch threw `credentials_unavailable` on live
// and computePaydayCore fell through to an empty manifest. There are two fixes:
//   (a) readOwnerCreds now falls back to <site-root>/dist/.secrets (and the
//       source-tree .secrets), mirroring square-client.ts / b2-client.ts; and
//   (b) scripts/prepare-secrets.sh now embeds towbook-owner-username and
//       towbook-owner-password into dist/.secrets on every build.
//
// This suite proves (a) resolves creds from an artifact fallback dir (the live
// host's ONLY candidate) and that a missing/empty candidate chain still returns
// null (never a fake success); and (b) that the publish script actually copies
// the two credential files so the live build has something to fall back to.
// Pure filesystem assertions on temp dirs — no DB, no network, no real creds.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const { readOwnerCreds } = await import("./src/data/towbook-recovery.ts");

const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

const scratch = await mkdtemp(join(tmpdir(), "towbook-creds-"));
const stable = join(scratch, "stable");
const artifact = join(scratch, "dist", ".secrets");
const sourceTree = join(scratch, "site", ".secrets");
const empty = join(scratch, "empty");
const empties = join(scratch, "empties");
for (const dir of [stable, artifact, sourceTree, empty, empties]) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
}
try {
  // Fixture dirs: `artifact` holds the creds (the live-host scenario — the
  // stable sibling dir is absent on live, only dist/.secrets exists).
  await writeFile(join(stable, "towbook-owner-username"), "owner@example.com\n");
  await writeFile(join(stable, "towbook-owner-password"), "s3cret\n");
  await writeFile(join(artifact, "towbook-owner-username"), "  live-owner\n");
  await writeFile(join(artifact, "towbook-owner-password"), "live-pass\n");
  await writeFile(join(empties, "towbook-owner-username"), "   \n");
  await writeFile(join(empties, "towbook-owner-password"), "   \n");

  /* (a) the live-host scenario: only the artifact dir exists → must resolve. */
  {
    const c = await readOwnerCreds({ dirs: [artifact] });
    check("artifact-fallback: resolves username+password from dist/.secrets only",
      c !== null && c.username === "live-owner" && c.password === "live-pass",
      JSON.stringify(c));
  }

  /* (a) a chain where the first candidate is missing still resolves from the second. */
  {
    const c = await readOwnerCreds({ dirs: [empty, artifact] });
    check("fallback-order: missing first candidate → second resolves",
      c !== null && c.username === "live-owner" && c.password === "live-pass",
      JSON.stringify(c));
  }

  /* (a) stable dir still wins when present (no behavioral change locally). */
  {
    const c = await readOwnerCreds({ dirs: [stable, artifact] });
    check("stable-first: stable dir wins over artifact",
      c !== null && c.username === "owner@example.com" && c.password === "s3cret",
      JSON.stringify(c));
  }

  /* missing everywhere → null (never a fake success). */
  {
    const c = await readOwnerCreds({ dirs: [empty] });
    check("missing: returns null when neither file exists", c === null, JSON.stringify(c));
  }

  /* empty values everywhere → null (empty file is NOT a credential). */
  {
    const c = await readOwnerCreds({ dirs: [empties] });
    check("empty: whitespace-only values are treated as missing", c === null, JSON.stringify(c));
  }

  /* (b) the publish script must embed the two credential files into dist/.secrets. */
  {
    const siteRoot = join(dirname(fileURLToPath(import.meta.url)), "scripts", "prepare-secrets.sh");
    const script = await readFile(siteRoot, "utf8");
    check("publish: prepare-secrets.sh copies towbook-owner-username", script.includes("towbook-owner-username"), "");
    check("publish: prepare-secrets.sh copies towbook-owner-password", script.includes("towbook-owner-password"), "");
    check("publish: both files are in the names list (same line)", /names=\([^)]*towbook-owner-username[^)]*towbook-owner-password[^)]*\)/.test(script), "");
  }

  console.log(`\ntowbook-owner-creds.test.mjs: ${checks.length}/${checks.length} passed`);
  for (const [name, ok, extra] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` (${extra})` : ""}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
