/**
 * Motor-club Gmail scanner (owner spec 2026-08-11, backlog #1 first slice) —
 * SERVER-ONLY.
 *
 * Scans the OWNER's Gmail (lightroad29@gmail.com via IMAP, app password from
 * <site-parent>/.secrets/gmail-address + gmail-app-password) for motor-club
 * card-charge notifications — Allied Dispatch, Honk, Allstate — and turns them
 * into parseable candidates for the payment engine:
 *
 *   { messageId, receivedAt, from, subject, amountCents, cardLast4, clubName, poRef }
 *
 * Design:
 *   - The IMAP search is `SINCE <last N days>` (default 14); the motor-club
 *     filter runs CLIENT-SIDE (from-domain + body keywords) because club
 *     sender domains vary and a single IMAP SEARCH can't express the fuzzy
 *     match. Unparseable mail is skipped with a reason — a scan never crashes
 *     on one bad message.
 *   - `parseClubChargeEmail` is a PURE function (from/subject/bodyText → parsed
 *     candidate or skip reason), so parsing is unit-testable without IMAP.
 *   - `fetchClubMail` is the only place imapflow is imported. Real connections
 *     are replaceable by an injectable `connectImpl` (async () => MailboxLike)
 *     so hermetic tests exercise the full scan pipeline with a fake mailbox.
 *
 * Security: this module NEVER logs credentials, message content, or card
 * numbers. It extracts only the last-4 of a card (never the PAN) plus the
 * charge amount / club / PO reference for the ledger. Gmail app passwords are
 * scope-restricted; the scan is read-only (BODY.PEEK, no flags changed).
 *
 * Imported ONLY by the server-only payment engine core
 * (src/data/payment-engine-core.ts) and hermetic tests — never by
 * client-reachable modules (client-graph rule).
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { findSiteRoot } from "./towbook-key";
// Claim-language + company-keyword pre-filter (two-phase scan). Importing
// claims-core here is cycle-safe: claims-core imports club-mail ONLY as a type
// (`import type`) and via lazy `await import()` inside function bodies, so the
// runtime graph is one-directional (club-mail -> claims-core). CLAIM_PHRASES /
// CLAIM_COMPANIES stay the single source of truth for what a claim looks like.
import { CLAIM_COMPANIES, CLAIM_PHRASES } from "./claims-core";

const SITE_ROOT = findSiteRoot(import.meta.url);
/** Stable, publish-proof key path: sibling of the site root, outside the repo. */
const STABLE_DIR = join(dirname(SITE_ROOT), ".secrets");
/** Artifact fallbacks (mirror b2-client.ts / towbook-key.ts LEGACY_KEY_FILES):
 *  the hosted live deployment (…ctonew.app, a CloudFront snapshot) cannot read
 *  the machine-local sibling dir, so the build embeds the creds at
 *  <site-root>/dist/.secrets (preferred over the source-tree .secrets, which
 *  only local source runs would have). */
const ARTIFACT_DIRS = [join(SITE_ROOT, "dist", ".secrets"), join(SITE_ROOT, ".secrets")];

export type GmailConfig = { address: string; appPassword: string };

/** Payment inbox sender policy. Exact mailbox addresses only: no domain,
 * display-name, subject, or body expansion. */
export const PAYMENT_ALLOWED_SENDERS = [
  "provider.confirmation@trx-now.com",
  "accountspayable@honkforhelp.com",
  "incontrol@mastercard.com",
  "noreply@pinnacle-team.com",
] as const;

export function normalizeSenderAddress(value: string): string {
  return value.trim().toLowerCase();
}

export function isAllowedPaymentSender(value: string): boolean {
  return (PAYMENT_ALLOWED_SENDERS as readonly string[]).includes(normalizeSenderAddress(value));
}

const readEnvOrFile = async (env: string | undefined, envFile: string | undefined, stableFiles: string[]): Promise<string | null> => {
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
  for (const file of stableFiles) {
    try {
      const v = (await readFile(file, "utf8")).trim();
      if (v) return v;
    } catch { /* try the next candidate */ }
  }
  return null;
};

/** Resolve the owner's Gmail IMAP credentials. Throws a clear, structured
 *  error when any part is missing — callers surface it as gmail_not_configured,
 *  never a fake success. Resolution order (first hit wins):
 *  GMAIL_ADDRESS/GMAIL_APP_PASSWORD env → *_FILE env → <site-parent>/.secrets/
 *  gmail-* → <site-root>/dist/.secrets/gmail-* → <site-root>/.secrets/gmail-*.
 *  Hermetic tests pass a nonexistent stableDir to simulate "not configured";
 *  the artifact fallback is skipped whenever a stableDir override is pinned
 *  (unless the caller opts in with allowArtifactFallback), so a test can never
 *  accidentally resolve the real production creds. */
