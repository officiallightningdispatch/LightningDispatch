// DB safety (2026-08-12): org deletes guarded by assertQaOrg — see src/data/db-guard.ts + /home/team/shared/db-safety-rules.md.
// Hermetic payment-engine tests (2026-08-11, PER-PO CARD rework 2026-08-12).
// Owner spec: "an agent scans lightroad29@gmail.com for motor-club credit-card
// information and processes those cards via the Square API without ever
// transferring funds out". Owner correction 2026-08-12: clubs provide ONE CARD
// PER PO — the per-club card-on-file model (motor_club_cards) is DROPPED.
//
// This suite covers: the Gmail scanner (imapflow surface mocked with a fake
// mailbox — canned Allied Dispatch / Honk / Allstate card-charge emails with
// PER-PO card details + one junk email), parseClubChargeEmail pure parsing
// (amount/last4 + brand/expiry/billing-zip from the PO email; full-PAN shape
// yields last4 only, never the PAN), staging with each row's OWN card metadata
// (dry-run writes nothing; real scan stages; re-scan never double-stages via
// the (org, source_email_message_id) unique index), the owner/admin ledger
// read (newest first), chargeStagedCore through the OWNER's Square account
// (mock POST /v2/payments verifying the Bearer auth header from the secret,
// idempotency key club-<txnId>-<attempt>, amount, currency, source_id = the
// Web Payments NONCE, location_id; success + 400 + network-blip paths; the
// nonce is REQUIRED — a row without one surfaces square_source_missing and
// NEVER auto-resolves from a stored per-club card), the tip mirror into
// payment_transactions (kind='tip', idempotent), role gates (contractor denied
// everywhere), and the approval gate (scan/stage NEVER charge — only an
// explicit per-row Charge with a fresh nonce does; markChargedOutsideCore
// records a charge the owner made in their own Square dashboard).
//
// motor_club_cards is provably DEAD: no test reads or writes it, and a legacy
// stored card for a club NEVER auto-charges a staged row (proof section 14).
//
// Real network calls never happen: Square takes an injectable fetchImpl,
// Gmail takes an injectable connectImpl (fake IMAP mailbox). DB-backed against
// throwaway QA orgs (emails qa-*-<tag>@lightning.test — never touches real
// lightroad29 data), deleted at the end (zero rows left anywhere).
//   DATABASE_URL=... bun payment-engine.test.mjs
import { randomUUID } from "node:crypto";
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL);
const { ensureSchema } = await import("./src/data/migrations.ts");
const {
  parseClubChargeEmail,
  detectClub,
  extractPlainText,
  loadGmailConfig,
  luhnValid,
  SKIP_NOT_CLUB,
  SKIP_NO_CARD,
  SKIP_NO_AMOUNT,
  SKIP_NOT_CHARGE,
} = await import("./src/data/club-mail.ts");
const {
  stageClubChargeCore,
  listStagedChargesCore,
  chargeStagedCore,
  markChargedOutsideCore,
  scanClubMailCore,
  mirrorTipCore,
  listTipsCore,
  getPaymentSquareConfigCore,
} = await import("./src/data/payment-engine-core.ts");
const { assertQaOrg } = await import("./src/data/db-guard.ts");
const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, Boolean(cond), extra]);
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
};

const TAG = randomUUID().slice(0, 8);
const ORG = `qa-payment-${TAG}`;    // full scan → stage → charge → mirror flow
const ORG2 = `qa-payment2-${TAG}`;  // cross-org rails (charge/scan scope)
const ORG3 = `qa-payment3-${TAG}`;  // real-Honk-email regression scan (1 row)
const OWNER = `qa-payment-owner-${TAG}`;
const OWNER2 = `qa-payment2-owner-${TAG}`;
const OWNER3 = `qa-payment3-owner-${TAG}`;
const ADMIN = `qa-payment-admin-${TAG}`;
const CONTRACTOR = `qa-payment-driver-${TAG}`;
const DRIVER = `qa-payment-driver2-${TAG}`; // completion_tips driver fixture
const ACTOR = { orgId: ORG, id: OWNER, role: "owner" };
const ACTOR3 = { orgId: ORG3, id: OWNER3, role: "owner" };
const ADMIN_ACTOR = { orgId: ORG, id: ADMIN, role: "admin" };
const WRONG_ACTOR = { orgId: ORG, id: CONTRACTOR, role: "contractor" };
const OTHER_ACTOR = { orgId: ORG2, id: OWNER2, role: "owner" };

/* ------------------------------ canned emails ------------------------------ */
// Each club charge notification carries THAT PO's own card (brand/last4/expiry/
// billing zip — the per-PO card model). Allstate uses a full-PAN shape to prove
// only the last 4 is ever extracted.

const MAIL = [
  {
    messageId: `allied-${TAG}@mail.gmail.com`,
    from: "billing@allieddispatch.com",
    subject: "Allied Dispatch Payment — PO #88231",
    body: "Your Visa ending in 4242 was charged $85.00 for PO #88231. Expiry 12/27. Billing zip 06606.",
  },
  {
    messageId: `honk-${TAG}@mail.gmail.com`,
    from: "no-reply@honkmobile.com",
    subject: "Honk Invoice Paid",
    body: "Payment of USD 129.50 received for order #5532. Card ending 1010 (Mastercard), exp 05/28, zip 60601.",
  },
  {
    messageId: `allstate-${TAG}@mail.gmail.com`,
    from: "motorclub@allstate.com",
    subject: "Allstate Motor Club — Charge Notification",
    body: "Your card xxxx 7788 was charged $45.25. Purchase order 441233. Card Number: 3714 496353 77887. American Express, good thru 09/26, billing zip 90210.",
  },
  {
    messageId: `junk-${TAG}@somewhere.com`,
    from: "newsletter@somewhere.com",
    subject: "Weekly deals",
    body: "Save up to 20% this week — no charge, just savings!",
  },
];

/** The REAL Honk payment email that was staged in production (2026-08-13):
 *  subject "Your payment from HONK - Ref# 11343871391", $49.00, card ending
 *  9498. CRITICAL regression: this MUST keep staging with clubName "Honk" and
 *  cardLast4 "9498" — and the "Ref# 1134…" run must never be mistaken for a
 *  card (bare 4-digit run, no card context). */
const HONK_REAL = {
  messageId: `honk-real-${TAG}@mail.gmail.com`,
  from: "no-reply@honkmobile.com",
  subject: "Your payment from HONK - Ref# 11343871391",
  body: "Payment of $49.00 received for Ref# 11343871391. Your card ending in 9498 was used. Thanks for choosing HONK!",
};

const rawMessage = (m) => Buffer.from(
  `From: ${m.from}\r\nTo: owner@lightning.test\r\nSubject: ${m.subject}\r\nDate: Tue, 11 Aug 2026 10:00:00 +0000\r\nMessage-ID: <${m.messageId}>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${m.body}`,
  "utf8",
);

/** Fake IMAP mailbox over ANY canned message list — records search/fetch
 *  calls and never opens a socket. */
function makeMailboxFor(messages) {
  const calls = [];
  const uids = messages.map((_, i) => i + 1);
  const mailbox = {
    async connect() {},
    async mailboxOpen(name) { calls.push({ op: "open", name }); },
    async search(criteria) { calls.push({ op: "search", criteria }); return [...uids]; },
    async fetchOne(uid) {
      calls.push({ op: "fetch", uid });
      const m = messages[uid - 1];
      if (!m) return null;
      return {
        envelope: { messageId: m.messageId, date: new Date("2026-08-11T10:00:00Z"), from: [{ address: m.from }], subject: m.subject },
        source: rawMessage(m),
      };
    },
    async logout() { calls.push({ op: "logout" }); },
  };
  return { mailbox, calls };
}

/** Fake IMAP mailbox over the canned MAIL fixtures (see makeMailboxFor). */
function makeMailbox() {
  return makeMailboxFor(MAIL);
}

const resp = (status, { json } = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  async text() { return json != null ? JSON.stringify(json) : ""; },
  async json() { return json != null ? JSON.parse(JSON.stringify(json)) : {}; },
});

/** Mock Square POST /v2/payments — records every call; idempotency-key →
 *  payment-id map like the real API (a replayed key returns the SAME payment).
 *  mode: 'ok' | 'fail' (400 always) | 'blip-then-ok' (first call throws, then ok). */
function makeSquare({ mode = "ok" } = {}) {
  const squareCalls = [];
  const paymentIds = new Map();
  let blipUsed = false;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    if (method === "POST" && u.startsWith("https://connect.squareup.com/v2/payments")) {
      const body = JSON.parse(String(init.body));
      squareCalls.push({ url: u, method, body, headers: init.headers });
      if (mode === "blip-then-ok" && !blipUsed) {
        blipUsed = true;
        throw new Error("fetch failed: connection reset");
      }
      if (mode === "fail") {
        return resp(400, { json: { errors: [{ code: "CARD_DECLINED", detail: "The card was declined." }] } });
      }
      if (!paymentIds.has(body.idempotency_key)) paymentIds.set(body.idempotency_key, `pymt_club_${paymentIds.size + 1}`);
      const paymentId = paymentIds.get(body.idempotency_key);
      return resp(200, { json: { payment: { id: paymentId, status: "COMPLETED", receipt_url: `https://square.link/receipt/${paymentId}` } } });
    }
    throw new Error(`unexpected call: ${method} ${u}`);
  };
  return { fetchImpl, squareCalls, paymentIds };
}

