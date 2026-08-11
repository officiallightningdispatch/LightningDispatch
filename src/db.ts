import { neon } from "@neondatabase/serverless";

/**
 * Server-only handle to the team's database (Neon serverless Postgres over HTTP).
 * The connection string comes from `DATABASE_URL`, which the owner connects via
 * the database card and which is injected into the sandbox and passed to the live
 * host on publish. Resolved lazily (per call, not at module load) so the site
 * still builds and serves before a database is connected — the error only
 * surfaces if a query actually runs without `DATABASE_URL`.
 *
 * Use it only inside a `createServerFn()` handler or an `src/routes/api/*` route
 * (never client code):
 *
 *   const getPosts = createServerFn().handler(async () => {
 *     const rows = await sql()`select id, title, created_at from posts`;
 *     // Coerce non-primitive columns (timestamps are JS Dates) to strings before
 *     // returning to the client, or React will refuse to render them:
 *     return rows.map((r) => ({ ...r, created_at: String(r.created_at) }));
 *   });
 */
export const sql = () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set — connect a database (via the database card) before running queries.",
    );
  }
  return neon(url);
};

/**
 * `sql` with a hard per-handle deadline: every query issued through the returned
 * handle aborts (underlying fetch aborted) once `ms` elapses from handle
 * creation. Used ONLY by the background Towbook sync / AI-dispatch path so a
 * wedged/hung Neon query can never stall the 3s loop forever — the sync's
 * per-tick race still clears the in-flight guard on timeout, but the abort also
 * frees the underlying HTTP fetch so the zombie tick actually dies instead of
 * lingering. Keep the budget generous (sync alone can legitimately take ~12s).
 */
export const sqlWithTimeout = (ms: number) => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set — connect a database (via the database card) before running queries.",
    );
  }
  return neon(url, { fetchOptions: { signal: AbortSignal.timeout(ms) } });
};
