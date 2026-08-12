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
  check("no tokenized source → square_source_missing (caveat surfaced)", noSrc.ok === false && noSrc.code === "square_source_missing" && noSrc.retryable === true && String(noSrc.message).includes("nonce"), JSON.stringify(noSrc));
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
  (SELECT COUNT(*)::int FROM payment_transactions WHERE org_id LIKE 'qa-payment%') AS txns,
  (SELECT COUNT(*)::int FROM completion_tips WHERE org_id LIKE 'qa-payment%') AS tips,
  (SELECT COUNT(*)::int FROM audit_log WHERE org_id LIKE 'qa-payment%') AS audit,
  (SELECT COUNT(*)::int FROM users WHERE email LIKE 'qa-payment-%@lightning.test' OR email LIKE 'qa-payment2-%@lightning.test') AS users,
  (SELECT COUNT(*)::int FROM organization_memberships WHERE org_id LIKE 'qa-payment%') AS members`;
const z = Number(leftover[0].orgs) === 0 && Number(leftover[0].txns) === 0 && Number(leftover[0].tips) === 0 && Number(leftover[0].audit) === 0 && Number(leftover[0].users) === 0 && Number(leftover[0].members) === 0;
console.log(`cleanup: ${JSON.stringify(leftover[0])}`);
if (!z) { console.error("FAIL: QA cleanup left rows behind"); process.exit(1); }
console.log("payment-engine.test.mjs: cleanup verified — zero QA rows left");