/* --------------------------------- setup --------------------------------- */

async function setup() {
  await ensureSchema();
  for (const [org, owner] of [[ORG, OWNER], [ORG2, OWNER2], [ORG3, OWNER3]]) {
    await q`INSERT INTO organizations(id, name) VALUES(${org}, 'qa payment')`;
    await q`INSERT INTO users(id, name, email, password_hash) VALUES(${owner}, 'QA Payment Owner', ${`qa-payment-owner-${randomUUID()}@lightning.test`}, 'x')`;
    await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${org}, ${owner}, 'owner')`;
  }
  await q`INSERT INTO users(id, name, email, password_hash) VALUES(${ADMIN}, 'QA Payment Admin', ${`qa-payment-admin-${randomUUID()}@lightning.test`}, 'x')`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${ADMIN}, 'admin')`;
  await q`INSERT INTO users(id, name, email, password_hash) VALUES(${CONTRACTOR}, 'QA Payment Driver', ${`qa-payment-driver-${randomUUID()}@lightning.test`}, 'x')`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${CONTRACTOR}, 'contractor')`;
  await q`INSERT INTO users(id, name, email, password_hash) VALUES(${DRIVER}, 'QA Tip Driver', ${`qa-payment-driver2-${randomUUID()}@lightning.test`}, 'x')`;
  await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${ORG}, ${DRIVER}, 'contractor')`;
}

// Gmail + Square env for THIS process (env-first resolution).
process.env.GMAIL_ADDRESS = "qa-scan@lightning.test";
process.env.GMAIL_APP_PASSWORD = "qa-gmail-app-password";
process.env.SQUARE_ACCESS_TOKEN = "test-square-token";
process.env.SQUARE_LOCATION_ID = "loc_test";
process.env.SQUARE_APPLICATION_ID = "app_test";

await setup();

/* ============ 0) Gmail config + pure parsing (no DB, no IMAP) ============ */
{
  const cfg = await loadGmailConfig();
  check("env-first Gmail config", cfg.address === "qa-scan@lightning.test" && cfg.appPassword === "qa-gmail-app-password", JSON.stringify(cfg));
  const saved = { a: process.env.GMAIL_ADDRESS, p: process.env.GMAIL_APP_PASSWORD };
  delete process.env.GMAIL_ADDRESS; delete process.env.GMAIL_APP_PASSWORD;
  let threw = false;
  try { await loadGmailConfig({}, { stableDir: `/tmp/gmail-missing-${Date.now()}` }); } catch (e) { threw = String(e).includes("Gmail scanning is not configured") && String(e).includes("GMAIL_ADDRESS") && String(e).includes("GMAIL_APP_PASSWORD"); }
  check("missing Gmail creds → clear structured error", threw);
  process.env.GMAIL_ADDRESS = saved.a; process.env.GMAIL_APP_PASSWORD = saved.p;

  const allied = parseClubChargeEmail({ from: MAIL[0].from, subject: MAIL[0].subject, bodyText: MAIL[0].body });
  check("parse Allied: amount $85.00 → 8500", allied.amountCents === 8500, JSON.stringify(allied));
  check("parse Allied: last4 4242 + club + PO 88231", allied.cardLast4 === "4242" && allied.clubName === "Allied Dispatch" && allied.poRef === "88231", JSON.stringify(allied));
  check("parse Allied: OWN card metadata — Visa ••4242 exp 12/27 zip 06606", allied.cardBrand === "Visa" && allied.cardExpiry === "12/27" && allied.cardBillingZip === "06606", JSON.stringify(allied));
  const honk = parseClubChargeEmail({ from: MAIL[1].from, subject: MAIL[1].subject, bodyText: MAIL[1].body });
  check("parse Honk: USD 129.50 → 12950", honk.amountCents === 12950, JSON.stringify(honk));
  check("parse Honk: last4 1010 + club + order 5532", honk.cardLast4 === "1010" && honk.clubName === "Honk" && honk.poRef === "5532", JSON.stringify(honk));
  check("parse Honk: Mastercard exp 05/28 zip 60601", honk.cardBrand === "Mastercard" && honk.cardExpiry === "05/28" && honk.cardBillingZip === "60601", JSON.stringify(honk));
  const allstate = parseClubChargeEmail({ from: MAIL[2].from, subject: MAIL[2].subject, bodyText: MAIL[2].body });
  check("parse Allstate: $45.25 → 4525", allstate.amountCents === 4525, JSON.stringify(allstate));
  check("parse Allstate: last4 7788 + club + PO 441233", allstate.cardLast4 === "7788" && allstate.clubName === "Allstate" && allstate.poRef === "441233", JSON.stringify(allstate));
  check("parse Allstate: Amex good thru 09/26 zip 90210 (full-PAN shape → last4 only)", allstate.cardBrand === "Amex" && allstate.cardExpiry === "09/26" && allstate.cardBillingZip === "90210" && allstate.cardLast4 === "7788", JSON.stringify(allstate));
  check("parse Allstate: the FULL PAN never leaves the parser", !JSON.stringify(allstate).includes("371449635377887") && !JSON.stringify(allstate).includes("3714"), JSON.stringify(allstate));
  const junk = parseClubChargeEmail({ from: MAIL[3].from, subject: MAIL[3].subject, bodyText: MAIL[3].body });
  check("parse junk: skipped with reason (never a fake charge)", junk.skipReason != null && junk.amountCents === null, JSON.stringify(junk));
  check("detectClub null for non-club mail", detectClub("newsletter@somewhere.com", "deals", "save money") === null);
  check("detectClub case-insensitive keyword", detectClub("ops@ALLIEDDISPATCH.com", "x", "y") === "Allied Dispatch");
  const txt = extractPlainText(rawMessage(MAIL[0]));
  check("extractPlainText pulls the body", txt.includes("charged $85.00"), JSON.stringify(txt));

  /* ---- owner 2026-08-13: only REAL motor-club payments with a REAL card ---- */
  // CRITICAL regression — the live Honk email (subject Ref# 11343871391, $49,
  // card ending 9498) must parse with club + last4; "Ref# 1134…" is a bare
  // 4-digit run and must never be taken as a card.
  const honkReal = parseClubChargeEmail({ from: HONK_REAL.from, subject: HONK_REAL.subject, bodyText: HONK_REAL.body });
  check("parse REAL Honk email: $49.00 → 4900, club Honk, last4 9498 (no skip)", honkReal.amountCents === 4900 && honkReal.clubName === "Honk" && honkReal.cardLast4 === "9498" && honkReal.skipReason == null, JSON.stringify(honkReal));
  // Marketing email WITH an amount but no club → skipped, NEVER staged.
  const goodRx = parseClubChargeEmail({ from: "news@goodrx.com", subject: "Your exclusive GoodRx Gold offer", bodyText: "Save up to $847.00 on prescriptions this year with GoodRx Gold." });
  check("parse GoodRx ad ($847) → skipped as not a motor-club payment", goodRx.skipReason === SKIP_NOT_CLUB && goodRx.clubName === null && goodRx.amountCents === null, JSON.stringify(goodRx));
  // Bill-collector spam with a card last4 but no club → skipped (club gate first).
  const creditOne = parseClubChargeEmail({ from: "collections@halstedfinancial.com", subject: "Payment Required on Overdue Credit One Account", bodyText: "Your payment of $271.20 is required immediately. Card on file ending in 4799 was declined. Please call 800-555-0199." });
  check("parse Credit-One spam ($271.20, last4 4799, NO club) → skipped, last4 never taken", creditOne.skipReason === SKIP_NOT_CLUB && creditOne.cardLast4 === null && creditOne.amountCents === null, JSON.stringify(creditOne));
  // Full PAN grouped + Luhn pass → last4 extracted (never the PAN itself).
  const panGrouped = parseClubChargeEmail({ from: "billing@allieddispatch.com", subject: "Allied Dispatch Payment — PO #11220", bodyText: "Visa 4242 4242 4242 4242 charged $112.75 for PO #11220. Exp 03/29. Billing zip 06606." });
  check("parse full PAN grouped (4242…4242, Luhn pass) → last4 4242", panGrouped.cardLast4 === "4242" && panGrouped.clubName === "Allied Dispatch" && panGrouped.amountCents === 11275 && panGrouped.skipReason == null, JSON.stringify(panGrouped));
  const panFlat = parseClubChargeEmail({ from: "billing@allieddispatch.com", subject: "Allied Dispatch Payment — PO #11221", bodyText: "Card Number: 4111111111111111 charged $33.10 for PO #11221." });
  check("parse full PAN flat (4111…1111, Luhn pass) → last4 1111", panFlat.cardLast4 === "1111" && panFlat.skipReason == null, JSON.stringify(panFlat));
  // Full PAN that FAILS Luhn (order number / phone number) → card-miss skip.
  const panBadGrouped = parseClubChargeEmail({ from: "billing@honkmobile.com", subject: "Honk Invoice Paid", bodyText: "Payment of $50.00 received for order 1234 5678 9012 3456." });
  check("parse PAN grouped Luhn FAIL (1234 5678 9012 3456) → skipped, no card", panBadGrouped.skipReason === SKIP_NO_CARD && panBadGrouped.cardLast4 === null, JSON.stringify(panBadGrouped));
  const panBadFlat = parseClubChargeEmail({ from: "billing@allstate.com", subject: "Allstate Motor Club — Charge Notification", bodyText: "Your Allstate card 9999999999999999 was charged $60.00." });
  check("parse PAN flat Luhn FAIL (9999…9999) → skipped, no card", panBadFlat.skipReason === SKIP_NO_CARD && panBadFlat.cardLast4 === null, JSON.stringify(panBadFlat));
  // Bare 4-digit run with no card context → NOT a card, card-miss skip.
  const bareRun = parseClubChargeEmail({ from: "billing@honkmobile.com", subject: "Your payment from HONK - Ref# 11343871391", bodyText: "Payment of $0.20 received for Ref# 11343871391. Total due: $0.20. No card details shown." });
  check("parse club email with amount but ONLY bare 4-digit runs ($0.20, Ref# 1134) → skipped (no card)", bareRun.skipReason === SKIP_NO_CARD && bareRun.cardLast4 === null && bareRun.amountCents === null, JSON.stringify(bareRun));
  // Promo "expires 08/16" must NOT parse as a card expiry (2020s/2030s only).
  const quillPromo = parseClubChargeEmail({ from: "offers@quill.com", subject: "Starbucks Card Promo", bodyText: "Get a $25.00 Starbucks eGift Card — promo expires 08/16. Terms apply." });
  check("parse promo email: no club → skipped (never staged)", quillPromo.skipReason === SKIP_NOT_CLUB, JSON.stringify(quillPromo));
  const expiryTight = parseClubChargeEmail({ from: "billing@allieddispatch.com", subject: "Allied Dispatch Payment — PO #11222", bodyText: "Your Visa ending in 4242 was charged $25.00 for PO #11222. Card expires 08/16. Billing zip 06606." });
  check("expiry '08/16' does NOT parse (year 16 outside 2020s/2030s)", expiryTight.cardLast4 === "4242" && expiryTight.cardExpiry === null && expiryTight.skipReason == null, JSON.stringify(expiryTight));
  // Luhn unit checks (vectors verified against standard card test numbers).
  check("luhnValid 4242424242424242 (Visa test) → true", luhnValid("4242424242424242") === true);
  check("luhnValid 4111111111111111 → true", luhnValid("4111111111111111") === true);
  check("luhnValid 378282246310005 (Amex test) → true", luhnValid("378282246310005") === true);
  check("luhnValid 4012888888881881 (Visa) → true", luhnValid("4012888888881881") === true);
  check("luhnValid 1234567890123456 → false", luhnValid("1234567890123456") === false);
  check("luhnValid 9999999999999999 → false", luhnValid("9999999999999999") === false);
  check("luhnValid rejects short/garbage input", luhnValid("1234") === false && luhnValid("abc") === false);
  // Club email with a card but NO amount → existing amount gate.
  const noAmount = parseClubChargeEmail({ from: "billing@allieddispatch.com", subject: "Allied Dispatch — statement", bodyText: "Your Visa ending in 4242 has no balance due." });
  check("parse club email with card but no amount → skipped (no charge amount)", noAmount.skipReason === SKIP_NO_AMOUNT, JSON.stringify(noAmount));
}

