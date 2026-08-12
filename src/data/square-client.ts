/**
 * Square client — SERVER-ONLY.
 *
 * Completion flow (milestone "completion flow", owner-directed 2026-08-11):
 * the customer's optional tip is charged through the OWNER's Square account.
 * Two integrations live here:
 *   1) createTipLink — Square Online Checkout (Create Payment Link API): a
 *      Square-hosted page the customer pays on (pre-Web-Payments fallback).
 *   2) createCardPayment — Square Payments API (POST /v2/payments): the card is
 *      tokenized CLIENT-SIDE by Square's Web Payments SDK; the token is charged
 *      HERE with the owner's Bearer token + a per-attempt idempotency key, and
 *      the payment settles into the OWNER's account. Tips are attributed to the
 *      specific driver (completion_tips row) so they are paid out correctly.
 * The access token NEVER leaves this module (client code only receives the
 * public application id + location id via loadSquarePublicConfig).
 *
 * LIVE-GATED exactly like B2 was: the owner's Square production credentials are
 * wired, so loadSquareConfig resolves them; until they all land in
 * <site-parent>/.secrets (or env) it fails loudly (structured error) and the
 * feature stays offline. Credential resolution mirrors b2-client.ts:
 *   access token:    SQUARE_ACCESS_TOKEN    → SQUARE_ACCESS_TOKEN_FILE    → <site-parent>/.secrets/square-access-token
 *   location id:     SQUARE_LOCATION_ID     → SQUARE_LOCATION_ID_FILE     → <site-parent>/.secrets/square-location-id
 *   application id:  SQUARE_APPLICATION_ID  → SQUARE_APPLICATION_ID_FILE  → <site-parent>/.secrets/square-application-id
 * loadSquareConfig(env, { stableDir }) supports hermetic tests (pass a
 * nonexistent stableDir to simulate "not configured").
 *
 * The Web Payments flow (owner-directed 2026-08-11): the customer's card is
 * tokenized CLIENT-SIDE by Square's Web Payments SDK (the client only ever
 * receives the PUBLIC application id + location id — never the access token),
 * then the token is charged SERVER-SIDE here via POST /v2/payments with the
 * owner's Bearer token and a per-attempt idempotency key.
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

export type SquareConfig = { accessToken: string; locationId: string; applicationId: string };

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

/** Resolve the Square credentials. Throws a clear, structured error when any
 *  part is missing — callers surface it as square_not_configured, never a fake
 *  success. */
export async function loadSquareConfig(env: NodeJS.ProcessEnv = process.env, opts: { stableDir?: string } = {}): Promise<SquareConfig> {
  const stableDir = opts.stableDir ?? STABLE_DIR;
  const [accessToken, locationId, applicationId] = await Promise.all([
    readEnvOrFile(env.SQUARE_ACCESS_TOKEN, env.SQUARE_ACCESS_TOKEN_FILE, join(stableDir, "square-access-token")),
    readEnvOrFile(env.SQUARE_LOCATION_ID, env.SQUARE_LOCATION_ID_FILE, join(stableDir, "square-location-id")),
    readEnvOrFile(env.SQUARE_APPLICATION_ID, env.SQUARE_APPLICATION_ID_FILE, join(stableDir, "square-application-id")),
  ]);
  const missing: string[] = [];
  if (!accessToken) missing.push("SQUARE_ACCESS_TOKEN (or a square-access-token file in .secrets)");
  if (!locationId) missing.push("SQUARE_LOCATION_ID (or a square-location-id file in .secrets)");
  if (!applicationId) missing.push("SQUARE_APPLICATION_ID (or a square-application-id file in .secrets)");
  if (missing.length) {
    throw new Error(`Square is not configured — missing ${missing.join(", ")}. Customer tips stay offline until the owner's Square credentials are wired.`);
  }
  return { accessToken: accessToken!, locationId: locationId!, applicationId: applicationId! };
}