export async function loadGmailConfig(env: NodeJS.ProcessEnv = process.env, opts: { stableDir?: string; allowArtifactFallback?: boolean } = {}): Promise<GmailConfig> {
  const stableDir = opts.stableDir ?? STABLE_DIR;
  const fallbackDirs = opts.stableDir && !opts.allowArtifactFallback ? [] : ARTIFACT_DIRS;
  const filesFor = (name: string) => [join(stableDir, name), ...fallbackDirs.map((dir) => join(dir, name))];
  const [address, appPassword] = await Promise.all([
    readEnvOrFile(env.GMAIL_ADDRESS, env.GMAIL_ADDRESS_FILE, filesFor("gmail-address")),
    readEnvOrFile(env.GMAIL_APP_PASSWORD, env.GMAIL_APP_PASSWORD_FILE, filesFor("gmail-app-password")),
  ]);
  const missing: string[] = [];
  if (!address) missing.push("gmail-address");
  if (!appPassword) missing.push("gmail-app-password");
  if (missing.length) {
    const envNames = missing.map((m) => (m === "gmail-address" ? "GMAIL_ADDRESS" : "GMAIL_APP_PASSWORD")).join(", ");
    throw new Error(`Gmail scanning is not configured — the site secrets are missing ${missing.join(" and ")}. Missing env: ${envNames}.`);
  }
  return { address: address!, appPassword: appPassword! };
}

/* ------------------------------- club matching ------------------------------- */

/** Motor clubs the owner does business with (owner spec 2026-08-11). A message
 *  is treated as club mail when its from-domain or visible text mentions one of
 *  these brands (or their known dispatch/payment domains). Extend here as the
 *  owner adds clubs. */
export const MOTOR_CLUBS: Array<{ name: string; keywords: string[] }> = [
  { name: "Allied Dispatch", keywords: ["allied"] },
  { name: "Honk", keywords: ["honk"] },
  { name: "Allstate", keywords: ["allstate"] },
];

/** Match the sender's domain + subject/body text against the known clubs.
 *  Returns the club name or null. */
export function detectClub(from: string, subject: string, bodyText: string): string | null {
  const haystack = `${from} ${subject} ${bodyText}`.toLowerCase();
  for (const club of MOTOR_CLUBS) {
    if (club.keywords.some((k) => haystack.includes(k))) return club.name;
  }
  return null;
}

/* --------------------------------- parsing --------------------------------- */

export type ParsedClubCharge = {
  amountCents: number | null;
  cardLast4: string | null;
  /** Card brand best-effort from the email text ("Visa"/"Mastercard"/"Amex"/
   *  "Discover") — a display hint so the owner knows which card to enter. */
  cardBrand: string | null;
  /** Card expiry best-effort from the email text, normalized to MM/YY (e.g.
   *  "12/27") — display hint only, never used to charge. */
  cardExpiry: string | null;
  /** Card billing zip best-effort from the email text (e.g. "06606"). */
  cardBillingZip: string | null;
  clubName: string | null;
  poRef: string | null;
  /** Set when the message was recognized as club mail but is not a parseable
   *  charge notification (e.g. no dollar amount). Skipped, never a crash. */
  skipReason?: string;
};