/* ============ 1) scan dry-run: parses, writes NOTHING ============ */
{
  const { mailbox } = makeMailbox();
  const r = await scanClubMailCore(ACTOR, { dryRun: true }, { connectImpl: async () => mailbox });
  check("dry-run ok", r.ok === true && r.dryRun === true, JSON.stringify(r));
  check("dry-run scanned 4 (all mail), 3 candidates, 1 skipped", r.scanned === 4 && r.candidates === 3 && r.skipped === 1, JSON.stringify({ scanned: r.scanned, candidates: r.candidates, skipped: r.skipped }));
  check("dry-run staged 0 / alreadyStaged 0", r.staged === 0 && r.alreadyStaged === 0, JSON.stringify(r));
  check("dry-run items carry parse data + dry_run outcome", r.items.length === 4 && r.items.filter((i) => i.outcome === "dry_run").length === 3 && r.items.filter((i) => i.outcome === "skipped").length === 1, JSON.stringify(r.items.map((i) => i.outcome)));
  const dry = r.items.find((i) => i.clubName === "Allied Dispatch");
  check("dry-run item has amount/last4/po + OWN card metadata + message id", dry && dry.amountCents === 8500 && dry.cardLast4 === "4242" && dry.cardBrand === "Visa" && dry.cardExpiry === "12/27" && dry.cardBillingZip === "06606" && dry.poRef === "88231" && dry.messageId === MAIL[0].messageId, JSON.stringify(dry));
  const count = await q`SELECT COUNT(*)::int AS n FROM payment_transactions WHERE org_id=${ORG}`;
  check("dry-run left zero rows", Number(count[0].n) === 0, JSON.stringify(count));
  const audCount = await q`SELECT COUNT(*)::int AS n FROM audit_log WHERE org_id=${ORG} AND action='payment_scan_ran'`;
  check("dry-run wrote no audit rows either (literal zero writes)", Number(audCount[0].n) === 0, JSON.stringify(audCount));
  // Scan is owner/admin only.
  const denied = await scanClubMailCore(WRONG_ACTOR, { dryRun: true }, { connectImpl: async () => (await makeMailbox()).mailbox });
  check("scan: contractor actor → error, zero writes", denied.ok === false && denied.error.includes("owner or an admin"), JSON.stringify(denied));
}

/* ============ 1b) REAL Honk email regression: scan → stage (1 row) ============ */
{
  const { mailbox } = makeMailboxFor([HONK_REAL]);
  const r = await scanClubMailCore(ACTOR3, {}, { connectImpl: async () => mailbox });
  check("real Honk scan: staged 1, skipped 0, 1 candidate", r.ok === true && r.staged === 1 && r.skipped === 0 && r.candidates === 1, JSON.stringify(r));
  const rows = await q`SELECT * FROM payment_transactions WHERE org_id=${ORG3} AND kind='club_charge'`;
  check("real Honk row staged: $49.00, club Honk, last4 9498, staged", rows.length === 1 && Number(rows[0].amount_cents) === 4900 && String(rows[0].club_name) === "Honk" && String(rows[0].card_last4) === "9498" && String(rows[0].status) === "staged" && String(rows[0].source_email_message_id) === HONK_REAL.messageId, JSON.stringify(rows[0]));
  check("Ref# 1134… never taken as a card", !rows.some((r3) => String(r3.card_last4) === "1134"), JSON.stringify(rows));
  const r2 = await scanClubMailCore(ACTOR3, {}, { connectImpl: async () => mailbox });
  check("real Honk re-scan: already_staged 1, staged 0 (idempotent)", r2.ok === true && r2.alreadyStaged === 1 && r2.staged === 0, JSON.stringify(r2));
  const count = await q`SELECT COUNT(*)::int AS n FROM payment_transactions WHERE org_id=${ORG3}`;
  check("real Honk org still exactly 1 row", Number(count[0].n) === 1, JSON.stringify(count));
}

