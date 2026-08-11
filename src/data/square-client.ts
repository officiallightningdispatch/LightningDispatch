/**
 * Square Online Checkout (Create Payment Link) client — SERVER-ONLY.
 *
 * Completion flow (milestone "completion flow", owner-directed 2026-08-11):
 * the customer's optional tip is paid on Square's OWN hosted page — the driver
 * portal calls createTipLink, gets back a Square payment-link URL, and opens it
 * for the customer. No card entry code ever lives in this app; Square collects
 * and settles the payment into the OWNER's account, with the tip amount and the
 * specific driver's Towbook id attributed to the link so tips are paid out to
 * the right contractor.
 *
 * LIVE-GATED exactly like B2 was: the owner's Square production credentials are
 * PENDING, so loadSquareConfig fails loudly (structured error) until the token
 * + location id land in <site-parent>/.secrets (or env) — then this feature is
 * live with no code change. Credential resolution mirrors b2-client.ts:
 *   access token:  SQUARE_ACCESS_TOKEN   → SQUARE_ACCESS_TOKEN_FILE   → <site-parent>/.secrets/square-access-token
 *   location id:   SQUARE_LOCATION_ID    → SQUARE_LOCATION_ID_FILE    → <site-parent>/.secrets/square-location-id
 * loadSquareConfig(env, { stableDir }) supports hermetic tests (pass a
 * nonexistent stableDir to simulate "not configured").
 *
 * Imported ONLY by the server-only completion core (src/data/completion-core.ts)
 * and hermetic tests — never by client-reachable modules.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { findSiteRoot } from "./towbook-key";

const SITE_ROOT = findSiteRoot(import.meta.url);
/** Stable, publish-proof key path: sibling of the site root, outside the repo. */
const STABLE_DIR = join(dirname(SITE_ROOT), ".secrets");

export type SquareConfig = { accessToken: string; locationId: string };

const readEnvOrFile = async (env: string | undefined, envFile: string | undefined, stableFile: string): Promise<string | null> => {
  if (env && env.trim() !== "") return env.trim();
  if (envFile) {
    try {
      const v = (await readFile(envFile, "utf8")).trim();
      if (!v) throw new Error(`${envFile} is empty`);
      return v;
    } catch (err) {
      throw new Error(`${envFile} is not readable: ${String(err)}`);
    }
  }
  try {
    const v = (await readFile(stableFile, "utf8")).trim();
    if (v) return v;
  } catch { /* fall through to the missing-creds error below */ }
  return null;
};

/** Resolve the Square credentials. Throws a clear, structured error when either
 *  part is missing — callers surface it as square_not_configured, never a fake
 *  success. */
export async function loadSquareConfig(env: NodeJS.ProcessEnv = process.env, opts: { stableDir?: string } = {}): Promise<SquareConfig> {
  const stableDir = opts.stableDir ?? STABLE_DIR;
  const [accessToken, locationId] = await Promise.all([
    readEnvOrFile(env.SQUARE_ACCESS_TOKEN, env.SQUARE_ACCESS_TOKEN_FILE, join(stableDir, "square-access-token")),
    readEnvOrFile(env.SQUARE_LOCATION_ID, env.SQUARE_LOCATION_ID_FILE, join(stableDir, "square-location-id")),
  ]);
  const missing: string[] = [];
  if (!accessToken) missing.push("SQUARE_ACCESS_TOKEN (or a square-access-token file in .secrets)");
  if (!locationId) missing.push("SQUARE_LOCATION_ID (or a square-location-id file in .secrets)");
  if (missing.length) {
    throw new Error(`Square is not configured — missing ${missing.join(", ")}. Customer tips stay offline until the owner's Square credentials are wired.`);
  }
  return { accessToken: accessToken!, locationId: locationId! };
}

export type SquarePaymentLinkResult = { paymentLinkId: string; url: string };

/** POST /v2/online-checkout/payment-links with the owner's Bearer token. The
 *  line item NAME carries the driver + job attribution (tips must be paid out
 *  to the specific driver). Injectable fetchImpl for hermetic tests — the live
 *  integration only fires when the credentials are configured. */
export async function createPaymentLink(opts: {
  config: SquareConfig;
  idempotencyKey: string;
  lineItemName: string;
  amountCents: number;
  currency?: string;
  fetchImpl?: typeof fetch;
}): Promise<SquarePaymentLinkResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const currency = opts.currency ?? "USD";
  const res = await fetchImpl("https://connect.squareup.com/v2/online-checkout/payment-links", {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.config.accessToken}`,
      "content-type": "application/json",
      "square-version": "2025-01-23",
    },
    body: JSON.stringify({
      idempotency_key: opts.idempotencyKey,
      order: {
        location_id: opts.config.locationId,
        line_items: [
          {
            name: opts.lineItemName,
            quantity: "1",
            base_price_money: { amount: opts.amountCents, currency },
          },
        ],
      },
    }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let body: unknown = text;
  if (text) { try { body = JSON.parse(text); } catch { /* keep raw */ } }
  if (!res.ok) {
    const msg = body && typeof body === "object"
      ? JSON.stringify((body as Record<string, unknown>).errors ?? body).slice(0, 200)
      : String(body).slice(0, 200);
    throw new Error(`Square payment-link request failed (HTTP ${res.status ?? "error"}) — ${msg}`);
  }
  const link = body && typeof body === "object" ? (body as Record<string, unknown>).payment_link : null;
  const linkId = link && typeof link === "object" ? (link as Record<string, unknown>).id : null;
  const url = link && typeof link === "object" ? (link as Record<string, unknown>).url : null;
  if (typeof linkId !== "string" || !linkId || typeof url !== "string" || !url) {
    throw new Error("Square payment-link response did not include a link URL.");
  }
  return { paymentLinkId: linkId, url };
}