const CURRENCY_AMOUNT = /(?:USD|US\$|\$)\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/i;
const PLAIN_AMOUNT = /\b(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\b/;
/** Charge semantics — a plain (currency-less) amount is only trusted when the
 *  message is clearly a charge notification ("20% off" must never stage as
 *  $20.00). Only POSITIVE charge language counts ("charge"/"no charge" is NOT
 *  a charge — see the negative guard below). */
const CHARGE_KEYWORD = /\b(charged|payment|paid|invoice|debit|transaction|billed|authoriz(?:ed|ation)|processed|purchas(?:e|ed))\b/i;
/** A message that says a charge did NOT happen must never stage. */
const NOT_A_CHARGE = /\b(no charge|not charged|free|complimentary|no payment due|refund)\b/i;
/** Card last-4 hint: "ending in 4242", "xxxx 4242", "****4242",
 *  "card ending 4242", "last 4 digits 4242". The hint WORDS are mandatory —
 *  a bare 4-digit run ("$0.20", "Ref# 1134", an order number) is NEVER a card
 *  (owner 2026-08-13: only actual card information may be scanned for). */
const LAST4 = /(?:ending(?: in| with)?|xxxx|last 4(?: digits)?|\*\*\*\*)\s*:?\s*(\d{4})/i;
/** Last-4 shown as "Card #: 9498" / "Card Number: 9498" (a bare 4-digit
 *  display, NOT a full PAN — the negative lookahead rejects any digit-group
 *  continuation, so "Card Number: 4242 4242 4242 4242" is left to PAN_GROUPED). */
const CARD_LAST4_MARKER = /card\s*(?:#|no\.?|number)?\s*:?\s*(\d{4})(?![\s-]?\d)/i;
/** Full-PAN fallback for last-4: PO emails often carry the complete card
 *  number ("Card Number: 4242 4242 4242 4242" or "4111-1111-1111-1111").
 *  Grouped-4 format first (unambiguous), then a plain 15-16 digit run. A PAN
 *  only counts when it PASSES the Luhn check (luhnValid) — order numbers,
 *  phone numbers and random 16-digit runs fail Luhn and are never taken.
 *  Only the LAST 4 digits are ever extracted/stored — never the PAN. */
const PAN_GROUPED = /\b(\d{4})[\s-](\d{4})[\s-](\d{4})[\s-](\d{4})\b/;
const PAN_FLAT = /\b\d{15,16}\b/;
/** Luhn checksum — the standard card-number validity check. Used to reject
 *  non-card 15-16 digit runs (order numbers, phone numbers, random digits)
 *  before their last 4 could ever be staged as a card. */
export function luhnValid(digits: string): boolean {
  const clean = digits.replace(/[\s-]/g, "");
  if (!/^\d{12,19}$/.test(clean)) return false;
  let sum = 0;
  let double = false;
  for (let i = clean.length - 1; i >= 0; i--) {
    let d = clean.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}
/** Extract the card's last 4 from a message, or null when NO real card is
 *  present. Priority: a Luhn-valid full PAN (grouped, then flat) is the most
 *  authoritative source; card-context last-4 hints ("ending in 4242", "xxxx
 *  4242", "Card #: 4242") come next. A bare 4-digit run with no card context
 *  never counts (owner 2026-08-13). */
function extractCardLast4(text: string): string | null {
  const grouped = text.match(PAN_GROUPED);
  if (grouped) {
    const pan = grouped.slice(1).join("");
    if (luhnValid(pan)) return pan.slice(-4);
  }
  const flat = text.match(PAN_FLAT);
  if (flat && luhnValid(flat[0])) return flat[0].slice(-4);
  const hint = text.match(LAST4);
  if (hint) return hint[1];
  const marker = text.match(CARD_LAST4_MARKER);
  if (marker) return marker[1];
  return null;
}
/** Card brand words in the email ("Visa", "Mastercard", "American Express",
 *  "Amex", "Discover"). Normalized display names via CARD_BRAND_NAMES. */
const CARD_BRAND = /\b(visa|master\s?card|amex|american\s?express|discover)\b/i;
const CARD_BRAND_NAMES: Record<string, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  "master card": "Mastercard",
  amex: "Amex",
  "american express": "Amex",
  discover: "Discover",
};
/** Card expiry: "exp 12/27", "expires 01/2028", "valid thru 12/27",
 *  "good through 12/27". Tightened 2026-08-13 (owner): ONLY plausible card
 *  expiries match — months 01-12 and years in the 2020s/2030s (2-digit 20-39
 *  or 4-digit 2020-2039). "expires 08/16" (a promo date) must NOT parse.
 *  Normalized to MM/YY. */
const CARD_EXPIRY = /(?:exp(?:iry|ires|iration)?|valid\s*(?:thru|through)|good\s*(?:thru|through))\s*:?\s*((?:0[1-9]|1[0-2]))\s*[/\-.]\s*((?:202[0-9]|203[0-9])|[23][0-9])\b/i;
/** Billing zip: "billing zip 06606", "zip code: 06606", "postal code 06606",
 *  "billing postal code 06606-1234" → first 5 digits. */
const CARD_BILLING_ZIP = /(?:billing\s*)?(?:zip(?:\s*code)?|postal(?:\s*code)?)\s*:?\s*(\d{5}(?:-\d{4})?)/i;
/** Purchase-order / job reference: "PO #12345", "PO#12345", "purchase order
 *  12345", "job #12345", "reference #12345" (also "order #12345"). */
const PO_REF = /(?:p\.?\s?o\.?|purchase order|po number|job|reference|order)\s*#?\s*:?\s*(\d{4,12})/i;

function toCents(n: string | undefined): number | null {
  if (n == null) return null;
  const v = Number(n.replace(/,/g, ""));
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.round(v * 100);
}

/** Normalize a raw card-brand match to the display name, or null. */
function normalizeBrand(raw: string | null): string | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase().replace(/\s+/g, " ");
  return CARD_BRAND_NAMES[key] ?? null;
}

/** Normalize a raw expiry match ("12/27", "1/2028", "12-27") to MM/YY.
 *  Rejects anything outside plausible card expiries (months 1-12, years
 *  2020-2039) — the regex already constrains, this is belt-and-suspenders. */
function normalizeExpiry(month: string, year: string): string | null {
  const mm = Number(month);
  const yyRaw = Number(year);
  if (!Number.isInteger(mm) || mm < 1 || mm > 12 || !Number.isInteger(yyRaw)) return null;
  let yy = yyRaw;
  if (yyRaw >= 100) yy = yyRaw % 100; // 2028 → 28
  if (yy < 20 || yy > 39) return null; // only 2020s/2030s are plausible card expiries
  return `${String(mm).padStart(2, "0")}/${String(yy).padStart(2, "0")}`;
}

/** Skip-reason constants — the scan UI surfaces these verbatim so the owner
 *  knows why a message was NOT staged (owner 2026-08-13: junk staged rows
 *  must stop; only real motor-club payment notifications with a real card
 *  may be staged). */
export const SKIP_NOT_CLUB = "not a motor-club payment notification";
export const SKIP_NO_CARD = "no valid card in email (Luhn check failed)";
export const SKIP_NO_AMOUNT = "no charge amount found (not a charge notification)";
export const SKIP_NOT_CHARGE = "message says no charge/free/refund — not a charge notification";

/** Parse a message's visible text into a club-charge candidate. PURE — no I/O,
 *  no side effects. A candidate is produced ONLY when ALL THREE hold
 *  (owner 2026-08-13):
 *    1. clubName resolves to a known motor club (Allied / Honk / Allstate),
 *    2. a real charge amount is present,
 *    3. a REAL card is present — a card-context last-4 hint ("ending in 4242",
 *       "xxxx 4242", "Card #: 4242", …) or a full PAN that PASSES the Luhn
 *       check.
 *  Everything else returns a specific skipReason and is NEVER staged — a
 *  marketing/spam email with a dollar amount and no club, or a club email
 *  without a card, must not become an "unknown charge". Card metadata
 *  (brand/expiry/zip) is parsed for DISPLAY only — the full PAN never leaves
 *  this function. */
export function parseClubChargeEmail(input: { from: string; subject: string; bodyText: string }): ParsedClubCharge {
  const { from, subject, bodyText } = input;
  const clubName = detectClub(from, subject, bodyText);
  const text = `${subject}\n${bodyText}`;
  const base = { amountCents: null as number | null, cardLast4: null as string | null, cardBrand: null as string | null, cardExpiry: null as string | null, cardBillingZip: null as string | null, clubName, poRef: null as string | null };
  // Gate 1 — must be a motor-club payment notification (sender/subject/body
  // mentions Allied / Honk / Allstate). A GoodRx ad, a CT filing service, an
  // HP deal or Credit-One spam all carry dollar amounts — none may stage.
  if (!clubName) {
    return { ...base, skipReason: SKIP_NOT_CLUB };
  }
  // A club message that says a charge did NOT happen must never stage.
  if (NOT_A_CHARGE.test(text)) {
    return { ...base, skipReason: SKIP_NOT_CHARGE };
  }
  // Gate 2 — a real charge amount.
  let amountCents: number | null = null;
  const cur = text.match(CURRENCY_AMOUNT);
  if (cur) {
    amountCents = toCents(cur[1]);
  } else if (CHARGE_KEYWORD.test(text)) {
    const plain = text.match(PLAIN_AMOUNT);
    if (plain) amountCents = toCents(plain[1]);
  }
  if (amountCents == null) {
    return { ...base, skipReason: SKIP_NO_AMOUNT };
  }
  // Gate 3 — a REAL card (card-context last-4 hint or Luhn-valid full PAN).
  // Only the LAST 4 digits are ever extracted/kept; bare 4-digit runs and
  // non-card 15-16 digit runs never count.
  const cardLast4 = extractCardLast4(text);
  if (!cardLast4) {
    return { ...base, skipReason: SKIP_NO_CARD };
  }
  const brandRaw = text.match(CARD_BRAND);
  const exp = text.match(CARD_EXPIRY);
  const zip = text.match(CARD_BILLING_ZIP);
  const po = text.match(PO_REF);
  return {
    amountCents,
    cardLast4,
    cardBrand: normalizeBrand(brandRaw ? brandRaw[0] : null),
    cardExpiry: exp ? normalizeExpiry(exp[1], exp[2]) : null,
    cardBillingZip: zip ? zip[1].split("-")[0] : null,
    clubName,
    poRef: po ? po[1] : null,
  };
}

/* ------------------------------- MIME helpers ------------------------------- */

/** Best-effort plain-text extraction from a raw RFC822/MIME source. Handles
 *  text/plain parts (base64 + quoted-printable) and falls back to an HTML-part
 *  tag-strip or the raw body. Never throws — the scan must survive any mailbox
 *  content. */
export function extractPlainText(source: Buffer | Uint8Array): string {
  try {
    const raw = Buffer.isBuffer(source) ? source : Buffer.from(source);
    const parts = splitMimeParts(raw);
    for (const part of parts) {
      if (/content-type:\s*text\/plain/i.test(part.headers)) {
        return decodeTransfer(part.body, part.headers).toString("utf8").replace(/\r\n/g, "\n").trim();
      }
    }
    for (const part of parts) {
      if (/content-type:\s*text\/html/i.test(part.headers)) {
        const html = decodeTransfer(part.body, part.headers).toString("utf8");
        return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
      }
    }
    const headerEnd = raw.indexOf("\r\n\r\n");
    const body = headerEnd >= 0 ? raw.subarray(headerEnd + 4) : raw;
    return decodeTransfer(body, raw.subarray(0, headerEnd >= 0 ? headerEnd : 0).toString("latin1")).toString("utf8").trim();
  } catch {
    return "";
  }
}

/** Split a raw message into MIME parts. Top-level headers are inspected for the
 *  boundary FIRST (so a boundary string mentioned in headers is never mistaken
 *  for a real delimiter); a non-multipart message yields its single
 *  headers+body part. The returned bodies are still transfer-encoded — callers
 *  decode with decodeTransfer. */
function splitMimeParts(buf: Buffer): Array<{ headers: string; body: Buffer }> {
  const headerEnd = buf.indexOf("\r\n\r\n");
  const rawHeaders = headerEnd >= 0 ? buf.subarray(0, headerEnd).toString("latin1") : "";
  const boundary = rawHeaders.match(/boundary="?([^";\r\n]+)"?/i);
  if (!boundary) {
    return headerEnd >= 0 ? [{ headers: rawHeaders, body: buf.subarray(headerEnd + 4) }] : [{ headers: "", body: buf }];
  }
  const body = headerEnd >= 0 ? buf.subarray(headerEnd + 4) : buf;
  const delim = Buffer.from(`--${boundary[1]}`);
  const out: Array<{ headers: string; body: Buffer }> = [];
  let start = 0;
  for (;;) {
    const idx = body.indexOf(delim, start);
    if (idx < 0) break;
    const after = idx + delim.length;
    // Closing delimiter (boundary + "--") terminates the multipart.
    if (body[after] === 0x2d && body[after + 1] === 0x2d) break;
    const partStart = body.indexOf("\r\n\r\n", after);
    if (partStart < 0) break;
    const next = body.indexOf(delim, partStart + 4);
    if (next < 0) break;
    const headers = body.subarray(after + 2, partStart).toString("latin1");
    const partBody = body.subarray(partStart + 4, next > 2 ? next - 2 : next);
    out.push({ headers, body: partBody });
    start = next + delim.length;
  }
  return out.length ? out : (headerEnd >= 0 ? [{ headers: rawHeaders, body: buf.subarray(headerEnd + 4) }] : [{ headers: "", body: buf }]);
}