/* ============ 2) real scan: stages 3 with PER-PO card metadata ============ */
{
  const { mailbox, calls } = makeMailbox();
  const r = await scanClubMailCore(ACTOR, {}, { connectImpl: async () => mailbox });
  check("scan ok, staged 3, skipped 1", r.ok === true && r.staged === 3 && r.skipped === 1 && r.alreadyStaged === 0, JSON.stringify(r));
  check("scan: read-only mailbox ops (open/search/fetch/logout, no writes)", calls.map((c) => c.op).join(",") === "open,search,fetch,fetch,fetch,fetch,logout", JSON.stringify(calls.map((c) => c.op)));
  const rows = await q`SELECT * FROM payment_transactions WHERE org_id=${ORG} AND kind='club_charge' ORDER BY amount_cents`;
  check("exactly 3 staged club_charge rows", rows.length === 3, JSON.stringify(rows));
  const byAmount = Object.fromEntries(rows.map((r2) => [Number(r2.amount_cents), r2]));
  check("Allied row staged with full fields + OWN card metadata", byAmount[8500] && String(byAmount[8500].status) === "staged" && String(byAmount[8500].club_name) === "Allied Dispatch" && String(byAmount[8500].card_last4) === "4242" && String(byAmount[8500].card_brand) === "Visa" && String(byAmount[8500].card_expiry) === "12/27" && String(byAmount[8500].card_billing_zip) === "06606" && String(byAmount[8500].po_ref) === "88231" && String(byAmount[8500].source_email_message_id) === MAIL[0].messageId && String(byAmount[8500].currency) === "USD" && Number(byAmount[8500].attempt) === 0 && byAmount[8500].idempotency_key == null && byAmount[8500].charge_path == null, JSON.stringify(byAmount[8500]));
  check("Honk row staged with OWN card metadata", byAmount[12950] && String(byAmount[12950].club_name) === "Honk" && String(byAmount[12950].card_last4) === "1010" && String(byAmount[12950].card_brand) === "Mastercard" && String(byAmount[12950].card_expiry) === "05/28" && String(byAmount[12950].card_billing_zip) === "60601" && String(byAmount[12950].source_email_message_id) === MAIL[1].messageId, JSON.stringify(byAmount[12950]));
  check("Allstate row staged (Amex 09/26 zip 90210)", byAmount[4525] && String(byAmount[4525].club_name) === "Allstate" && String(byAmount[4525].card_last4) === "7788" && String(byAmount[4525].card_brand) === "Amex" && String(byAmount[4525].card_expiry) === "09/26" && String(byAmount[4525].card_billing_zip) === "90210" && String(byAmount[4525].source_email_message_id) === MAIL[2].messageId, JSON.stringify(byAmount[4525]));
  const junkRows = await q`SELECT COUNT(*)::int AS n FROM payment_transactions WHERE org_id=${ORG} AND source_email_message_id=${MAIL[3].messageId}`;
  check("junk email never staged", Number(junkRows[0].n) === 0, JSON.stringify(junkRows));
  const cardCount = await q`SELECT COUNT(*)::int AS n FROM motor_club_cards WHERE org_id=${ORG}`;
  check("scan wrote NOTHING to motor_club_cards (per-PO model — no per-club cards)", Number(cardCount[0].n) === 0, JSON.stringify(cardCount));
  const aud = await q`SELECT action, detail, actor_role FROM audit_log WHERE org_id=${ORG} AND action='payment_scan_ran'`;
  check("audit payment_scan_ran (owner actor, staged 3 / skipped 1)", aud.length === 1 && String(aud[0].actor_role) === "owner" && aud[0].detail && aud[0].detail.staged === 3 && aud[0].detail.skipped === 1, JSON.stringify(aud));
}

/* ============ 3) re-scan idempotency: never double-stages ============ */
{
  const { mailbox } = makeMailbox();
  const r = await scanClubMailCore(ACTOR, {}, { connectImpl: async () => mailbox });
  check("re-scan: 0 staged, 3 already_staged", r.ok === true && r.staged === 0 && r.alreadyStaged === 3 && r.skipped === 1, JSON.stringify({ staged: r.staged, alreadyStaged: r.alreadyStaged }));
  const count = await q`SELECT COUNT(*)::int AS n FROM payment_transactions WHERE org_id=${ORG}`;
  check("still exactly 3 rows (no duplicates)", Number(count[0].n) === 3, JSON.stringify(count));
  // Cross-org: the same mailbox scanned into ORG2 stages its OWN rows.
  const r2 = await scanClubMailCore(OTHER_ACTOR, {}, { connectImpl: async () => mailbox });
  check("other org scan stages its own 3 (org-scoped idempotency)", r2.ok === true && r2.staged === 3, JSON.stringify(r2));
}

/* ============ 4) manual stage (full per-PO metadata) + duplicate + role gate ============ */
{
  const r = await stageClubChargeCore(ACTOR, { amountCents: 7500, clubName: "Allied Dispatch", cardLast4: "4242", cardBrand: "Visa", cardExpiry: "12/27", cardBillingZip: "06606", poRef: "90001", messageId: `manual-${TAG}@mail.gmail.com`, receivedAt: "2026-08-10T12:00:00Z" });
  check("manual stage ok → staged row with OWN card metadata", r.ok === true && r.data.status === "staged" && r.data.kind === "club_charge" && r.data.amountCents === 7500 && r.data.clubName === "Allied Dispatch" && r.data.cardLast4 === "4242" && r.data.cardBrand === "Visa" && r.data.cardExpiry === "12/27" && r.data.cardBillingZip === "06606" && r.data.poRef === "90001" && r.data.chargePath === null && r.data.sourceEmailMessageId === `manual-${TAG}@mail.gmail.com` && r.data.sourceEmailReceivedAt === "2026-08-10T12:00:00.000Z", JSON.stringify(r));
  const dup = await stageClubChargeCore(ACTOR, { amountCents: 7500, messageId: `manual-${TAG}@mail.gmail.com` });
  check("duplicate message id → duplicate, no double row", dup.ok === false && dup.code === "duplicate", JSON.stringify(dup));
  const bad = await stageClubChargeCore(ACTOR, { amountCents: 0 });
  check("invalid amount → invalid_input", bad.ok === false && bad.code === "invalid_input", JSON.stringify(bad));
  const denied = await stageClubChargeCore(WRONG_ACTOR, { amountCents: 100 });
  check("stage: contractor actor → unauthorized", denied.ok === false && denied.code === "unauthorized", JSON.stringify(denied));
  const count = await q`SELECT COUNT(*)::int AS n FROM payment_transactions WHERE org_id=${ORG} AND source_email_message_id=${`manual-${TAG}@mail.gmail.com`}`;
  check("manual stage left exactly one row", Number(count[0].n) === 1, JSON.stringify(count));
}

/* ============ 5) list: newest first, all statuses, role gate ============ */
{
  // Insert a charged + a failed row directly (explicit created_at relative to
  // NOW() so ordering is deterministic) plus the staged ones from the scan.
  const [chargedId, failedId] = [`ptx-charged-${TAG}`, `ptx-failed-${TAG}`];
  await q`INSERT INTO payment_transactions(id, org_id, kind, amount_cents, currency, square_payment_id, status, club_name, card_last4, card_brand, card_expiry, card_billing_zip, charge_path, po_ref, source_email_message_id, idempotency_key, attempt, created_at)
    VALUES(${chargedId}, ${ORG}, 'club_charge', 12345, 'USD', 'pymt_123', 'charged', 'Honk', '1010', 'Mastercard', '05/28', '60601', 'square', '5532', ${`charged-${TAG}@mail.gmail.com`}, ${`club-done-${TAG}`}, 1, NOW() - INTERVAL '2 hours')`;
  await q`INSERT INTO payment_transactions(id, org_id, kind, amount_cents, currency, status, club_name, card_last4, card_brand, po_ref, source_email_message_id, attempt, error, created_at)
    VALUES(${failedId}, ${ORG}, 'club_charge', 6789, 'USD', 'failed', 'Allstate', '7788', 'Amex', '441233', ${`failed-${TAG}@mail.gmail.com`}, 1, 'Square payment failed (HTTP 400)', NOW() - INTERVAL '1 hour')`;
  const r = await listStagedChargesCore(ACTOR);
  check("list ok", r.ok === true && Array.isArray(r.data), JSON.stringify(r));
  const idx = (id) => r.data.findIndex((d) => d.id === id);
  check("list newest first (staged now → failed 1h ago → charged 2h ago)", idx(chargedId) > idx(failedId) && idx(failedId) > 0 && r.data[0].status === "staged", JSON.stringify(r.data.map((d) => `${d.id}:${d.status}`)));
  check("list includes staged rows from the scan", r.data.some((d) => d.status === "staged"), JSON.stringify(r.data.map((d) => d.status)));
  check("list rows carry per-PO card fields + charge path", r.data.every((d) => d.cardExpiry !== undefined && d.cardBillingZip !== undefined && d.chargePath !== undefined) && r.data.some((d) => d.id === chargedId && d.chargePath === "square" && d.cardExpiry === "05/28"), JSON.stringify(r.data[0]));
  check("list rows seroval-safe (no undefined props)", r.data.every((d) => Object.values(d).every((v) => v !== undefined)), JSON.stringify(r.data[0]));
  const denied = await listStagedChargesCore(WRONG_ACTOR);
  check("list: contractor actor → unauthorized", denied.ok === false && denied.code === "unauthorized", JSON.stringify(denied));
  const other = await listStagedChargesCore(OTHER_ACTOR);
  check("list is org-scoped (ORG2 sees only its own)", other.ok === true && other.data.every((d) => d.orgId === ORG2), JSON.stringify(other.data.map((d) => d.orgId)));
}

