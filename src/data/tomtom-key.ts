import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Site root, walked up from this module (source or published server bundle). */
const SITE_ROOT = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
})();

/** Stable key path outside the repo/build, plus publish artifact fallbacks. */
const STABLE_TOMTOM_KEY_FILE = join(dirname(SITE_ROOT), ".secrets", "tomtom.key");
const ARTIFACT_TOMTOM_KEY_FILES = [
  join(SITE_ROOT, "dist", ".secrets", "tomtom.key"),
  join(SITE_ROOT, ".secrets", "tomtom.key"),
];

/** Resolve the TomTom key without loading the AI dispatcher bundle. */
export function resolveTomtomKey(
  env: Record<string, string | undefined>,
  opts: { stableKeyFile?: string; allowArtifactFallback?: boolean } = {},
): string | null {
  const fromEnv = (env.TOMTOM_API_KEY ?? "").trim();
  if (fromEnv) return fromEnv;
  const explicitFile = (env.TOMTOM_KEY_FILE ?? "").trim();
  if (explicitFile) {
    try {
      return readFileSync(explicitFile, "utf8").trim() || null;
    } catch {
      return null;
    }
  }
  const stableFile = opts.stableKeyFile ?? STABLE_TOMTOM_KEY_FILE;
  try {
    const value = readFileSync(stableFile, "utf8").trim();
    if (value) return value;
  } catch { /* fall through to artifact copies */ }
  const artifactFiles = opts.stableKeyFile && !opts.allowArtifactFallback ? [] : ARTIFACT_TOMTOM_KEY_FILES;
  for (const file of artifactFiles) {
    try {
      const value = readFileSync(file, "utf8").trim();
      if (value) return value;
    } catch { /* try the next candidate */ }
  }
  return null;
}