function decodeTransfer(body: Buffer, headers: string): Buffer {
  const enc = headers.match(/content-transfer-encoding:\s*([a-z0-9-]+)/i);
  const kind = enc ? enc[1].toLowerCase() : "";
  if (kind === "base64") {
    try {
      const compact = body.toString("utf8").replace(/\s+/g, "");
      return Buffer.from(compact, "base64");
    } catch { return body; }
  }
  if (kind === "quoted-printable") {
    try {
      const s = body.toString("utf8").replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      return Buffer.from(s, "utf8");
    } catch { return body; }
  }
  return body;
}

/* ------------------------------- IMAP mailbox ------------------------------- */

export type MailEnvelope = {
  messageId: string;
  receivedAt: Date;
  from: string;
  subject: string;
  bodyText: string;
};

/** A parsed club-charge candidate carrying the email identity alongside the
 *  charge fields — this is what the scan orchestration stages from. */
export type ClubChargeCandidate = ParsedClubCharge & {
  messageId: string;
  receivedAt: Date;
  from: string;
  subject: string;
};

/** The minimal imapflow surface the scan needs — injectable so hermetic tests
 *  never open a socket. Mirrors ImapFlow's mailboxOpen/search/fetchOne/logout
 *  plus the optional batched fetch (the two-phase envelope-first scan uses it
 *  to pull every envelope in ONE round trip; a mailbox without `fetch` falls
 *  back to per-UID fetchOne — hermetic fakes may omit it). */