/* ============ 6) charge success: NONCE source, Square call shape, transition ============ */
{
  const { fetchImpl, squareCalls } = makeSquare({ mode: "ok" });
  const rows = await q`SELECT id FROM payment_transactions WHERE org_id=${ORG} AND status='staged' AND kind='club_charge' AND source_email_message_id=${MAIL[0].messageId} LIMIT 1`;
  const txnId = String(rows[0].id);
  const r = await chargeStagedCore(ACTOR, { txnId, sourceId: "cnon:qa_webpayments_nonce_a" }, { fetchImpl });
  check("charge ok → charged", r.ok === true && r.data.status === "charged", JSON.stringify(r));
  check("charge records square payment id + attempt 1 + charge_path square", r.data.squarePaymentId === "pymt_club_1" && r.data.attempt === 1 && r.data.idempotencyKey === squareIdempotencyKey("club-", txnId, 1) && r.data.chargePath === "square", JSON.stringify(r.data));
  const call = squareCalls[0];
  check("Square auth header = Bearer <secret token>", call.headers.authorization === "Bearer test-square-token", JSON.stringify(call.headers));
  check("Square body: hashed idempotency key (≤45 chars) + amount cents + currency + source = NONCE + location", call.body.idempotency_key === squareIdempotencyKey("club-", txnId, 1) && call.body.amount_money.amount === 8500 && call.body.amount_money.currency === "USD" && call.body.source_id === "cnon:qa_webpayments_nonce_a" && call.body.location_id === "loc_test", JSON.stringify(call.body));
  check("Square note carries club + PO attribution", String(call.body.note).includes("Allied Dispatch") && String(call.body.note).includes("88231"), JSON.stringify(call.body.note));
  check("exactly one Square call (no retry loop)", squareCalls.length === 1, JSON.stringify(squareCalls.length));
  const dbRow = await q`SELECT card_source_id FROM payment_transactions WHERE id=${txnId}`;
  check("nonce persisted as the row's source (ledger shows which source was charged)", String(dbRow[0].card_source_id) === "cnon:qa_webpayments_nonce_a", JSON.stringify(dbRow));
  const aud = await q`SELECT action, actor_role, detail FROM audit_log WHERE org_id=${ORG} AND action='payment_charge_charged'`;
  check("audit payment_charge_charged (owner actor)", aud.length === 1 && String(aud[0].actor_role) === "owner" && aud[0].detail.paymentId === "pymt_club_1", JSON.stringify(aud));
  // A charged row can't be charged again.
  const again = await chargeStagedCore(ACTOR, { txnId, sourceId: "cnon:qa_webpayments_nonce_b" }, { fetchImpl });
  check("already charged → invalid_state, no second Square call", again.ok === false && again.code === "invalid_state" && squareCalls.length === 1, JSON.stringify(again));
  // PER-PO CARD POLISH (owner-confirmed): the PO's card is consumed on charge —
  // the card metadata was cleared in the SAME update that marked it charged.
  const cleared = await q`SELECT card_brand, card_last4, card_expiry, card_billing_zip, amount_cents, club_name, po_ref, charge_path, status, source_email_message_id FROM payment_transactions WHERE id=${txnId}`;
  check("charged row: card columns NULL (card consumed on charge)", cleared[0].card_brand == null && cleared[0].card_last4 == null && cleared[0].card_expiry == null && cleared[0].card_billing_zip == null, JSON.stringify(cleared[0]));
  check("charged row: amount/club/po/charge_path/status/messageId intact", Number(cleared[0].amount_cents) === 8500 && String(cleared[0].club_name) === "Allied Dispatch" && String(cleared[0].po_ref) === "88231" && String(cleared[0].charge_path) === "square" && String(cleared[0].status) === "charged" && String(cleared[0].source_email_message_id) === MAIL[0].messageId, JSON.stringify(cleared[0]));
  // Re-scanning the SAME email must NOT resurrect card data onto the charged
  // row: the unique (org, source_email_message_id) guard reports already_staged
  // before any INSERT, so the fresh parse never lands.
  const { mailbox: rescanMailbox } = makeMailboxFor([MAIL[0]]);
  const rescan = await scanClubMailCore(ACTOR, {}, { connectImpl: async () => rescanMailbox });
  check("charged-row re-scan: already_staged 1, staged 0 (messageId guard blocks re-stage)", rescan.ok === true && rescan.alreadyStaged === 1 && rescan.staged === 0, JSON.stringify(rescan));
  const stillCleared = await q`SELECT card_brand, card_last4, card_expiry, card_billing_zip, status FROM payment_transactions WHERE id=${txnId}`;
  check("charged-row re-scan: card columns STILL NULL (no resurrection)", stillCleared[0].card_brand == null && stillCleared[0].card_last4 == null && stillCleared[0].card_expiry == null && stillCleared[0].card_billing_zip == null && String(stillCleared[0].status) === "charged", JSON.stringify(stillCleared[0]));
}

/* ============ 7) charge failure: 400 → failed + attempt bumps ============ */
{
  const { fetchImpl, squareCalls } = makeSquare({ mode: "fail" });
  const rows = await q`SELECT id FROM payment_transactions WHERE org_id=${ORG} AND status='staged' AND kind='club_charge' AND source_email_message_id=${MAIL[2].messageId} LIMIT 1`;
  const txnId = String(rows[0].id);
  const r = await chargeStagedCore(ACTOR, { txnId, sourceId: "cnon:qa_nonce_fail" }, { fetchImpl });
  check("400 → failed with error + attempt 1", r.ok === false && r.code === "square_failed" && r.retryable === true && String(r.message).includes("CARD_DECLINED"), JSON.stringify(r));
  const dbRow = await q`SELECT status, error, attempt, idempotency_key FROM payment_transactions WHERE id=${txnId}`;
  check("row failed + error + attempt 1 + key recorded", String(dbRow[0].status) === "failed" && String(dbRow[0].error).includes("CARD_DECLINED") && Number(dbRow[0].attempt) === 1 && String(dbRow[0].idempotency_key) === squareIdempotencyKey("club-", txnId, 1), JSON.stringify(dbRow));
  // Retry after confirmed failure uses a FRESH attempt → fresh key (the first
  // was declined; no double-charge risk) + a fresh nonce from the owner.
  const r2 = await chargeStagedCore(ACTOR, { txnId, sourceId: "cnon:qa_nonce_fail_2" }, { fetchImpl });
  check("retry → attempt 2 + fresh hashed key (deterministic per attempt)", r2.ok === false && squareCalls.length === 2 && squareCalls[1].body.idempotency_key === squareIdempotencyKey("club-", txnId, 2), JSON.stringify(squareCalls.map((c) => c.body.idempotency_key)));
  const dbRow2 = await q`SELECT attempt, idempotency_key FROM payment_transactions WHERE id=${txnId}`;
  check("row attempt 2 + key persisted", Number(dbRow2[0].attempt) === 2 && String(dbRow2[0].idempotency_key) === squareIdempotencyKey("club-", txnId, 2), JSON.stringify(dbRow2));
  const aud = await q`SELECT COUNT(*)::int AS n FROM audit_log WHERE org_id=${ORG} AND action='payment_charge_failed'`;
  check("audit payment_charge_failed recorded", Number(aud[0].n) >= 1, JSON.stringify(aud));
}

/* ============ 8) network blip: row stays staged, retry replays SAME key ============ */
{
  const { fetchImpl, squareCalls, paymentIds } = makeSquare({ mode: "blip-then-ok" });
  const rows = await q`SELECT id FROM payment_transactions WHERE org_id=${ORG} AND status='staged' AND kind='club_charge' AND source_email_message_id=${MAIL[1].messageId} LIMIT 1`;
  const txnId = String(rows[0].id);
  const r = await chargeStagedCore(ACTOR, { txnId, sourceId: "cnon:qa_nonce_blip" }, { fetchImpl });
  check("blip → retryable error", r.ok === false && r.retryable === true && String(r.message).includes("fetch failed"), JSON.stringify(r));
  const dbRow = await q`SELECT status, attempt, idempotency_key FROM payment_transactions WHERE id=${txnId}`;
  check("blip → row STAYS staged, attempt unchanged (0)", String(dbRow[0].status) === "staged" && Number(dbRow[0].attempt) === 0 && dbRow[0].idempotency_key == null, JSON.stringify(dbRow));
  const r2 = await chargeStagedCore(ACTOR, { txnId, sourceId: "cnon:qa_nonce_blip" }, { fetchImpl });
  check("retry after blip → charged (same attempt reused)", r2.ok === true && r2.data.attempt === 1 && r2.data.idempotencyKey === `club-${txnId}-1`, JSON.stringify(r2));
  check("BOTH Square calls used the SAME idempotency key (replay-safe)", squareCalls.length === 2 && squareCalls[0].body.idempotency_key === squareIdempotencyKey("club-", txnId, 1) && squareCalls[1].body.idempotency_key === squareIdempotencyKey("club-", txnId, 1), JSON.stringify(squareCalls.map((c) => c.body.idempotency_key)));
  check("same payment returned for the replayed key (no double charge)", paymentIds.get(squareIdempotencyKey("club-", txnId, 1)) === r2.data.squarePaymentId && squareCalls[0].body.idempotency_key === squareCalls[1].body.idempotency_key, JSON.stringify(r2.data.squarePaymentId));
}

/* ============ 9) charge rails: missing source, cross-org, role gate ============ */
{
  const r = await stageClubChargeCore(ACTOR, { amountCents: 3000, clubName: "Honk", messageId: `nosrc-${TAG}@mail.gmail.com` });
  const txnId = r.ok ? r.data.id : "";
  const noSrc = await chargeStagedCore(ACTOR, { txnId }, { fetchImpl: async () => { throw new Error("unexpected Square call"); } });
  check("no tokenized source → square_source_missing (tells owner to use the PO's card)", noSrc.ok === false && noSrc.code === "square_source_missing" && noSrc.retryable === true && String(noSrc.message).includes("PO email"), JSON.stringify(noSrc));
  const rows = await q`SELECT id FROM payment_transactions WHERE org_id=${ORG2} AND kind='club_charge' LIMIT 1`;
  const crossOrg = await chargeStagedCore(ACTOR, { txnId: String(rows[0].id), sourceId: "cnon:qa_cross" }, { fetchImpl: async () => { throw new Error("unexpected Square call"); } });
  check("charge: other org's txn → not_found", crossOrg.ok === false && crossOrg.code === "not_found", JSON.stringify(crossOrg));
  const denied = await chargeStagedCore(WRONG_ACTOR, { txnId, sourceId: "cnon:qa_denied" }, { fetchImpl: async () => { throw new Error("unexpected Square call"); } });
  check("charge: contractor actor → unauthorized", denied.ok === false && denied.code === "unauthorized", JSON.stringify(denied));
  const dbRow = await q`SELECT status FROM payment_transactions WHERE id=${txnId}`;
  check("no-source row untouched (staged)", String(dbRow[0].status) === "staged", JSON.stringify(dbRow));
  // IDEMPOTENCY-KEY LENGTH REGRESSION (production incident: every club charge
  // failed HTTP 400 VALUE_TOO_LONG — `club-<uuid>-<attempt>` was 47 chars).
  check("idempotency keys always ≤ 45 chars (Square's hard limit)", [squareIdempotencyKey("club-", txnId, 1), squareIdempotencyKey("club-", txnId, 2)].every((k) => k.length <= 45), "");
}

