#!/usr/bin/env bun
/**
 * Nightly DB snapshot (2026-08-12, post-incident hardening — deliverable 2).
 *
 * STANDALONE — run directly with bun, NEVER wired into the server:
 *   DATABASE_URL=... bun scripts/db-snapshot.ts
 *   SNAPSHOT_PREFIX=ld-db-backups-test/ DATABASE_URL=... bun scripts/db-snapshot.ts  (retention drill)
 *
 * What it does:
 *  1. Connects via DATABASE_URL (REQUIRED — no /proc fallback: a backup script
 *     must be explicit about its target; READ-ONLY, SELECT only, no QA rows
 *     are ever written).
 *  2. Dumps ALL tables in the public schema. pg_dump is preferred when it is
 *     installed (full SQL dump embedded as text); otherwise every table is
 *     SELECT *'d into a JSON rows array. Per-table row counts are always
 *     reported.
 *  3. Writes ONE snapshot object to the B2 bucket under
 *     <prefix><db>-<timestamp>.json using the existing b2-client pattern
 *     (loadB2Config -> authorizeAccount -> putObject).
 *  4. Retention: keeps the NEWEST 14 objects under the prefix, deletes older.
 *  5. Prints one line: object key, row counts, byte size.
 *
 * Exit code 0 on success, 1 on any failure (nothing is ever silently dropped).
 */
import { neon } from "@neondatabase/serverless";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadB2Config, authorizeAccount, putObject, listObjects, deleteObject } from "../src/data/b2-client";

const execFileAsync = promisify(execFile);

if (!process.env.DATABASE_URL) {
  console.error("db-snapshot: DATABASE_URL is required (a backup must name its target explicitly).");
  process.exit(1);
}

const RETENTION = 14; // newest N snapshots kept
const PREFIX = (process.env.SNAPSHOT_PREFIX ?? "ld-db-backups/").replace(/\/?$/, "/");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-"); // sortable (lexicographic = chronological)
const dbName = (() => {
  try {
    const u = new URL(process.env.DATABASE_URL);
    return (u.pathname ?? "").replace(/^\//, "") || "db";
  } catch {
    return "db";
  }
})();
const KEY = `${PREFIX}${dbName}-${STAMP}.json`;

/** Enumerate public-schema base tables + per-table row counts. */
interface SqlTag {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Record<string, unknown>[]>;
  unsafe(sql: string): string;
}
async function tablesWithCounts(q: SqlTag) {
  const names = (await q`SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`) as Record<string, unknown>[];
  const counts: Record<string, number> = {};
  for (const r of names) {
    const table = String(r.table_name);
    const c = await q`SELECT COUNT(*)::int AS n FROM ${q.unsafe(table)}` as unknown as { n: number }[];
    counts[table] = Number(c[0]?.n ?? 0);
  }
  return { names: names.map((r) => String(r.table_name)), counts };
}

async function pgDumpAvailable(): Promise<boolean> {
  try {
    await execFileAsync("pg_dump", ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const q = neon(process.env.DATABASE_URL!) as unknown as SqlTag;
  const { names, counts } = await tablesWithCounts(q);

  let data: unknown;
  let totalRows = 0;
  for (const n of names) totalRows += counts[n] ?? 0;

  // pg_dump is an optimization only: any runtime failure (including server/
  // client version mismatch) must fall back to the read-only JSON-row export.
  // Availability probing alone is insufficient because pg_dump --version can
  // succeed while the actual connection fails.
  try {
    if (!(await pgDumpAvailable())) throw new Error("pg_dump is unavailable");
    // Preferred: pg_dump's full SQL (schema + data) — restores with psql.
    const { stdout } = await execFileAsync(
      "pg_dump",
      ["--no-owner", "--no-privileges", process.env.DATABASE_URL!],
      { timeout: 120_000, maxBuffer: 512 * 1024 * 1024 }
    );
    data = { format: "pg_dump-sql", sql: stdout };
  } catch (err) {
    console.warn(`db-snapshot: pg_dump failed; using JSON-row fallback (${err instanceof Error ? err.message : String(err)})`);
    const tables: Record<string, { rowCount: number; rows: unknown[] }> = {};
    for (const name of names) {
      // Neon caps an individual response at 64 MiB. Page large tables so the
      // JSON fallback remains a real complete dump rather than failing on one
      // oversized SELECT * result.
      const rows: unknown[] = [];
      const pageSize = 1;
      const identifier = `"public"."${name.replaceAll('"', '""')}"`;
      for (let offset = 0;; offset += pageSize) {
        const page = (await q`SELECT * FROM ${q.unsafe(identifier)} LIMIT ${pageSize} OFFSET ${offset}`) as unknown[];
        rows.push(...page);
        if (page.length < pageSize) break;
      }
      tables[name] = { rowCount: rows.length, rows };
    }
    data = { format: "json-rows", tables };
  }

  const snapshot = {
    capturedAt: new Date().toISOString(),
    database: dbName,
    generatedBy: "scripts/db-snapshot.ts (2026-08-12)",
    totalTables: names.length,
    totalRows,
    perTableRowCounts: counts,
    data,
  };
  const bytes = Buffer.from(JSON.stringify(snapshot));

  // ---- upload ----
  const config = await loadB2Config();
  const auth = await authorizeAccount({ keyId: config.keyId, applicationKey: config.applicationKey });
  const up = await putObject({ config, s3ApiUrl: auth.s3ApiUrl, key: KEY, bytes, contentType: "application/json" });
  if (!up.ok) throw new Error(`snapshot upload failed (HTTP ${up.status ?? "?"}): ${JSON.stringify(up.body ?? "").slice(0, 300)}`);

  // ---- retention: keep newest RETENTION, delete older ----
  const list = await listObjects({ config, s3ApiUrl: auth.s3ApiUrl, prefix: PREFIX });
  if (!list.ok) throw new Error(`snapshot listing failed (HTTP ${list.status ?? "?"})`);
  const sorted = [...list.keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const toDelete = sorted.slice(0, Math.max(0, sorted.length - RETENTION));
  let deleted = 0;
  for (const key of toDelete) {
    const d = await deleteObject({ config, s3ApiUrl: auth.s3ApiUrl, key });
    if (d.ok) deleted++;
    else console.error(`db-snapshot: WARN failed to delete ${key} (HTTP ${d.status ?? "?"})`);
  }

  const kept = Math.min(sorted.length, RETENTION);
  console.log(
    `SNAPSHOT OK key=${KEY} tables=${names.length} rows=${totalRows} bytes=${bytes.length} retention=kept:${kept}/deleted:${deleted} (bucket objects under prefix: ${sorted.length})`
  );
}

main().catch((err) => {
  console.error(`db-snapshot: FAILED — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