export type MailboxLike = {
  connect: () => Promise<void>;
  mailboxOpen: (mailbox: string) => Promise<unknown>;
  search: (criteria: unknown, options?: { uid?: boolean }) => Promise<number[]>;
  fetchOne: (uid: number, query: unknown, options?: { uid?: boolean }) => Promise<{ envelope?: MailEnvelopeLike; source?: Buffer | Uint8Array } | null>;
  /** Optional batched fetch (imapflow's async-generator `fetch`). Yields one
   *  item per message with `.uid` plus whatever the query asked for. */
  fetch?: (range: number[], query: unknown, options?: { uid?: boolean }) => AsyncIterable<{ uid?: number; envelope?: MailEnvelopeLike; source?: Buffer | Uint8Array }>;
  logout: () => Promise<void>;
};

/** The ENVELOPE structure the scan reads (imapflow parses RFC3501 ENVELOPE). */
export type MailEnvelopeLike = {
  messageId?: string;
  date?: Date;
  from?: Array<{ address?: string }>;
  subject?: string;
};

export type FetchClubMailOptions = {
  config: GmailConfig;
  sinceDays?: number;
  maxMessages?: number;
  /** Injectable mailbox factory (hermetic tests) — defaults to a real imapflow
   *  connection to imap.gmail.com:993 with the owner's app password. */
  connectImpl?: () => Promise<MailboxLike>;
  /** Optional exact sender allowlist for payment scans. Matching is trimmed and
   * case-insensitive; no domain/display-name/subject fallback is permitted. */
  allowedSenders?: readonly string[];
};

export type FetchClubMailResult = {
  ok: boolean;
  scanned: number;
  candidates: ClubChargeCandidate[];
  skipped: Array<{ messageId: string; from: string; subject: string; reason: string }>;
  error?: string;
};