/* ============ 10) tip mirror: paid tip → ledger row, idempotent ============ */
{
  const tipId = `tip-${TAG}`;
  const tipJob = `tb-447021-${TAG}`;
  const tipKey = `tip-${tipJob}-1`;
  await q`INSERT INTO completion_tips(id, org_id, job_id, driver_id, driver_towbook_id, amount_cents, currency, square_payment_id, status, attempt, idempotency_key)
    VALUES(${tipId}, ${ORG}, ${tipJob}, ${DRIVER}, '910088', 500, 'USD', 'pymt_tip_1', 'paid', 1, ${tipKey})`;
  const r = await mirrorTipCore(ACTOR, { tipId });
  check("mirror ok → tip row in ledger, status charged", r.ok === true && r.data.kind === "tip" && r.data.status === "charged" && r.data.amountCents === 500 && r.data.squarePaymentId === "pymt_tip_1" && r.data.jobId === tipJob && r.data.idempotencyKey === `tip-mirror-${tipId}`, JSON.stringify(r));
  const r2 = await mirrorTipCore(ACTOR, { tipId });
  check("re-mirror idempotent (same row returned)", r2.ok === true && r2.data.id === r.data.id, JSON.stringify(r2));
  const count = await q`SELECT COUNT(*)::int AS n FROM payment_transactions WHERE org_id=${ORG} AND idempotency_key=${`tip-mirror-${tipId}`}`;
  check("exactly one mirrored tip row", Number(count[0].n) === 1, JSON.stringify(count));
  const notPaid = `tip-np-${TAG}`;
  await q`INSERT INTO completion_tips(id, org_id, job_id, driver_id, driver_towbook_id, amount_cents, currency, status, error)
    VALUES(${notPaid}, ${ORG}, ${"tb-447022-" + TAG}, ${DRIVER}, '910088', 0, 'USD', 'declined', 'customer declined')`;
  const bad = await mirrorTipCore(ACTOR, { tipId: notPaid });
  check("non-paid tip → invalid_state, no ledger row", bad.ok === false && bad.code === "invalid_state", JSON.stringify(bad));
  const denied = await mirrorTipCore(WRONG_ACTOR, { tipId });
  check("mirror: contractor actor → unauthorized", denied.ok === false && denied.code === "unauthorized", JSON.stringify(denied));
  const tipAud = await q`SELECT action, detail FROM audit_log WHERE org_id=${ORG} AND action='payment_tip_mirrored'`;
  check("audit payment_tip_mirrored (driver attribution preserved)", tipAud.length === 1 && tipAud[0].detail && tipAud[0].detail.driverTowbookId === "910088" && tipAud[0].detail.amountCents === 500 && tipAud[0].detail.jobId === tipJob, JSON.stringify(tipAud));
}

/* ============ 11) MARK CHARGED OUTSIDE: owner's own dashboard charge ============ */
{
  const staged = await stageClubChargeCore(ACTOR, { amountCents: 9999, clubName: "Honk", cardLast4: "1010", cardBrand: "Mastercard", cardExpiry: "05/28", cardBillingZip: "60601", poRef: "5532", messageId: `outside-${TAG}@mail.gmail.com` });
  check("outside: staged row first", staged.ok === true && staged.data.status === "staged", JSON.stringify(staged));
  const r = await markChargedOutsideCore(ACTOR, { txnId: staged.data.id, note: "charged in my Square dashboard 8/12" });
  check("mark outside ok → charged, charge_path outside, NO square payment id", r.ok === true && r.data.status === "charged" && r.data.chargePath === "outside" && r.data.squarePaymentId === null && r.data.attempt === 0 && r.data.idempotencyKey === null, JSON.stringify(r));
  const dbRow = await q`SELECT status, charge_path, square_payment_id, error FROM payment_transactions WHERE id=${staged.data.id}`;
  check("row: charged / outside / square_payment_id NULL", String(dbRow[0].status) === "charged" && String(dbRow[0].charge_path) === "outside" && dbRow[0].square_payment_id == null, JSON.stringify(dbRow));
  // PER-PO CARD POLISH: mark-outside clears the PO's card metadata in the SAME
  // update that marks it charged (consumed once, never shown again).
  const clearedOutside = await q`SELECT card_brand, card_last4, card_expiry, card_billing_zip, amount_cents, club_name, po_ref, charge_path FROM payment_transactions WHERE id=${staged.data.id}`;
  check("mark-outside: card columns NULL (card consumed)", clearedOutside[0].card_brand == null && clearedOutside[0].card_last4 == null && clearedOutside[0].card_expiry == null && clearedOutside[0].card_billing_zip == null, JSON.stringify(clearedOutside[0]));
  check("mark-outside: amount/club/po/charge_path intact", Number(clearedOutside[0].amount_cents) === 9999 && String(clearedOutside[0].club_name) === "Honk" && String(clearedOutside[0].po_ref) === "5532" && String(clearedOutside[0].charge_path) === "outside", JSON.stringify(clearedOutside[0]));
  const aud = await q`SELECT action, actor_role, detail FROM audit_log WHERE org_id=${ORG} AND action='payment_charge_marked_outside'`;
  check("audit payment_charge_marked_outside (owner, amount + note)", aud.length === 1 && String(aud[0].actor_role) === "owner" && aud[0].detail.amountCents === 9999 && aud[0].detail.note === "charged in my Square dashboard 8/12", JSON.stringify(aud));
  // Marking twice → invalid_state (never double-recorded); charge after mark → invalid_state.
  const again = await markChargedOutsideCore(ACTOR, { txnId: staged.data.id });
  check("mark twice → invalid_state", again.ok === false && again.code === "invalid_state", JSON.stringify(again));
  const audCount = await q`SELECT COUNT(*)::int AS n FROM audit_log WHERE org_id=${ORG} AND action='payment_charge_marked_outside'`;
  check("exactly ONE audit row (no double record)", Number(audCount[0].n) === 1, JSON.stringify(audCount));
  const chargeAfter = await chargeStagedCore(ACTOR, { txnId: staged.data.id, sourceId: "cnon:qa_nonce_late" }, { fetchImpl: async () => { throw new Error("unexpected Square call"); } });
  check("charge after mark → invalid_state, zero Square calls", chargeAfter.ok === false && chargeAfter.code === "invalid_state", JSON.stringify(chargeAfter));
  // A FAILED row can be marked outside (owner declined it, charged elsewhere).
  const failedRow = await q`SELECT id FROM payment_transactions WHERE org_id=${ORG} AND status='failed' LIMIT 1`;
  const markFailed = await markChargedOutsideCore(ACTOR, { txnId: String(failedRow[0].id) });
  check("failed row can be marked outside (owner charged it in their dashboard)", markFailed.ok === true && markFailed.data.status === "charged" && markFailed.data.chargePath === "outside", JSON.stringify(markFailed));
  // Role gates + cross-org.
  const denied = await markChargedOutsideCore(WRONG_ACTOR, { txnId: staged.data.id });
  check("mark outside: contractor → unauthorized", denied.ok === false && denied.code === "unauthorized", JSON.stringify(denied));
  const otherRows = await q`SELECT id FROM payment_transactions WHERE org_id=${ORG2} AND kind='club_charge' LIMIT 1`;
  const crossOrg = await markChargedOutsideCore(ACTOR, { txnId: String(otherRows[0].id) });
  check("mark outside: ORG owner on ORG2's txn → not_found (org-scoped)", crossOrg.ok === false && crossOrg.code === "not_found", JSON.stringify(crossOrg));
  // The ORG2 owner CAN mark their own row (proves scoping, not denial).
  const ownRow = await markChargedOutsideCore(OTHER_ACTOR, { txnId: String(otherRows[0].id) });
  check("mark outside: ORG2 owner marks ORG2 txn → ok", ownRow.ok === true && ownRow.data.orgId === ORG2 && ownRow.data.chargePath === "outside", JSON.stringify(ownRow));
  const adminMark = await stageClubChargeCore(ADMIN_ACTOR, { amountCents: 1234, clubName: "Allstate", messageId: `admin-mark-${TAG}@mail.gmail.com` });
  const adminOk = await markChargedOutsideCore(ADMIN_ACTOR, { txnId: adminMark.data.id });
  check("admin can mark charged outside", adminOk.ok === true && adminOk.data.chargePath === "outside", JSON.stringify(adminOk));
}