/** PUBLIC Web Payments config for the CLIENT (driver portal): application id +
 *  location id only — the access token NEVER leaves the server. The client uses
 *  these to initialize Square's Web Payments SDK and tokenize the card. */
export type SquarePublicConfig = { applicationId: string; locationId: string };

export async function loadSquarePublicConfig(env: NodeJS.ProcessEnv = process.env, opts: { stableDir?: string } = {}): Promise<SquarePublicConfig> {
  const { locationId, applicationId } = await loadSquareConfig(env, opts);
  return { applicationId, locationId };
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

/* ------------------------- Cards API (card on file) ------------------------- */

/** A card stored on the OWNER's Square account via the Cards API — the returned
 *  id (`ccof:…`) is a payment source for POST /v2/payments, so a stored club
 *  card can be charged later without re-entering card details. */
export type SquareCardOnFile = {
  cardId: string; // "ccof:…"
  brand: string | null; // e.g. "VISA"
  last4: string | null;
};

/**
 * Store a card on file: POST /v2/cards. Verified request shape against the
 * Square docs (developer.squareup.com/reference/square/cards-api/create-card,
 * 2026-08-11): required body fields are `idempotency_key` (unique per request,
 * max 45 chars) and `source_id` (a card NONCE — the example shows
 * `"source_id": "cnon:…"`, the Web Payments SDK token) plus a `card` object.
 * The docs' request example always includes `card.billing_address` (address
 * line / locality / administrative_district_level_1 / postal_code / country)
 * and `card.cardholder_name` — Square validates the card's zip/postal code
 * against the billing address, so the OWNER'S verified business address
 * placeholder is used here (Lightning Roadside Assistants LLC, Bridgeport CT —
 * see FIXED_BILLING_ADDRESS below). The response `card.id` is the `ccof:…`
 * payment source; `card.card_brand` / `card.last_4` are stored for display
 * (the PAN is never returned by Square and never stored).
 * NOTE: a Web Payments card nonce is single-use — it must be passed to this
 * endpoint (or a payment) exactly once.
 */
export const FIXED_BILLING_ADDRESS = {
  address_line_1: "3874 Main Street",
  locality: "Bridgeport",
  administrative_district_level_1: "CT",
  postal_code: "06606",
  country: "US",
} as const;

export async function createCardOnFile(opts: {
  config: SquareConfig;
  idempotencyKey: string; // max 45 chars — caller truncates
  sourceId: string; // the Web Payments SDK card nonce (cnon:…)
  cardholderName?: string;
  referenceId?: string;
  fetchImpl?: typeof fetch;
}): Promise<SquareCardOnFile> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const res = await fetchImpl("https://connect.squareup.com/v2/cards", {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.config.accessToken}`,
      "content-type": "application/json",
      "square-version": "2025-01-23",
    },
    body: JSON.stringify({
      idempotency_key: opts.idempotencyKey,
      source_id: opts.sourceId,
      card: {
        billing_address: FIXED_BILLING_ADDRESS,
        cardholder_name: opts.cardholderName ?? "Lightning Roadside Assistants LLC",
        ...(opts.referenceId ? { reference_id: opts.referenceId } : {}),
      },
    }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let body: unknown = text;
  if (text) { try { body = JSON.parse(text); } catch { /* keep raw */ } }
  if (!res.ok) {
    const msg = body && typeof body === "object"
      ? JSON.stringify((body as Record<string, unknown>).errors ?? body).slice(0, 300)
      : String(body).slice(0, 300);
    throw new Error(`Square card create failed (HTTP ${res.status ?? "error"}) — ${msg}`);
  }
  const card = body && typeof body === "object" ? (body as Record<string, unknown>).card : null;
  const cardId = card && typeof card === "object" ? (card as Record<string, unknown>).id : null;
  if (typeof cardId !== "string" || !cardId) {
    throw new Error("Square card response did not include a card id.");
  }
  const c = card as Record<string, unknown>;
  const brand = typeof c.card_brand === "string" && c.card_brand !== "" ? c.card_brand : null;
  const last4 = typeof c.last_4 === "string" && c.last_4 !== "" ? c.last_4 : null;
  return { cardId, brand, last4 };
}

/** Remove a stored card: DELETE /v2/cards/{card_id}. Returns false when Square
 *  reports 404 (already removed) so callers can treat it as success and clean
 *  up their local row. Other failures throw with the Square error message. */
export async function deleteCardOnFile(opts: {
  config: SquareConfig;
  cardId: string;
  fetchImpl?: typeof fetch;
}): Promise<{ deleted: boolean }> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const res = await fetchImpl(`https://connect.squareup.com/v2/cards/${encodeURIComponent(opts.cardId)}`, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${opts.config.accessToken}`,
      "square-version": "2025-01-23",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 404) return { deleted: false };
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const msg = text ? text.slice(0, 300) : "";
    throw new Error(`Square card delete failed (HTTP ${res.status ?? "error"}) — ${msg}`);
  }
  return { deleted: true };
}