/** Pull the last `sinceDays` days of mail from the owner's Gmail and parse
 *  every motor-club message into a candidate. Read-only (BODY.PEEK semantics —
 *  fetchOne without setting flags, nothing is ever marked read/deleted).
 *  Unparseable club messages are skipped with a reason; non-club mail is
 *  ignored silently. A mail-level failure (bad creds, connection) surfaces as
 *  ok:false with a structured error — never a partial-fake success. */
export async function fetchClubMail(opts: FetchClubMailOptions): Promise<FetchClubMailResult> {
  const sinceDays = opts.sinceDays ?? 14;
  const maxMessages = opts.maxMessages ?? 500;
  let client: MailboxLike | null = null;
  try {
    if (opts.connectImpl) {
      client = await opts.connectImpl();
    } else {
      const { ImapFlow } = await import("imapflow");
      client = new ImapFlow({
        host: "imap.gmail.com",
        port: 993,
        secure: true,
        auth: { user: opts.config.address, pass: opts.config.appPassword },
        logger: false, // never log credentials/content
      }) as unknown as MailboxLike;
    }
    await client.connect();
    await client.mailboxOpen("INBOX");
    const since = new Date(Date.now() - sinceDays * 86_400_000);
    const uids = await client.search({ since }, { uid: true });
    const slice = uids.slice(-maxMessages);
    const candidates: ClubChargeCandidate[] = [];
    const skipped: FetchClubMailResult["skipped"] = [];
    const allowed = opts.allowedSenders ? new Set(opts.allowedSenders.map(normalizeSenderAddress)) : null;
    for (const uid of slice) {
      // NOTE: imapflow's fetchOne takes `{ uid: true }` as the THIRD options arg —
      // passing the UID without it fetches by SEQUENCE number (imapflow quirk
      // burned the first survey; verified 2026-08-12 against the live mailbox).
      const raw = await client.fetchOne(uid, { envelope: true, source: true }, { uid: true });
      if (!raw) continue;
      const env = raw.envelope ?? {};
      const fromAddr = (env.from && env.from[0] && env.from[0].address) || "";
      const subject = env.subject ?? "";
      const messageId = env.messageId && env.messageId !== "" ? env.messageId : `uid-${uid}`;
      if (allowed && !allowed.has(normalizeSenderAddress(fromAddr))) {
        skipped.push({ messageId, from: fromAddr, subject, reason: "sender is not on the exact payment allowlist" });
        continue;
      }
      const bodyText = raw.source ? extractPlainText(raw.source) : "";
      const parsed = parseClubChargeEmail({ from: fromAddr, subject, bodyText });
      if (parsed.skipReason) {
        skipped.push({ messageId, from: fromAddr, subject, reason: parsed.skipReason });
        continue;
      }
      candidates.push({ ...parsed, messageId, receivedAt: env.date ?? new Date(), from: fromAddr, subject });
    }
    return { ok: true, scanned: slice.length, candidates, skipped };
  } catch (err) {
    return { ok: false, scanned: 0, candidates: [], skipped: [], error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (client) {
      try { await client.logout(); } catch { /* best-effort close */ }
    }
  }
}

/** Convenience: resolve config + scan in one call (used by the scan
 *  orchestration core). */
export async function scanGmail(opts: { sinceDays?: number; maxMessages?: number; connectImpl?: () => Promise<MailboxLike>; stableDir?: string; allowedSenders?: readonly string[] } = {}): Promise<FetchClubMailResult> {
  const config = await loadGmailConfig(process.env, { stableDir: opts.stableDir });
  return fetchClubMail({ config, sinceDays: opts.sinceDays, maxMessages: opts.maxMessages, connectImpl: opts.connectImpl, allowedSenders: opts.allowedSenders });
}

/* ------------------------- generic envelope fetch ------------------------- */

/** A fetched message's raw parts — the SHARED Gmail scan surface the payment
 *  engine and the damage-claims agent both build on (owner mandate 2026-08-12:
 *  "the same Gmail scan infrastructure" — build it ONCE, share it). */
export type MailEnvelopeWithSource = MailEnvelope & {
  /** Best-effort raw headers (joined, for reply-to/return-path lookups). Empty
   *  when the message's full source was NOT fetched (filtered policy non-hit). */
  rawHeaders: string;
  /** Best-effort raw body bytes (MIME). Null when the message's full source
   *  was NOT fetched (filtered policy non-hit). */
  rawSource: Buffer | null;
};

export type FetchMailEnvelopesOptions = {
  config: GmailConfig;
  sinceDays?: number;
  maxMessages?: number;
  connectImpl?: () => Promise<MailboxLike>;
  /** "filtered" (default): TWO-PHASE scan — fetch envelopes ONLY for every UID
   *  in one batched call, then fetch the full source ONLY for messages that
   *  pass the liberal claim/club pre-filter (mailNeedsFullSource). Non-hits
   *  come back with bodyText:"" and no rawSource. "all": fetch full source for
   *  every message (the pre-optimization behavior — escape hatch). */
  bodyPolicy?: "all" | "filtered";
};

export type FetchMailEnvelopesResult = {
  ok: boolean;
  scanned: number;
  messages: MailEnvelopeWithSource[];
  error?: string;
};

/* ------------------------- two-phase pre-filter ------------------------- */

/** LIBERAL pre-filter for the two-phase scan — decides whether a message's
 *  FULL SOURCE is worth fetching. Union of:
 *   - claim signals: claim-company domains/keywords (Agero, Sixt, … from
 *     CLAIM_COMPANIES) + damage-claim language on the subject (CLAIM_PHRASES)
 *   - club signals: MOTOR_CLUBS (Allied/Honk/Allstate) — the payment engine
 *     consumes club mail for card info, so club mail MUST stay in the
 *     full-fetch set.
 *  Tested against from-domain + subject ONLY (no body yet — body keywords
 *  would defeat the purpose of the fast phase). Deliberately liberal: a few
 *  extra full fetches are cheap; a MISSED claim/club email is not. */
export function mailNeedsFullSource(from: string, subject: string): boolean {
  const hay = `${from} ${subject}`.toLowerCase();
  for (const club of MOTOR_CLUBS) {
    if (club.keywords.some((k) => hay.includes(k))) return true;
  }
  for (const c of CLAIM_COMPANIES) {
    if (c.keywords.some((k) => hay.includes(k))) return true;
  }
  return CLAIM_PHRASES.some((re) => re.test(subject));
}

/** Decode RFC2047 encoded-words ("=?utf-8?B?...?=" / "=?utf-8?Q?...?=") —
 *  best-effort; malformed words are left as-is. Only used when a mailbox
 *  returns no ENVELOPE and we must parse headers from raw source. */
function decodeRfc2047(s: string): string {
  return s.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, _cs, enc, body: string) => {
    try {
      if (enc.toLowerCase() === "b") return Buffer.from(body, "base64").toString("utf8");
      const qp = body.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
      return Buffer.from(qp, "latin1").toString("utf8");
    } catch {
      return body;
    }
  });
}

