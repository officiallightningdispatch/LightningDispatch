// DB safety (2026-08-12): org deletes guarded by assertQaOrg — see src/data/db-guard.ts + /home/team/shared/db-safety-rules.md.
// Hermetic payment-engine tests (2026-08-11, backlog #1 first slice — owner
// spec "an agent scans lightroad29@gmail.com for motor-club credit-card
// information and processes those cards via the Square API without ever
// transferring funds out"). Covers: the Gmail scanner (imapflow surface mocked
// with a fake mailbox — canned Allied Dispatch / Honk / Allstate card-charge
// emails + one junk email), parseClubChargeEmail pure parsing, staging
// (dry-run writes nothing; real scan stages; re-scan never double-stages via
// the (org, source_email_message_id) unique index), the owner/admin ledger
// read (newest first), chargeStagedCore through the OWNER's Square account
// (mock POST /v2/payments verifying the Bearer auth header from the secret,
// idempotency key club-<txnId>-<attempt>, amount, currency, source_id,
// location_id; success + 400 + network-blip paths), the tip mirror into
// payment_transactions (kind='tip', idempotent), and role gates (contractor
// denied everywhere).
// Sections 11-18 (payment-tab slice, 2026-08-12): Cards API card on file
// (create/replace/delete on the OWNER's Square account — brand+last4 only,
// never the PAN), chargeStagedCore AUTO-resolving the club's stored ccof card,
// listTips driver attribution, the owner-approval gate (scan/stage/store NEVER
// charge — only an explicit per-row Charge does), and proof that only
// /v2/cards + /v2/payments are ever touched (funds never transfer OUT of the
// owner's Square balance).
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
} = await import("./src/data/club-mail.ts");
const {
  stageClubChargeCore,
  listStagedChargesCore,
  chargeStagedCore,
  scanClubMailCore,
  mirrorTipCore,
  createClubCardCore,
  listClubCardsCore,
  deleteClubCardCore,
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
const OWNER = `qa-payment-owner-${TAG}`;
const OWNER2 = `qa-payment2-owner-${TAG}`;
const ADMIN = `qa-payment-admin-${TAG}`;
const CONTRACTOR = `qa-payment-driver-${TAG}`;
const DRIVER = `qa-payment-driver2-${TAG}`; // completion_tips driver fixture
const ACTOR = { orgId: ORG, id: OWNER, role: "owner" };
const ADMIN_ACTOR = { orgId: ORG, id: ADMIN, role: "admin" };
const WRONG_ACTOR = { orgId: ORG, id: CONTRACTOR, role: "contractor" };
const OTHER_ACTOR = { orgId: ORG2, id: OWNER2, role: "owner" };

/* ------------------------------ canned emails ------------------------------ */

const MAIL = [
  {
    messageId: `allied-${TAG}@mail.gmail.com`,
    from: "billing@allieddispatch.com",
    subject: "Allied Dispatch Payment — PO #88231",
    body: "Your card ending in 4242 was charged $85.00 for PO #88231.",
  },
  {
    messageId: `honk-${TAG}@mail.gmail.com`,
    from: "no-reply@honkmobile.com",
    subject: "Honk Invoice Paid",
    body: "Payment of USD 129.50 received for order #5532. Card ending 1010.",
  },
  {
    messageId: `allstate-${TAG}@mail.gmail.com`,
    from: "motorclub@allstate.com",
    subject: "Allstate Motor Club — Charge Notification",
    body: "Your card xxxx 7788 was charged $45.25. Purchase order 441233.",
  },
  {
    messageId: `junk-${TAG}@somewhere.com`,
    from: "newsletter@somewhere.com",
    subject: "Weekly deals",
    body: "Save up to 20% this week — no charge, just savings!",
  },
];

const rawMessage = (m) => Buffer.from(
  `From: ${m.from}\r\nTo: owner@lightning.test\r\nSubject: ${m.subject}\r\nDate: Tue, 11 Aug 2026 10:00:00 +0000\r\nMessage-ID: <${m.messageId}>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${m.body}`,
  "utf8",
);

/** Fake IMAP mailbox over the canned messages — records search/fetch calls and
 *  never opens a socket. */
function makeMailbox() {
  const calls = [];
  const uids = MAIL.map((_, i) => i + 1);
  const mailbox = {
    async connect() {},
    async mailboxOpen(name) { calls.push({ op: "open", name }); },
    async search(criteria) { calls.push({ op: "search", criteria }); return [...uids]; },
    async fetchOne(uid) {
      calls.push({ op: "fetch", uid });
      const m = MAIL[uid - 1];
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
      squareCalls.push({ url: u, body, headers: init.headers });
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
  for (const [org, owner] of [[ORG, OWNER], [ORG2, OWNER2]]) {
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
  const honk = parseClubChargeEmail({ from: MAIL[1].from, subject: MAIL[1].subject, bodyText: MAIL[1].body });
  check("parse Honk: USD 129.50 → 12950", honk.amountCents === 12950, JSON.stringify(honk));
  check("parse Honk: last4 1010 + club + order 5532", honk.cardLast4 === "1010" && honk.clubName === "Honk" && honk.poRef === "5532", JSON.stringify(honk));
  const allstate = parseClubChargeEmail({ from: MAIL[2].from, subject: MAIL[2].subject, bodyText: MAIL[2].body });
  check("parse Allstate: $45.25 → 4525", allstate.amountCents === 4525, JSON.stringify(allstate));
  check("parse Allstate: last4 7788 + club + PO 441233", allstate.cardLast4 === "7788" && allstate.clubName === "Allstate" && allstate.poRef === "441233", JSON.stringify(allstate));
  const junk = parseClubChargeEmail({ from: MAIL[3].from, subject: MAIL[3].subject, bodyText: MAIL[3].body });
  check("parse junk: skipped with reason (never a fake charge)", junk.skipReason != null && junk.amountCents === null, JSON.stringify(junk));
  check("detectClub null for non-club mail", detectClub("newsletter@somewhere.com", "deals", "save money") === null);
  check("detectClub case-insensitive keyword", detectClub("ops@ALLIEDDISPATCH.com", "x", "y") === "Allied Dispatch");
  const txt = extractPlainText(rawMessage(MAIL[0]));
  check("extractPlainText pulls the body", txt.includes("charged $85.00"), JSON.stringify(txt));
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
  check("dry-run item has amount/last4/po + message id", dry && dry.amountCents === 8500 && dry.cardLast4 === "4242" && dry.poRef === "88231" && dry.messageId === MAIL[0].messageId, JSON.stringify(dry));
  const count = await q`SELECT COUNT(*)::int AS n FROM payment_transactions WHERE org_id=${ORG}`;
  check("dry-run left zero rows", Number(count[0].n) === 0, JSON.stringify(count));
  const audCount = await q`SELECT COUNT(*)::int AS n FROM audit_log WHERE org_id=${ORG} AND action='payment_scan_ran'`;
  check("dry-run wrote no audit rows either (literal zero writes)", Number(audCount[0].n) === 0, JSON.stringify(audCount));
  // Scan is owner/admin only.
  const denied = await scanClubMailCore(WRONG_ACTOR, { dryRun: true }, { connectImpl: async () => (await makeMailbox()).mailbox });
  check("scan: contractor actor → error, zero writes", denied.ok === false && denied.error.includes("owner or an admin"), JSON.stringify(denied));
}

/* ============ 2) real scan: stages 3, skips junk, audit row ============ */
{
  const { mailbox, calls } = makeMailbox();
  const r = await scanClubMailCore(ACTOR, {}, { connectImpl: async () => mailbox });
  check("scan ok, staged 3, skipped 1", r.ok === true && r.staged === 3 && r.skipped === 1 && r.alreadyStaged === 0, JSON.stringify(r));
  check("scan: read-only mailbox ops (open/search/fetch/logout, no writes)", calls.map((c) => c.op).join(",") === "open,search,fetch,fetch,fetch,fetch,logout", JSON.stringify(calls.map((c) => c.op)));
  const rows = await q`SELECT * FROM payment_transactions WHERE org_id=${ORG} AND kind='club_charge' ORDER BY amount_cents`;
  check("exactly 3 staged club_charge rows", rows.length === 3, JSON.stringify(rows));
  const byAmount = Object.fromEntries(rows.map((r2) => [Number(r2.amount_cents), r2]));
  check("Allied row staged with full fields", byAmount[8500] && String(byAmount[8500].status) === "staged" && String(byAmount[8500].club_name) === "Allied Dispatch" && String(byAmount[8500].card_last4) === "4242" && String(byAmount[8500].po_ref) === "88231" && String(byAmount[8500].source_email_message_id) === MAIL[0].messageId && String(byAmount[8500].currency) === "USD" && Number(byAmount[8500].attempt) === 0 && byAmount[8500].idempotency_key == null, JSON.stringify(byAmount[8500]));
  check("Honk row staged", byAmount[12950] && String(byAmount[12950].club_name) === "Honk" && String(byAmount[12950].card_last4) === "1010" && String(byAmount[12950].source_email_message_id) === MAIL[1].messageId, JSON.stringify(byAmount[12950]));
  check("Allstate row staged", byAmount[4525] && String(byAmount[4525].club_name) === "Allstate" && String(byAmount[4525].source_email_message_id) === MAIL[2].messageId, JSON.stringify(byAmount[4525]));
  const junkRows = await q`SELECT COUNT(*)::int AS n FROM payment_transactions WHERE org_id=${ORG} AND source_email_message_id=${MAIL[3].messageId}`;
  check("junk email never staged", Number(junkRows[0].n) === 0, JSON.stringify(junkRows));
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

/* ============ 4) manual stage + duplicate + role gate ============ */
{
  const r = await stageClubChargeCore(ACTOR, { amountCents: 7500, clubName: "Allied Dispatch", cardLast4: "4242", poRef: "90001", messageId: `manual-${TAG}@mail.gmail.com`, receivedAt: "2026-08-10T12:00:00Z" });
  check("manual stage ok → staged row", r.ok === true && r.data.status === "staged" && r.data.kind === "club_charge" && r.data.amountCents === 7500 && r.data.clubName === "Allied Dispatch" && r.data.cardLast4 === "4242" && r.data.poRef === "90001" && r.data.sourceEmailMessageId === `manual-${TAG}@mail.gmail.com` && r.data.sourceEmailReceivedAt === "2026-08-10T12:00:00.000Z", JSON.stringify(r));
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
  await q`INSERT INTO payment_transactions(id, org_id, kind, amount_cents, currency, square_payment_id, status, club_name, card_last4, po_ref, source_email_message_id, idempotency_key, attempt, created_at)
    VALUES(${chargedId}, ${ORG}, 'club_charge', 12345, 'USD', 'pymt_123', 'charged', 'Honk', '1010', '5532', ${`charged-${TAG}@mail.gmail.com`}, ${`club-done-${TAG}`}, 1, NOW() - INTERVAL '2 hours')`;
  await q`INSERT INTO payment_transactions(id, org_id, kind, amount_cents, currency, status, club_name, card_last4, po_ref, source_email_message_id, attempt, error, created_at)
    VALUES(${failedId}, ${ORG}, 'club_charge', 6789, 'USD', 'failed', 'Allstate', '7788', '441233', ${`failed-${TAG}@mail.gmail.com`}, 1, 'Square payment failed (HTTP 400)', NOW() - INTERVAL '1 hour')`;
  const r = await listStagedChargesCore(ACTOR);
  check("list ok", r.ok === true && Array.isArray(r.data), JSON.stringify(r));
  const idx = (id) => r.data.findIndex((d) => d.id === id);
  check("list newest first (staged now → failed 1h ago → charged 2h ago)", idx(chargedId) > idx(failedId) && idx(failedId) > 0 && r.data[0].status === "staged", JSON.stringify(r.data.map((d) => `${d.id}:${d.status}`)));
  check("list includes staged rows from the scan", r.data.some((d) => d.status === "staged"), JSON.stringify(r.data.map((d) => d.status)));
  check("list rows seroval-safe (no undefined props)", r.data.every((d) => Object.values(d).every((v) => v !== undefined)), JSON.stringify(r.data[0]));
  const denied = await listStagedChargesCore(WRONG_ACTOR);
  check("list: contractor actor → unauthorized", denied.ok === false && denied.code === "unauthorized", JSON.stringify(denied));
  const other = await listStagedChargesCore(OTHER_ACTOR);
  check("list is org-scoped (ORG2 sees only its own)", other.ok === true && other.data.every((d) => d.orgId === ORG2), JSON.stringify(other.data.map((d) => d.orgId)));
}

/* ============ 6) charge success: Square call shape + transition ============ */
{
  const { fetchImpl, squareCalls } = makeSquare({ mode: "ok" });
  const rows = await q`SELECT id FROM payment_transactions WHERE org_id=${ORG} AND status='staged' AND kind='club_charge' AND source_email_message_id=${MAIL[0].messageId} LIMIT 1`;
  const txnId = String(rows[0].id);
  await q`UPDATE payment_transactions SET card_source_id='ccof:qa_card_on_file' WHERE id=${txnId}`;
  const r = await chargeStagedCore(ACTOR, { txnId }, { fetchImpl });
  check("charge ok → charged", r.ok === true && r.data.status === "charged", JSON.stringify(r));
  check("charge records square payment id + attempt 1", r.data.squarePaymentId === "pymt_club_1" && r.data.attempt === 1 && r.data.idempotencyKey === `club-${txnId}-1`, JSON.stringify(r.data));
  const call = squareCalls[0];
  check("Square auth header = Bearer <secret token>", call.headers.authorization === "Bearer test-square-token", JSON.stringify(call.headers));
  check("Square body: idempotency key club-<id>-1 + amount cents + currency + source + location", call.body.idempotency_key === `club-${txnId}-1` && call.body.amount_money.amount === 8500 && call.body.amount_money.currency === "USD" && call.body.source_id === "ccof:qa_card_on_file" && call.body.location_id === "loc_test", JSON.stringify(call.body));
  check("Square note carries club + PO attribution", String(call.body.note).includes("Allied Dispatch") && String(call.body.note).includes("88231"), JSON.stringify(call.body.note));
  check("exactly one Square call (no retry loop)", squareCalls.length === 1, JSON.stringify(squareCalls.length));
  const aud = await q`SELECT action, actor_role, detail FROM audit_log WHERE org_id=${ORG} AND action='payment_charge_charged'`;
  check("audit payment_charge_charged (owner actor)", aud.length === 1 && String(aud[0].actor_role) === "owner" && aud[0].detail.paymentId === "pymt_club_1", JSON.stringify(aud));
  // A charged row can't be charged again.
  const again = await chargeStagedCore(ACTOR, { txnId }, { fetchImpl });
  check("already charged → invalid_state, no second Square call", again.ok === false && again.code === "invalid_state" && squareCalls.length === 1, JSON.stringify(again));
}

/* ============ 7) charge failure: 400 → failed + attempt bumps ============ */
{
  const { fetchImpl, squareCalls } = makeSquare({ mode: "fail" });
  const rows = await q`SELECT id FROM payment_transactions WHERE org_id=${ORG} AND status='staged' AND kind='club_charge' AND source_email_message_id=${MAIL[2].messageId} LIMIT 1`;
  const txnId = String(rows[0].id);
  await q`UPDATE payment_transactions SET card_source_id='cnon:qa_nonce' WHERE id=${txnId}`;
  const r = await chargeStagedCore(ACTOR, { txnId }, { fetchImpl });
  check("400 → failed with error + attempt 1", r.ok === false && r.code === "square_failed" && r.retryable === true && String(r.message).includes("CARD_DECLINED"), JSON.stringify(r));
  const dbRow = await q`SELECT status, error, attempt, idempotency_key FROM payment_transactions WHERE id=${txnId}`;
  check("row failed + error + attempt 1 + key recorded", String(dbRow[0].status) === "failed" && String(dbRow[0].error).includes("CARD_DECLINED") && Number(dbRow[0].attempt) === 1 && String(dbRow[0].idempotency_key) === `club-${txnId}-1`, JSON.stringify(dbRow));
  // Retry after confirmed failure uses a FRESH attempt → fresh key (the first
  // was declined; no double-charge risk).
  const r2 = await chargeStagedCore(ACTOR, { txnId }, { fetchImpl });
  check("retry → attempt 2 + fresh key club-<id>-2", r2.ok === false && squareCalls.length === 2 && squareCalls[1].body.idempotency_key === `club-${txnId}-2`, JSON.stringify(squareCalls.map((c) => c.body.idempotency_key)));
  const dbRow2 = await q`SELECT attempt, idempotency_key FROM payment_transactions WHERE id=${txnId}`;
  check("row attempt 2 + key club-<id>-2 persisted", Number(dbRow2[0].attempt) === 2 && String(dbRow2[0].idempotency_key) === `club-${txnId}-2`, JSON.stringify(dbRow2));
  const aud = await q`SELECT COUNT(*)::int AS n FROM audit_log WHERE org_id=${ORG} AND action='payment_charge_failed'`;
  check("audit payment_charge_failed recorded", Number(aud[0].n) >= 1, JSON.stringify(aud));
}

/* ============ 8) network blip: row stays staged, retry replays SAME key ============ */
{
  const { fetchImpl, squareCalls, paymentIds } = makeSquare({ mode: "blip-then-ok" });
  const rows = await q`SELECT id FROM payment_transactions WHERE org_id=${ORG} AND status='staged' AND kind='club_charge' AND source_email_message_id=${MAIL[1].messageId} LIMIT 1`;
  const txnId = String(rows[0].id);
  await q`UPDATE payment_transactions SET card_source_id='ccof:qa_honk_card' WHERE id=${txnId}`;
  const r = await chargeStagedCore(ACTOR, { txnId }, { fetchImpl });
  check("blip → retryable error", r.ok === false && r.retryable === true && String(r.message).includes("fetch failed"), JSON.stringify(r));
  const dbRow = await q`SELECT status, attempt, idempotency_key FROM payment_transactions WHERE id=${txnId}`;
  check("blip → row STAYS staged, attempt unchanged (0)", String(dbRow[0].status) === "staged" && Number(dbRow[0].attempt) === 0 && dbRow[0].idempotency_key == null, JSON.stringify(dbRow));
  const r2 = await chargeStagedCore(ACTOR, { txnId }, { fetchImpl });
  check("retry after blip → charged (same attempt reused)", r2.ok === true && r2.data.attempt === 1 && r2.data.idempotencyKey === `club-${txnId}-1`, JSON.stringify(r2));
  check("BOTH Square calls used the SAME idempotency key (replay-safe)", squareCalls.length === 2 && squareCalls[0].body.idempotency_key === `club-${txnId}-1` && squareCalls[1].body.idempotency_key === `club-${txnId}-1`, JSON.stringify(squareCalls.map((c) => c.body.idempotency_key)));
  check("same payment returned for the replayed key (no double charge)", paymentIds.get(`club-${txnId}-1`) === r2.data.squarePaymentId && squareCalls[0].body.idempotency_key === squareCalls[1].body.idempotency_key, JSON.stringify(r2.data.squarePaymentId));
}

/* ============ 9) charge rails: missing source, cross-org, role gate ============ */
{
  const r = await stageClubChargeCore(ACTOR, { amountCents: 3000, clubName: "Honk", messageId: `nosrc-${TAG}@mail.gmail.com` });
  const txnId = r.ok ? r.data.id : "";
  const noSrc = await chargeStagedCore(ACTOR, { txnId }, { fetchImpl: async () => { throw new Error("unexpected Square call"); } });
  check("no tokenized source → square_source_missing (caveat surfaced)", noSrc.ok === false && noSrc.code === "square_source_missing" && noSrc.retryable === true && String(noSrc.message).includes("card on file"), JSON.stringify(noSrc));
  const rows = await q`SELECT id FROM payment_transactions WHERE org_id=${ORG2} AND kind='club_charge' LIMIT 1`;
  const crossOrg = await chargeStagedCore(ACTOR, { txnId: String(rows[0].id) }, { fetchImpl: async () => { throw new Error("unexpected Square call"); } });
  check("charge: other org's txn → not_found", crossOrg.ok === false && crossOrg.code === "not_found", JSON.stringify(crossOrg));
  const denied = await chargeStagedCore(WRONG_ACTOR, { txnId }, { fetchImpl: async () => { throw new Error("unexpected Square call"); } });
  check("charge: contractor actor → unauthorized", denied.ok === false && denied.code === "unauthorized", JSON.stringify(denied));
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

/* ============ 11) card on file: Cards API request shape + persist ============ */
// Mock Square handling BOTH the Cards API (POST /v2/cards, DELETE /v2/cards/{id})
// and the Payments API (POST /v2/payments) — records every call. Card ids are
// derived deterministically from the source nonce (one nonce → one ccof card).
// modes: 'ok' | 'card-fail' (Cards POST 400) | 'delete-fail' (Cards DELETE 500).
function makeCardsSquare({ mode = "ok" } = {}) {
  const squareCalls = [];
  const cardIds = new Map();
  const paymentIds = new Map();
  let paymentSeq = 0;
  const ccofFor = (sourceId) => {
    const slug = String(sourceId).replace(/^cnon:/, "").replace(/[^A-Za-z0-9]/g, "_");
    const id = `ccof:qa_${slug}`;
    cardIds.set(sourceId, id);
    return id;
  };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    if (method === "POST" && u === "https://connect.squareup.com/v2/cards") {
      const body = JSON.parse(String(init.body));
      squareCalls.push({ url: u, method, body, headers: init.headers });
      if (mode === "card-fail") return resp(400, { json: { errors: [{ code: "VALIDATION_ERROR", detail: "Invalid card data." }] } });
      const cardId = cardIds.get(body.source_id) ?? ccofFor(body.source_id);
      return resp(200, { json: { card: { id: cardId, card_brand: "VISA", last_4: "4242" } } });
    }
    if (method === "DELETE" && u.startsWith("https://connect.squareup.com/v2/cards/")) {
      squareCalls.push({ url: u, method, headers: init.headers });
      if (mode === "delete-fail") return resp(500, { json: { errors: [{ code: "INTERNAL_SERVER_ERROR" }] } });
      const id = decodeURIComponent(u.split("/").pop());
      if (id === "ccof:qa_gone") return resp(404, { json: { errors: [{ code: "NOT_FOUND" }] } });
      return resp(200, { json: { card: { id } } });
    }
    if (method === "POST" && u === "https://connect.squareup.com/v2/payments") {
      const body = JSON.parse(String(init.body));
      squareCalls.push({ url: u, method, body, headers: init.headers });
      if (!paymentIds.has(body.idempotency_key)) paymentIds.set(body.idempotency_key, `pymt_club_${++paymentSeq}`);
      const paymentId = paymentIds.get(body.idempotency_key);
      return resp(200, { json: { payment: { id: paymentId, status: "COMPLETED", receipt_url: `https://square.link/receipt/${paymentId}` } } });
    }
    throw new Error(`unexpected Square call: ${method} ${u}`);
  };
  return { fetchImpl, squareCalls, cardIds, paymentIds };
}
{
  const { fetchImpl, squareCalls } = makeCardsSquare();
  const r = await createClubCardCore(ACTOR, { clubName: "Allied Dispatch", sourceId: "cnon:qa_webpayments_nonce_1" }, { fetchImpl });
  check("createClubCard ok → ccof + brand + last4 + org", r.ok === true && r.data.squareCardId.startsWith("ccof:") && r.data.brand === "VISA" && r.data.last4 === "4242" && r.data.clubName === "Allied Dispatch" && r.data.orgId === ORG, JSON.stringify(r));
  const call = squareCalls[0];
  check("Cards API POST /v2/cards with Bearer", call.method === "POST" && call.url === "https://connect.squareup.com/v2/cards" && call.headers.authorization === "Bearer test-square-token", JSON.stringify(call));
  check("body: source_id = nonce + idempotency key 8–45 chars", call.body.source_id === "cnon:qa_webpayments_nonce_1" && typeof call.body.idempotency_key === "string" && call.body.idempotency_key.length >= 8 && call.body.idempotency_key.length <= 45, JSON.stringify(call.body));
  check("body: billing_address + cardholder_name, PAN never sent", call.body.card && call.body.card.billing_address && call.body.card.billing_address.postal_code === "06606" && call.body.card.billing_address.country === "US" && call.body.card.cardholder_name === "Lightning Roadside Assistants LLC" && !JSON.stringify(call.body).includes("4242".padStart(16, "4")), JSON.stringify(call.body));
  const rows = await q`SELECT * FROM motor_club_cards WHERE org_id=${ORG}`;
  check("card row persisted (club, square_card_id, brand, last4)", rows.length === 1 && String(rows[0].club_name) === "Allied Dispatch" && String(rows[0].square_card_id).startsWith("ccof:") && String(rows[0].brand) === "VISA" && String(rows[0].last4) === "4242", JSON.stringify(rows));
  const aud = await q`SELECT action, detail, actor_role FROM audit_log WHERE org_id=${ORG} AND action='payment_club_card_saved'`;
  check("audit payment_club_card_saved (owner, last4 only, never PAN)", aud.length === 1 && String(aud[0].actor_role) === "owner" && aud[0].detail.last4 === "4242" && !JSON.stringify(aud[0].detail).includes("4242".padStart(16, "4")), JSON.stringify(aud));
  const list = await listClubCardsCore(ACTOR);
  check("listClubCards seroval-safe (no undefined)", list.ok === true && list.data.length === 1 && list.data[0].squareCardId.startsWith("ccof:") && Object.values(list.data[0]).every((v) => v !== undefined), JSON.stringify(list));
}
/* ============ 12) duplicate club card → UPSERT (replace, not duplicate) ============ */
{
  const before = await q`SELECT square_card_id FROM motor_club_cards WHERE org_id=${ORG}`;
  const oldSquareId = String(before[0].square_card_id);
  const { fetchImpl, squareCalls } = makeCardsSquare();
  const r2 = await createClubCardCore(ACTOR, { clubName: "Allied Dispatch", sourceId: "cnon:qa_webpayments_nonce_2" }, { fetchImpl });
  check("re-add same club ok → new ccof stored", r2.ok === true && r2.data.squareCardId.startsWith("ccof:"), JSON.stringify(r2));
  const rows = await q`SELECT * FROM motor_club_cards WHERE org_id=${ORG}`;
  check("exactly ONE row per club (upsert)", rows.length === 1, JSON.stringify(rows));
  const row = rows[0];
  check("row now points at the NEW ccof card", String(row.square_card_id) === r2.data.squareCardId && String(row.square_card_id) !== oldSquareId, JSON.stringify(row));
  const deletes = squareCalls.filter((c) => c.method === "DELETE");
  check("replaced Square card best-effort DELETEd", deletes.length === 1 && deletes[0].url === `https://connect.squareup.com/v2/cards/${encodeURIComponent(oldSquareId)}`, JSON.stringify(deletes));
  const creates = squareCalls.filter((c) => c.method === "POST" && c.url === "https://connect.squareup.com/v2/cards");
  check("one Create in this run with a fresh idempotency key ≤ 45", creates.length === 1 && typeof creates[0].body.idempotency_key === "string" && creates[0].body.idempotency_key.length <= 45, JSON.stringify(creates.map((c) => c.body.idempotency_key)));
}
/* ============ 13) deleteClubCard: DELETE + 404-already-gone + 500 keeps row ============ */
{
  const list = await listClubCardsCore(ACTOR);
  const cardId = list.data[0].id;
  const squareId = list.data[0].squareCardId;
  const { fetchImpl, squareCalls } = makeCardsSquare();
  const r = await deleteClubCardCore(ACTOR, { clubCardId: cardId }, { fetchImpl });
  check("delete ok → removed from Square", r.ok === true && r.data.removedFromSquare === true && r.data.id === cardId, JSON.stringify(r));
  check("DELETE /v2/cards/{id} with Bearer", squareCalls.length === 1 && squareCalls[0].method === "DELETE" && squareCalls[0].url === `https://connect.squareup.com/v2/cards/${encodeURIComponent(squareId)}` && squareCalls[0].headers.authorization === "Bearer test-square-token", JSON.stringify(squareCalls));
  const gone = await q`SELECT COUNT(*)::int AS n FROM motor_club_cards WHERE id=${cardId} AND org_id=${ORG}`;
  check("local row deleted", Number(gone[0].n) === 0, JSON.stringify(gone));
  const aud = await q`SELECT action, detail FROM audit_log WHERE org_id=${ORG} AND action='payment_club_card_removed'`;
  check("audit payment_club_card_removed", aud.length === 1 && aud[0].detail.removedFromSquare === true, JSON.stringify(aud));
  // Square 404 → treated as already removed (local row still deleted).
  await q`INSERT INTO motor_club_cards(id, org_id, club_name, square_card_id, brand, last4) VALUES(${`clubcard-gone-${TAG}`}, ${ORG}, 'Gone Club', 'ccof:qa_gone', 'VISA', '1234')`;
  const r404 = await deleteClubCardCore(ACTOR, { clubCardId: `clubcard-gone-${TAG}` }, { fetchImpl });
  check("Square 404 → removed locally, removedFromSquare false", r404.ok === true && r404.data.removedFromSquare === false, JSON.stringify(r404));
  const gone404 = await q`SELECT COUNT(*)::int AS n FROM motor_club_cards WHERE id=${`clubcard-gone-${TAG}`}`;
  check("404 path deleted the local row too", Number(gone404[0].n) === 0, JSON.stringify(gone404));
  // Square 500 → local row kept + square_failed retryable.
  await q`INSERT INTO motor_club_cards(id, org_id, club_name, square_card_id, brand, last4) VALUES(${`clubcard-keep-${TAG}`}, ${ORG}, 'Keep Club', 'ccof:qa_keep', 'VISA', '9999')`;
  const { fetchImpl: fFail } = makeCardsSquare({ mode: "delete-fail" });
  const rFail = await deleteClubCardCore(ACTOR, { clubCardId: `clubcard-keep-${TAG}` }, { fetchImpl: fFail });
  check("Square 500 → square_failed retryable, row kept", rFail.ok === false && rFail.code === "square_failed" && rFail.retryable === true, JSON.stringify(rFail));
  const kept = await q`SELECT COUNT(*)::int AS n FROM motor_club_cards WHERE id=${`clubcard-keep-${TAG}`}`;
  check("failed delete left the local row", Number(kept[0].n) === 1, JSON.stringify(kept));
  await q`DELETE FROM motor_club_cards WHERE id=${`clubcard-keep-${TAG}`}`;
}
/* ============ 14) chargeStaged AUTO-resolves the club's stored ccof ============ */
{
  const { fetchImpl, squareCalls } = makeCardsSquare();
  await createClubCardCore(ACTOR, { clubName: "Allied Dispatch", sourceId: "cnon:qa_webpayments_nonce_3" }, { fetchImpl });
  const staged = await stageClubChargeCore(ACTOR, { amountCents: 8500, clubName: "Allied Dispatch", cardLast4: "4242", poRef: "88231", messageId: `ccof-${TAG}@mail.gmail.com` });
  check("staged row for Allied (no card_source_id)", staged.ok === true && staged.data.cardSourceId === null && staged.data.status === "staged", JSON.stringify(staged));
  const r = await chargeStagedCore(ACTOR, { txnId: staged.data.id }, { fetchImpl });
  check("charge ok via auto-resolved ccof → charged", r.ok === true && r.data.status === "charged", JSON.stringify(r));
  const payCall = squareCalls.find((c) => c.method === "POST" && c.url === "https://connect.squareup.com/v2/payments");
  check("Square payment used source_id = stored ccof (not a nonce)", payCall && payCall.body.source_id.startsWith("ccof:") && payCall.body.source_id !== "cnon:qa_webpayments_nonce_3", JSON.stringify(payCall?.body));
  check("payment body amount/currency/location correct", payCall.body.amount_money.amount === 8500 && payCall.body.amount_money.currency === "USD" && payCall.body.location_id === "loc_test", JSON.stringify(payCall.body));
  const dbRow = await q`SELECT card_source_id FROM payment_transactions WHERE id=${staged.data.id}`;
  check("resolved ccof persisted on the ledger row", String(dbRow[0].card_source_id).startsWith("ccof:"), JSON.stringify(dbRow));
  // No club card on file → still fails cleanly, ZERO Square calls.
  const staged2 = await stageClubChargeCore(ACTOR, { amountCents: 12950, clubName: "Honk", messageId: `nosrc2-${TAG}@mail.gmail.com` });
  const before = squareCalls.length;
  const noCard = await chargeStagedCore(ACTOR, { txnId: staged2.data.id }, { fetchImpl });
  check("no stored card → square_source_missing retryable", noCard.ok === false && noCard.code === "square_source_missing" && noCard.retryable === true && String(noCard.message).includes("card on file"), JSON.stringify(noCard));
  check("zero NEW Square calls when the source is missing", squareCalls.length === before, JSON.stringify(squareCalls.length));
  const dbRow2 = await q`SELECT status, card_source_id FROM payment_transactions WHERE id=${staged2.data.id}`;
  check("row untouched (staged, no source)", String(dbRow2[0].status) === "staged" && dbRow2[0].card_source_id == null, JSON.stringify(dbRow2));
}
/* ============ 15) org scoping + role gates (card ops) ============ */
{
  const { fetchImpl } = makeCardsSquare();
  const otherList = await listClubCardsCore(OTHER_ACTOR);
  check("listClubCards org-scoped (ORG2 sees none of ORG's)", otherList.ok === true && otherList.data.length === 0, JSON.stringify(otherList));
  const list = await listClubCardsCore(ACTOR);
  const crossDel = await deleteClubCardCore(OTHER_ACTOR, { clubCardId: list.data[0].id }, { fetchImpl });
  check("delete: other org's card → not_found", crossDel.ok === false && crossDel.code === "not_found", JSON.stringify(crossDel));
  const deniedCreate = await createClubCardCore(WRONG_ACTOR, { clubName: "Allstate", sourceId: "cnon:qa_nope" }, { fetchImpl });
  check("create: contractor → unauthorized", deniedCreate.ok === false && deniedCreate.code === "unauthorized", JSON.stringify(deniedCreate));
  const deniedList = await listClubCardsCore(WRONG_ACTOR);
  check("list: contractor → unauthorized", deniedList.ok === false && deniedList.code === "unauthorized", JSON.stringify(deniedList));
  const deniedDelete = await deleteClubCardCore(WRONG_ACTOR, { clubCardId: "x" }, { fetchImpl });
  check("delete: contractor → unauthorized", deniedDelete.ok === false && deniedDelete.code === "unauthorized", JSON.stringify(deniedDelete));
  const deniedTips = await listTipsCore(WRONG_ACTOR);
  check("listTips: contractor → unauthorized", deniedTips.ok === false && deniedTips.code === "unauthorized", JSON.stringify(deniedTips));
  const adminCreate = await createClubCardCore(ADMIN_ACTOR, { clubName: "Allstate", sourceId: "cnon:qa_admin_nonce" }, { fetchImpl });
  check("admin can store a club card", adminCreate.ok === true && adminCreate.data.clubName === "Allstate", JSON.stringify(adminCreate));
}
/* ============ 16) invalid input + Square not configured ============ */
{
  const bad = await createClubCardCore(ACTOR, { clubName: "Honk", sourceId: "short" });
  check("short sourceId → invalid_input", bad.ok === false && bad.code === "invalid_input", JSON.stringify(bad));
  // The not-configured path only triggers when the env has NO Square creds.
  const saved = { t: process.env.SQUARE_ACCESS_TOKEN, l: process.env.SQUARE_LOCATION_ID, a: process.env.SQUARE_APPLICATION_ID };
  delete process.env.SQUARE_ACCESS_TOKEN; delete process.env.SQUARE_LOCATION_ID; delete process.env.SQUARE_APPLICATION_ID;
  const noConfig = await createClubCardCore(ACTOR, { clubName: "Honk", sourceId: "cnon:qa_config_nonce" }, { squareStableDir: `/tmp/square-missing-${Date.now()}` });
  check("missing Square creds → square_not_configured", noConfig.ok === false && noConfig.code === "square_not_configured" && String(noConfig.message).includes("missing"), JSON.stringify(noConfig));
  const cfg = await getPaymentSquareConfigCore({ squareStableDir: `/tmp/square-missing-${Date.now()}` });
  check("public config missing → square_not_configured", cfg.ok === false && cfg.code === "square_not_configured", JSON.stringify(cfg));
  process.env.SQUARE_ACCESS_TOKEN = saved.t; process.env.SQUARE_LOCATION_ID = saved.l; process.env.SQUARE_APPLICATION_ID = saved.a;
  const cfgOk = await getPaymentSquareConfigCore();
  check("public config → app id + location id ONLY (no token)", cfgOk.ok === true && cfgOk.data.applicationId === "app_test" && cfgOk.data.locationId === "loc_test" && !JSON.stringify(cfgOk).includes("test-square-token"), JSON.stringify(cfgOk));
}
/* ============ 17) listTips: driver attribution via completion_tips join ============ */
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
/* ============ 18) approval gate: staging NEVER charges; no funds ever transfer ============ */
{
  // Full end-to-end: a fresh club-charge email is scanned + staged, and the
  // engine makes ZERO Square calls of any kind until the owner EXPLICITLY taps
  // Charge (chargeStagedCore). A stored club card is only charged after that
  // explicit per-row approval — nothing is ever auto-charged.
  const { fetchImpl, squareCalls } = makeCardsSquare();
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
  check("gate: scan staged exactly 1 fresh Allied charge", scan.ok === true && scan.staged === 1 && scan.skipped === 0, JSON.stringify(scan));
  check("gate: scan/stage made ZERO Square calls (nothing auto-charged)", squareCalls.length === 0, JSON.stringify(squareCalls));
  const stagedRow = await q`SELECT * FROM payment_transactions WHERE org_id=${ORG} AND source_email_message_id=${gateMail.messageId} LIMIT 1`;
  check("gate: staged row exists, status staged, no payment id", stagedRow.length === 1 && String(stagedRow[0].status) === "staged" && stagedRow[0].square_payment_id == null, JSON.stringify(stagedRow));
  // Add the club's card on file (Cards API only — still no payment).
  const card = await createClubCardCore(ACTOR, { clubName: "Allied Dispatch", sourceId: "cnon:qa_gate_nonce" }, { fetchImpl });
  check("gate: card stored via Cards API", card.ok === true && card.data.squareCardId.startsWith("ccof:"), JSON.stringify(card));
  check("gate: storing the card made NO payment calls", squareCalls.filter((c) => c.method === "POST" && c.url === "https://connect.squareup.com/v2/payments").length === 0, JSON.stringify(squareCalls));
  // NOW the explicit owner approval: tap Charge on that one row.
  const charge = await chargeStagedCore(ACTOR, { txnId: String(stagedRow[0].id) }, { fetchImpl });
  check("gate: explicit chargeStagedCore → charged", charge.ok === true && charge.data.status === "charged" && charge.data.squarePaymentId != null, JSON.stringify(charge));
  const paymentCalls = squareCalls.filter((c) => c.method === "POST" && c.url === "https://connect.squareup.com/v2/payments");
  check("gate: exactly ONE payment call after explicit approval", paymentCalls.length === 1, JSON.stringify(squareCalls));
  check("gate: payment source is the stored ccof card", paymentCalls[0].body.source_id.startsWith("ccof:"), JSON.stringify(paymentCalls[0].body));
  // The engine may ONLY ever touch /v2/cards and /v2/payments — never a
  // transfer/payout/bank endpoint: funds never LEAVE the owner's Square
  // balance (Square settles club charges INTO it; the owner's own rails send
  // payouts out, and that is a different, owner-executed flow).
  const badUrls = squareCalls.filter((c) => !c.url.startsWith("https://connect.squareup.com/v2/cards") && c.url !== "https://connect.squareup.com/v2/payments");
  check("no transfer/payout/bank-account endpoints ever called (funds never transferred out)", badUrls.length === 0, JSON.stringify(badUrls));
  const allUrls = squareCalls.map((c) => c.url);
  check("every Square call this section is Cards or Payments API", allUrls.every((u) => u.startsWith("https://connect.squareup.com/v2/cards") || u === "https://connect.squareup.com/v2/payments"), JSON.stringify(allUrls));
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