/* ------------------------- Web Payments (card, in-app) ------------------------- */

export type SquareCardPaymentResult = {
  paymentId: string;
  status: string; // Square's own status: COMPLETED / APPROVED / PENDING / FAILED / CANCELED
  receiptUrl: string | null;
};

/** Charge the customer's card token (created CLIENT-SIDE by Square's Web
 *  Payments SDK) via POST /v2/payments with the OWNER's Bearer token. The
 *  access token never leaves the server; the client only ever held the PUBLIC
 *  application id + location id. The idempotency key is the caller's per-attempt
 *  key (tip-<job>-<driver>-<attempt>) — Square returns the SAME payment for a
 *  replayed key, so a retry with the same attempt can never double-charge.
 *  Injectable fetchImpl for hermetic tests — the live integration only fires
 *  when the credentials are configured. */
export async function createCardPayment(opts: {
  config: SquareConfig;
  idempotencyKey: string;
  sourceId: string; // the Web Payments card token/nonce
  amountCents: number;
  currency?: string;
  note?: string;
  fetchImpl?: typeof fetch;
}): Promise<SquareCardPaymentResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const currency = opts.currency ?? "USD";
  const res = await fetchImpl("https://connect.squareup.com/v2/payments", {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.config.accessToken}`,
      "content-type": "application/json",
      "square-version": "2025-01-23",
    },
    body: JSON.stringify({
      source_id: opts.sourceId,
      idempotency_key: opts.idempotencyKey,
      amount_money: { amount: opts.amountCents, currency },
      location_id: opts.config.locationId,
      ...(opts.note ? { note: opts.note } : {}),
      autocomplete: true,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let body: unknown = text;
  if (text) { try { body = JSON.parse(text); } catch { /* keep raw */ } }
  if (!res.ok) {
    const msg = body && typeof body === "object"
      ? JSON.stringify((body as Record<string, unknown>).errors ?? body).slice(0, 300)
      : String(body).slice(0, 300);
    throw new Error(`Square payment failed (HTTP ${res.status ?? "error"}) — ${msg}`);
  }
  const payment = body && typeof body === "object" ? (body as Record<string, unknown>).payment : null;
  const paymentId = payment && typeof payment === "object" ? (payment as Record<string, unknown>).id : null;
  if (typeof paymentId !== "string" || !paymentId) {
    throw new Error("Square payment response did not include a payment id.");
  }
  const p = payment as Record<string, unknown>;
  const status = typeof p.status === "string" && p.status !== "" ? p.status : "UNKNOWN";
  const receiptUrl = typeof p.receipt_url === "string" && p.receipt_url !== "" ? p.receipt_url : null;
  return { paymentId, status, receiptUrl };
}