/** Fallback envelope extraction from raw RFC822 source (for mailboxes that
 *  ignore the envelope fetch query and always return the full message). */
function parseEnvelopeFromSource(source: Buffer | Uint8Array): { messageId?: string; date?: Date; from?: string; subject?: string } | null {
  try {
    const buf = Buffer.isBuffer(source) ? source : Buffer.from(source);
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd < 0) return null;
    const headers = buf.subarray(0, headerEnd).toString("latin1");
    const get = (name: string): string | null => {
      const m = headers.match(new RegExp(`^${name}:\\s*(.*)$`, "im"));
      if (!m) return null;
      return m[1].replace(/\r?\n\s+/g, " ").trim();
    };
    const fromRaw = get("From");
    const from = fromRaw ? (fromRaw.match(/<([^>]+)>/)?.[1] ?? fromRaw) : undefined;
    const subjectRaw = get("Subject");
    const dateRaw = get("Date");
    return {
      messageId: get("Message-ID") ?? undefined,
      date: dateRaw ? new Date(dateRaw) : undefined,
      from,
      subject: subjectRaw ? decodeRfc2047(subjectRaw) : undefined,
    };
  } catch {
    return null;
  }
}

/** Pull the last `sinceDays` days of mail from the owner's Gmail as raw
 *  envelopes (from/subject/date/bodyText/rawHeaders/rawSource). Read-only
 *  (BODY.PEEK semantics — nothing is ever marked read/deleted). Returns the
 *  NEWEST `maxMessages` messages. This is the generic scan; parsing/filtering
 *  is client-side (the claim agent and the payment engine each run their own
 *  pure detectors over the result). A connection-level failure surfaces as
 *  ok:false — never a fake success.
 *
 *  TWO-PHASE (default "filtered" policy): phase 1 fetches envelopes ONLY for
 *  every UID in ONE batched call (the expensive part — ~300 full-body
 *  downloads — is removed); phase 2 fetches the full source ONLY for
 *  pre-filter hits. Non-hits keep their envelope but get bodyText:"" and
 *  rawSource:null, so detectors that only need from/subject still see every
 *  scanned message. A mailbox that lacks a batched `fetch` (or that always
 *  returns full fetches from fetchOne) is tolerated: per-UID envelope fetches,
 *  and header parsing from whatever source comes back. */