/* ============ 12) per-PO staging from a fresh email shape (manual entry) ============ */
{
  // A PO email that shows the FULL card number (grouped 4-4-4-4) — only the
  // last 4 may be staged, plus brand/expiry/zip.
  const po = parseClubChargeEmail({ from: "billing@allieddispatch.com", subject: "Allied Dispatch Payment — PO #77120", bodyText: "Visa 4242 4242 4242 4242 charged $112.75 for PO #77120. Exp 03/29. Billing zip 06606." });
  check("full grouped PAN → last4 4242 only, metadata intact", po.amountCents === 11275 && po.cardLast4 === "4242" && po.cardBrand === "Visa" && po.cardExpiry === "03/29" && po.cardBillingZip === "06606" && po.poRef === "77120", JSON.stringify(po));
  check("full PAN never stored/returned", !JSON.stringify(po).includes("424242424242"), JSON.stringify(po));
  const staged = await stageClubChargeCore(ACTOR, { amountCents: po.amountCents, cardLast4: po.cardLast4, cardBrand: po.cardBrand, cardExpiry: po.cardExpiry, cardBillingZip: po.cardBillingZip, clubName: "Allied Dispatch", poRef: po.poRef, messageId: `po77120-${TAG}@mail.gmail.com` });
  check("manual stage with parsed per-PO card metadata persisted", staged.ok === true && staged.data.cardLast4 === "4242" && staged.data.cardBrand === "Visa" && staged.data.cardExpiry === "03/29" && staged.data.cardBillingZip === "06606" && staged.data.poRef === "77120", JSON.stringify(staged));
  const dbRow = await q`SELECT card_last4, card_brand, card_expiry, card_billing_zip FROM payment_transactions WHERE id=${staged.data.id}`;
  check("DB row carries the PO's own card metadata", String(dbRow[0].card_last4) === "4242" && String(dbRow[0].card_brand) === "Visa" && String(dbRow[0].card_expiry) === "03/29" && String(dbRow[0].card_billing_zip) === "06606", JSON.stringify(dbRow));
}

/* ============ 13) per-PO charge end-to-end: staged metadata → nonce → Square ============ */
{
  // The OWNER's flow per the per-PO card model: scan stages the row with the
  // PO's card metadata; the owner sees "Visa ••4242 · exp 12/27 · zip 06606",
  // enters that card into the secure form, the nonce is charged — one call.
  const { fetchImpl, squareCalls } = makeSquare({ mode: "ok" });
  const rows = await q`SELECT * FROM payment_transactions WHERE org_id=${ORG} AND status='staged' AND kind='club_charge' AND card_brand='Visa' AND card_expiry='12/27' LIMIT 1`;
  check("per-PO: a staged row with Visa ••4242 exp 12/27 exists", rows.length === 1, JSON.stringify(rows));
  check("per-PO: card metadata PRESENT while staged (never cleared before charge)", rows.length === 1 && String(rows[0].card_brand) === "Visa" && String(rows[0].card_last4) === "4242" && String(rows[0].card_expiry) === "12/27" && String(rows[0].card_billing_zip) === "06606", JSON.stringify(rows[0]));
  const r = await chargeStagedCore(ACTOR, { txnId: String(rows[0].id), sourceId: "cnon:qa_ppo_nonce" }, { fetchImpl });
  check("per-PO: charge ok → charged via square", r.ok === true && r.data.status === "charged" && r.data.chargePath === "square", JSON.stringify(r));
  check("per-PO: exactly one /v2/payments call with the nonce", squareCalls.length === 1 && squareCalls[0].body.source_id === "cnon:qa_ppo_nonce", JSON.stringify(squareCalls));
  const dbRow = await q`SELECT card_source_id, charge_path FROM payment_transactions WHERE id=${String(rows[0].id)}`;
  check("per-PO: row records the charged nonce + charge_path square", String(dbRow[0].card_source_id) === "cnon:qa_ppo_nonce" && String(dbRow[0].charge_path) === "square", JSON.stringify(dbRow));
  const clearedPpo = await q`SELECT card_brand, card_last4, card_expiry, card_billing_zip, amount_cents, club_name, po_ref, charge_path, status FROM payment_transactions WHERE id=${String(rows[0].id)}`;
  check("per-PO charged row: card columns NULL, rest intact (Visa ••4242 consumed on charge)", clearedPpo[0].card_brand == null && clearedPpo[0].card_last4 == null && clearedPpo[0].card_expiry == null && clearedPpo[0].card_billing_zip == null && Number(clearedPpo[0].amount_cents) === 7500 && String(clearedPpo[0].club_name) === "Allied Dispatch" && String(clearedPpo[0].po_ref) === "90001" && String(clearedPpo[0].charge_path) === "square" && String(clearedPpo[0].status) === "charged", JSON.stringify(clearedPpo[0]));
}

/* ============ 14) motor_club_cards is DEAD: a legacy stored card NEVER auto-charges ============ */
{
  // Plant a legacy per-club card-on-file row (the OLD model) for a club and
  // stage a fresh charge for the SAME club with NO nonce — the engine must
  // refuse (square_source_missing) instead of auto-resolving the ccof card.
  await q`INSERT INTO motor_club_cards(id, org_id, club_name, square_card_id, brand, last4)
    VALUES(${`legacy-${TAG}`}, ${ORG}, 'Allstate', 'ccof:qa_legacy_card', 'Amex', '7788')`;
  const staged = await stageClubChargeCore(ACTOR, { amountCents: 5432, clubName: "Allstate", cardLast4: "7788", cardBrand: "Amex", messageId: `legacy-${TAG}@mail.gmail.com` });
  check("legacy: staged row for Allstate (no source)", staged.ok === true && staged.data.cardSourceId === null, JSON.stringify(staged));
  let squareCalls = 0;
  const noSrc = await chargeStagedCore(ACTOR, { txnId: staged.data.id }, { fetchImpl: async () => { squareCalls += 1; throw new Error("unexpected Square call"); } });
  check("legacy: charge WITHOUT a nonce → square_source_missing (per-PO requires the owner's card entry)", noSrc.ok === false && noSrc.code === "square_source_missing" && noSrc.retryable === true, JSON.stringify(noSrc));
  check("legacy: ZERO Square calls — the stored ccof was NEVER read/charged", squareCalls === 0, JSON.stringify(squareCalls));
  const dbRow = await q`SELECT status, card_source_id FROM payment_transactions WHERE id=${staged.data.id}`;
  check("legacy: row untouched (staged, no source resolved)", String(dbRow[0].status) === "staged" && dbRow[0].card_source_id == null, JSON.stringify(dbRow));
  // The legacy card row itself is never read by any engine path in this run —
  // grep-proof: list reads don't touch it, no API surface exposes it.
  await q`DELETE FROM motor_club_cards WHERE id=${`legacy-${TAG}`}`;
  // And even a manual stored card cannot be charged directly: a NONCE is the
  // only accepted source (row.card_source_id is never READ for charging).
  const staged2 = await stageClubChargeCore(ACTOR, { amountCents: 2100, clubName: "Honk", messageId: `stale-src-${TAG}@mail.gmail.com` });
  await q`UPDATE payment_transactions SET card_source_id='ccof:qa_stale' WHERE id=${staged2.data.id}`;
  const stale = await chargeStagedCore(ACTOR, { txnId: staged2.data.id }, { fetchImpl: async () => { throw new Error("unexpected Square call"); } });
  check("row card_source_id is NEVER auto-used for charging (fresh nonce required)", stale.ok === false && stale.code === "square_source_missing", JSON.stringify(stale));
}

/* ============ 15) role gates (mark outside) + public Square config ============ */
{
  const denied = await markChargedOutsideCore(WRONG_ACTOR, { txnId: "whatever" });
  check("mark outside: contractor → unauthorized", denied.ok === false && denied.code === "unauthorized", JSON.stringify(denied));
  const bad = await markChargedOutsideCore(ACTOR, { txnId: "no-such-txn" });
  check("mark outside: unknown txn → not_found", bad.ok === false && bad.code === "not_found", JSON.stringify(bad));
  // The not-configured path only triggers when the env has NO Square creds.
  const saved = { t: process.env.SQUARE_ACCESS_TOKEN, l: process.env.SQUARE_LOCATION_ID, a: process.env.SQUARE_APPLICATION_ID };
  delete process.env.SQUARE_ACCESS_TOKEN; delete process.env.SQUARE_LOCATION_ID; delete process.env.SQUARE_APPLICATION_ID;
  const noConfig = await chargeStagedCore(ACTOR, { txnId: "x", sourceId: "cnon:qa_config_nonce" }, { squareStableDir: `/tmp/square-missing-${Date.now()}` });
  check("missing Square creds → square_not_configured", noConfig.ok === false && noConfig.code === "square_not_configured" && String(noConfig.message).includes("missing"), JSON.stringify(noConfig));
  const cfg = await getPaymentSquareConfigCore({ squareStableDir: `/tmp/square-missing-${Date.now()}` });
  check("public config missing → square_not_configured", cfg.ok === false && cfg.code === "square_not_configured", JSON.stringify(cfg));
  process.env.SQUARE_ACCESS_TOKEN = saved.t; process.env.SQUARE_LOCATION_ID = saved.l; process.env.SQUARE_APPLICATION_ID = saved.a;
  const cfgOk = await getPaymentSquareConfigCore();
  check("public config → app id + location id ONLY (no token)", cfgOk.ok === true && cfgOk.data.applicationId === "app_test" && cfgOk.data.locationId === "loc_test" && !JSON.stringify(cfgOk).includes("test-square-token"), JSON.stringify(cfgOk));
}