export async function fetchMailEnvelopes(opts: FetchMailEnvelopesOptions): Promise<FetchMailEnvelopesResult> {
  const sinceDays = opts.sinceDays ?? 14;
  const maxMessages = opts.maxMessages ?? 300;
  const bodyPolicy = opts.bodyPolicy ?? "filtered";
  let client: MailboxLike | null = null;
  try {
    if (opts.connectImpl) {
      client = await opts.connectImpl();
    } else {
      const { ImapFlow } = await import("imapflow");
      client = new ImapFlow({
        host: "imap.gmail.com",
        port: 993,
        secure: true,
        auth: { user: opts.config.address, pass: opts.config.appPassword },
        logger: false,
      }) as unknown as MailboxLike;
    }
    await client.connect();
    await client.mailboxOpen("INBOX");
    const since = new Date(Date.now() - sinceDays * 86_400_000);
    const uids = await client.search({ since }, { uid: true });
    const slice = uids.slice(-maxMessages);
    /* PHASE 1 — envelopes ONLY, batched: from/subject/date for every UID in
     * one round trip (no source -> no body download). */
    const envelopes = new Map<number, { from: string; subject: string; date: Date | null; messageId: string }>();
    if (slice.length && typeof client.fetch === "function") {
      for await (const item of client.fetch(slice, { envelope: true }, { uid: true })) {
        if (!item || item.uid == null) continue;
        const env = item.envelope ?? {};
        const fromAddr = (env.from && env.from[0] && env.from[0].address) || "";
        const subject = env.subject ?? "";
        const messageId = env.messageId && env.messageId !== "" ? env.messageId : `uid-${item.uid}`;
        envelopes.set(item.uid, { from: fromAddr, subject, date: env.date ?? null, messageId });
      }
    } else {
      for (const uid of slice) {
        // NOTE: imapflow's fetchOne takes `{ uid: true }` as the THIRD options
        // arg — passing the UID without it fetches by SEQUENCE number (imapflow
        // quirk burned the first survey; verified 2026-08-12 against the live
        // mailbox).
        const raw = await client.fetchOne(uid, { envelope: true }, { uid: true });
        if (!raw) continue;
        const env = raw.envelope ?? {};
        const fromAddr = (env.from && env.from[0] && env.from[0].address) || "";
        const subject = env.subject ?? "";
        const messageId = env.messageId && env.messageId !== "" ? env.messageId : `uid-${uid}`;
        envelopes.set(uid, { from: fromAddr, subject, date: env.date ?? null, messageId });
      }
    }
    // Tolerate a mailbox that always returns full fetches / ignores the
    // envelope query: recover the envelope from whatever fetchOne returned.
    if (envelopes.size < slice.length) {
      for (const uid of slice) {
        if (envelopes.has(uid)) continue;
        const raw = await client.fetchOne(uid, { envelope: true }, { uid: true });
        if (!raw) continue;
        const env = raw.envelope ?? {};
        if (env.subject != null || env.messageId != null || env.date != null) {
          const fromAddr = (env.from && env.from[0] && env.from[0].address) || "";
          envelopes.set(uid, { from: fromAddr, subject: env.subject ?? "", date: env.date ?? null, messageId: env.messageId && env.messageId !== "" ? env.messageId : `uid-${uid}` });
          continue;
        }
        if (raw.source) {
          const parsed = parseEnvelopeFromSource(raw.source);
          if (parsed) {
            envelopes.set(uid, { from: parsed.from ?? "", subject: parsed.subject ?? "", date: parsed.date ?? null, messageId: parsed.messageId && parsed.messageId !== "" ? parsed.messageId : `uid-${uid}` });
          }
        }
      }
    }
    /* PHASE 2 — full source ONLY for pre-filter hits. */
    const messages: MailEnvelopeWithSource[] = [];
    for (const uid of slice) {
      const e = envelopes.get(uid);
      if (!e) continue;
      const needsSource = bodyPolicy === "all" || mailNeedsFullSource(e.from, e.subject);
      let bodyText = "";
      let rawHeaders = "";
      let rawSource: Buffer | null = null;
      if (needsSource) {
        const raw = await client.fetchOne(uid, { envelope: true, source: true }, { uid: true });
        if (raw?.source) {
          rawSource = Buffer.from(raw.source);
          const headerEnd = rawSource.indexOf("\r\n\r\n");
          rawHeaders = headerEnd >= 0 ? rawSource.subarray(0, headerEnd).toString("utf8") : "";
          bodyText = extractPlainText(rawSource);
        }
      }
      messages.push({ messageId: e.messageId, receivedAt: e.date ?? new Date(), from: e.from, subject: e.subject, bodyText, rawHeaders, rawSource });
    }
    return { ok: true, scanned: slice.length, messages };
  } catch (err) {
    return { ok: false, scanned: 0, messages: [], error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (client) {
      try { await client.logout(); } catch { /* best-effort close */ }
    }
  }
}

/** Convenience: resolve config + generic scan in one call. */
export async function scanMailEnvelopes(opts: { sinceDays?: number; maxMessages?: number; connectImpl?: () => Promise<MailboxLike>; stableDir?: string; bodyPolicy?: "all" | "filtered" } = {}): Promise<FetchMailEnvelopesResult> {
  const config = await loadGmailConfig(process.env, { stableDir: opts.stableDir });
  return fetchMailEnvelopes({ config, sinceDays: opts.sinceDays, maxMessages: opts.maxMessages, connectImpl: opts.connectImpl, bodyPolicy: opts.bodyPolicy });
}