/* ============ 16) listTips: driver attribution via completion_tips join ============ */
{
  const tipId = `tip-cc-${TAG}`;
  const tipJob = `tb-447100-${TAG}`;
  await q`INSERT INTO completion_tips(id, org_id, job_id, driver_id, driver_towbook_id, amount_cents, currency, square_payment_id, status, attempt, idempotency_key)
    VALUES(${tipId}, ${ORG}, ${tipJob}, ${DRIVER}, '910088', 750, 'USD', 'pymt_tip_cc', 'paid', 1, ${`tip-${tipJob}-1`})`;
  const m = await mirrorTipCore(ACTOR, { tipId });
  check("tip mirrored into ledger (separate from club charges)", m.ok === true && m.data.kind === "tip", JSON.stringify(m));
  const tips = await listTipsCore(ACTOR);
  check("listTips shows driver name + towbook id", tips.ok === true && tips.data.length >= 1 && tips.data.some((t) => t.driverName === "QA Tip Driver" && t.driverTowbookId === "910088" && t.amountCents === 750), JSON.stringify(tips.data));
  check("tips seroval-safe", tips.data.every((t) => t.driverName !== undefined && t.driverTowbookId !== undefined && Object.values(t).every((v) => v !== undefined)), JSON.stringify(tips.data[0]));
  const kindCounts = await q`SELECT kind, COUNT(*)::int AS n FROM payment_transactions WHERE org_id=${ORG} AND kind IN ('tip','club_charge') GROUP BY kind`;
  const kinds = Object.fromEntries(kindCounts.map((k) => [String(k.kind), Number(k.n)]));
  check("tips kept as kind='tip' rows, club charges kind='club_charge' (never merged)", (kinds.tip ?? 0) >= 1 && (kinds.club_charge ?? 0) >= 1, JSON.stringify(kinds));
}

/* ============ 17) approval gate: staging NEVER charges; only /v2/payments is ever called ============ */
{
  // Full end-to-end: a fresh club-charge email is scanned + staged, and the
  // engine makes ZERO Square calls of any kind until the owner EXPLICITLY
  // enters the PO's card and taps Charge (chargeStagedCore with a nonce).
  const { fetchImpl, squareCalls } = makeSquare({ mode: "ok" });
  const gateMail = { ...MAIL[0], messageId: `gate-${TAG}@mail.gmail.com`, subject: MAIL[0].subject, from: MAIL[0].from, body: MAIL[0].body };
  const gateMailbox = {
    async connect() {},
    async mailboxOpen() {},
    async search() { return [1]; },
    async fetchOne() {
      return {
        envelope: { messageId: gateMail.messageId, date: new Date("2026-08-11T10:00:00Z"), from: [{ address: gateMail.from }], subject: gateMail.subject },
        source: rawMessage(gateMail),
      };
    },
    async logout() {},
  };
  const scan = await scanClubMailCore(ACTOR, {}, { connectImpl: async () => gateMailbox });
  check("gate: scan staged exactly 1 fresh Allied charge with its card metadata", scan.ok === true && scan.staged === 1 && scan.skipped === 0 && scan.items[0].cardBrand === "Visa" && scan.items[0].cardExpiry === "12/27", JSON.stringify(scan));
  check("gate: scan/stage made ZERO Square calls (nothing auto-charged)", squareCalls.length === 0, JSON.stringify(squareCalls));
  const stagedRow = await q`SELECT * FROM payment_transactions WHERE org_id=${ORG} AND source_email_message_id=${gateMail.messageId} LIMIT 1`;
  check("gate: staged row exists, status staged, no payment id, no charge_path", stagedRow.length === 1 && String(stagedRow[0].status) === "staged" && stagedRow[0].square_payment_id == null && stagedRow[0].charge_path == null, JSON.stringify(stagedRow));
  // The owner can record an outside charge with ZERO Square calls.
  const outside = await markChargedOutsideCore(ACTOR, { txnId: String(stagedRow[0].id) });
  check("gate: mark charged outside works with ZERO Square calls", outside.ok === true && outside.data.chargePath === "outside" && squareCalls.length === 0, JSON.stringify(outside));
  // Charge a remaining STAGED club row (the manual po77120 row from section
  // 12 — the scanned Allied row was already charged in section 6) — the
  // explicit approval: exactly one /v2/payments call, nonce source.
  const origRows = await q`SELECT id FROM payment_transactions WHERE org_id=${ORG} AND kind='club_charge' AND status='staged' AND charge_path IS NULL LIMIT 1`;
  check("gate: a staged row remains to charge", origRows.length === 1, JSON.stringify(origRows));
  const charge = await chargeStagedCore(ACTOR, { txnId: String(origRows[0].id), sourceId: "cnon:qa_gate_nonce" }, { fetchImpl });
  check("gate: explicit chargeStagedCore → charged", charge.ok === true && charge.data.status === "charged" && charge.data.squarePaymentId != null && charge.data.chargePath === "square", JSON.stringify(charge));
  const paymentCalls = squareCalls.filter((c) => c.method === "POST" && c.url === "https://connect.squareup.com/v2/payments");
  check("gate: exactly ONE payment call after explicit approval", paymentCalls.length === 1, JSON.stringify(squareCalls));
  check("gate: payment source is the owner-entered NONCE (per-PO card)", paymentCalls[0].body.source_id === "cnon:qa_gate_nonce", JSON.stringify(paymentCalls[0].body));
  // The engine may ONLY ever touch POST /v2/payments — never /v2/cards (no
  // card-on-file), never a transfer/payout/bank endpoint: funds never LEAVE
  // the owner's Square balance.
  const badUrls = squareCalls.filter((c) => c.url !== "https://connect.squareup.com/v2/payments");
  check("no /v2/cards, no transfer/payout/bank-account endpoints ever called (funds never transferred out)", badUrls.length === 0, JSON.stringify(badUrls));
  const allUrls = squareCalls.map((c) => c.url);
  check("every Square call this section is exactly POST /v2/payments", allUrls.every((u) => u === "https://connect.squareup.com/v2/payments"), JSON.stringify(allUrls));
}
/* ================================ summary + cleanup ================================ */
const failed = checks.filter(([, ok]) => !ok);
console.log(`payment-engine.test.mjs: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) { console.error(failed.map(([n, , e]) => `  ${n} ${e}`).join("\n")); process.exit(1); }
// Prove cleanup: deleting the QA orgs cascades every row they created
// (payment_transactions + audit_log + completion_tips + memberships all FK to
// organizations ON DELETE CASCADE); users that were members are deleted
// explicitly (users has no org FK). Org NAME is 'qa payment' — the hyphenated
// ids are the QA org ids.
const memberIds = await q`SELECT DISTINCT m.user_id FROM organization_memberships m JOIN organizations o ON o.id=m.org_id WHERE o.name LIKE 'qa payment%'`;
for (const org of await q`SELECT id, name FROM organizations WHERE name LIKE 'qa payment%'`) {
  assertQaOrg(org.id, org.name);
  await q`DELETE FROM organizations WHERE id=${org.id}`.catch(() => {});
}
for (const u of memberIds) {
  await q`DELETE FROM users WHERE id=${u.user_id}`.catch(() => {});
}
const leftover = await q`SELECT
  (SELECT COUNT(*)::int FROM organizations WHERE name LIKE 'qa payment%') AS orgs,
  (SELECT COUNT(*)::int FROM motor_club_cards WHERE org_id LIKE 'qa-payment%') AS cards,
  (SELECT COUNT(*)::int FROM payment_transactions WHERE org_id LIKE 'qa-payment%') AS txns,
  (SELECT COUNT(*)::int FROM completion_tips WHERE org_id LIKE 'qa-payment%') AS tips,
  (SELECT COUNT(*)::int FROM audit_log WHERE org_id LIKE 'qa-payment%') AS audit,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE 'qa-payment-%@lightning.test' OR email LIKE 'qa-payment2-%@lightning.test') AS users,
  (SELECT COUNT(*)::int FROM organization_memberships WHERE org_id LIKE 'qa-payment%') AS members`;
const z = Number(leftover[0].orgs) === 0 && Number(leftover[0].cards) === 0 && Number(leftover[0].txns) === 0 && Number(leftover[0].tips) === 0 && Number(leftover[0].audit) === 0 && Number(leftover[0].users) === 0 && Number(leftover[0].members) === 0;
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) { console.error("FAIL: QA cleanup left rows behind"); process.exit(1); }
console.log("payment-engine.test.mjs: cleanup verified — zero QA rows left");
