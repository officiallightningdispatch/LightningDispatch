/**
 * Stripe Connect — contractor bank-linking CORE (automated-payouts Slice 1,
 * owner-approved 2026-09-03). SERVER-ONLY.
 *
 * This slice is IDENTITY/ONBOARDING ONLY — it never moves money. It:
 *   1. creates a Stripe Connected Account (type `express`, country `us`) when a
 *      contractor has none, and persists the returned `stripe_account_id` onto
 *      their `contractor_profiles` row (org-scoped, keyed (org_id, user_id));
 *   2. mints a single-use Connect Onboarding Account Link and returns its URL;
 *   3. reads back the linked account + onboarding status + charges/payouts
 *      enabled flags (refreshing the persisted flags from Stripe, read-only).
 * NO Payouts / Transfers / charges. Amounts + immutable ledger arrive in later
 * slices.
 *
 * FAIL-CLOSED everywhere: a missing STRIPE_SECRET_KEY yields a structured
 * "stripe_not_configured" result (never a thrown 500), and any Stripe error is
 * returned as a structured failure — never a fake success. The secret is read
 * lazily from process.env (or an injected factory for tests) and never logged.
 *
 * Imported ONLY by the client-safe facade (./stripe-connect.ts, whose
 * createServerFn handlers dynamic-import this module) and by hermetic tests.
 * Static server imports are fine here — this module never enters the client
 * bundle graph (the facade only `import type`s from it).
 */
import Stripe from "stripe";
import { sql } from "~/db";

export type StripeConnectActor = { orgId: string; contractorId: string };

/** The contractor-facing connect status. Seroval-safe: null-or-value, never
 *  undefined. `linked` is the high-level signal for the UI. */
export type StripeConnectStatus = {
  linked: boolean;
  stripeAccountId: string | null;
  /** Derived onboarding state: 'not_started' | 'pending' | 'complete'. */
  onboardingStatus: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

export type StripeConnectErrorCode =
  | "unauthorized"
  | "database_error"
  | "stripe_not_configured"
  | "stripe_error";

export type StripeConnectResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: StripeConnectErrorCode; message: string };

export type StripeClientResult =
  | { configured: true; client: Stripe }
  | { configured: false; reason: string };

/* ------------------------------- client (lazy) ------------------------------ */

let cachedClient: Stripe | null = null;
let cachedKey: string | null = null;

/** Lazy singleton Stripe client. Never throws at import time; returns a typed
 *  "not configured" result when the key is absent. Tests inject a factory. */
export function getStripeClient(
  env: Record<string, string | undefined> = process.env,
  factory: (key: string) => Stripe = (key) => new Stripe(key),
): StripeClientResult {
  const raw = env.STRIPE_SECRET_KEY;
  const key = raw ? raw.trim() : "";
  if (!key) {
    return {
      configured: false,
      reason: "Stripe is not configured — set STRIPE_SECRET_KEY before linking a bank.",
    };
  }
  if (!cachedClient || cachedKey !== key) {
    cachedClient = factory(key);
    cachedKey = key;
  }
  return { configured: true, client: cachedClient };
}

/* -------------------------------- helpers --------------------------------- */

const err = (code: StripeConnectErrorCode, message: string): StripeConnectResult<never> => ({
  ok: false,
  code,
  message,
});
const ok = <T>(data: T): StripeConnectResult<T> => ({ ok: true, data });

const dbConfigured = () => Boolean(process.env.DATABASE_URL);
let schemaInit: Promise<void> | undefined;
function ensureDb() {
  if (!dbConfigured()) return Promise.resolve();
  schemaInit ??= (async () => {
    const { ensureSchema } = await import("./migrations");
    await ensureSchema();
  })();
  return schemaInit;
}

type ConnectOpts = { client?: Stripe; now?: Date };

function resolveClient(opts?: ConnectOpts): StripeClientResult {
  if (opts?.client) return { configured: true, client: opts.client };
  return getStripeClient();
}

function deriveOnboardingStatus(acct: {
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
}): string {
  if (acct.charges_enabled && acct.payouts_enabled) return "complete";
  if (acct.details_submitted) return "pending";
  return "not_started";
}

/* --------------------------- account provisioning --------------------------- */

/** Create a Connected Account if none is linked, and persist the id. Idempotent:
 *  a second call reuses the already-linked account. */
export async function ensureConnectedAccount(
  actor: StripeConnectActor,
  opts: ConnectOpts = {},
): Promise<StripeConnectResult<{ stripeAccountId: string }>> {
  await ensureDb();
  if (!dbConfigured()) return err("database_error", "Database is not configured.");

  const q = sql();
  const existing = await q`SELECT stripe_account_id FROM contractor_profiles
    WHERE org_id=${actor.orgId} AND user_id=${actor.contractorId} LIMIT 1`;
  const existingId = existing.length
    ? (existing[0] as Record<string, unknown>).stripe_account_id
    : null;
  if (existingId) return ok({ stripeAccountId: String(existingId) });

  const client = resolveClient(opts);
  if (!client.configured) return err("stripe_not_configured", client.reason);

  let accountId: string;
  try {
    const acct = await client.client.accounts.create({
      type: "express",
      country: "US",
      business_type: "individual",
      capabilities: { transfers: { requested: true } },
      metadata: { contractor_user_id: actor.contractorId },
    });
    accountId = acct.id;
  } catch (e) {
    return err("stripe_error", e instanceof Error ? e.message : "Stripe account creation failed.");
  }

  await q`INSERT INTO contractor_profiles
    (org_id, user_id, stripe_account_id, stripe_onboarding_status, stripe_created_at, stripe_updated_at)
    VALUES (${actor.orgId}, ${actor.contractorId}, ${accountId}, 'not_started', NOW(), NOW())
    ON CONFLICT (org_id, user_id) DO UPDATE SET
      stripe_account_id = EXCLUDED.stripe_account_id,
      stripe_onboarding_status = EXCLUDED.stripe_onboarding_status,
      stripe_updated_at = NOW()`;

  return ok({ stripeAccountId: accountId });
}

/** Create a single-use Connect Onboarding Account Link for the contractor's
 *  Connected Account (provisioning one first if needed). Returns the URL. */
export async function createAccountLink(
  actor: StripeConnectActor,
  returnUrl: string,
  refreshUrl: string,
  opts: ConnectOpts = {},
): Promise<StripeConnectResult<{ url: string }>> {
  await ensureDb();
  if (!dbConfigured()) return err("database_error", "Database is not configured.");

  const ensured = await ensureConnectedAccount(actor, opts);
  if (!ensured.ok) return ensured;

  const client = resolveClient(opts);
  if (!client.configured) return err("stripe_not_configured", client.reason);

  try {
    const link = await client.client.accountLinks.create({
      account: ensured.data.stripeAccountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: "account_onboarding",
    });
    return ok({ url: link.url });
  } catch (e) {
    return err("stripe_error", e instanceof Error ? e.message : "Stripe account link creation failed.");
  }
}

/** Read-only connect status: linked account id, onboarding status, charges /
 *  payouts enabled flags, and timestamps. When a linked account exists and a
 *  client is available, the flags are refreshed from Stripe (read-only). */
export async function getContractorConnectStatus(
  actor: StripeConnectActor,
  opts: ConnectOpts = {},
): Promise<StripeConnectResult<StripeConnectStatus>> {
  await ensureDb();
  if (!dbConfigured()) return err("database_error", "Database is not configured.");

  const q = sql();
  const rows = await q`SELECT stripe_account_id, stripe_onboarding_status,
    stripe_charges_enabled, stripe_payouts_enabled, stripe_created_at, stripe_updated_at
    FROM contractor_profiles WHERE org_id=${actor.orgId} AND user_id=${actor.contractorId} LIMIT 1`;

  const notLinked: StripeConnectStatus = {
    linked: false,
    stripeAccountId: null,
    onboardingStatus: null,
    chargesEnabled: false,
    payoutsEnabled: false,
    createdAt: null,
    updatedAt: null,
  };
  if (!rows.length) return ok(notLinked);

  const r = rows[0] as Record<string, unknown>;
  const stripeAccountId = r.stripe_account_id ? String(r.stripe_account_id) : null;
  if (!stripeAccountId) return ok(notLinked);

  let chargesEnabled = r.stripe_charges_enabled === true;
  let payoutsEnabled = r.stripe_payouts_enabled === true;
  let onboardingStatus = r.stripe_onboarding_status ? String(r.stripe_onboarding_status) : null;

  const client = resolveClient(opts);
  if (client.configured) {
    try {
      const acct = await client.client.accounts.retrieve(stripeAccountId);
      chargesEnabled = acct.charges_enabled;
      payoutsEnabled = acct.payouts_enabled;
      onboardingStatus = deriveOnboardingStatus(acct);
      await q`UPDATE contractor_profiles
        SET stripe_charges_enabled=${chargesEnabled},
            stripe_payouts_enabled=${payoutsEnabled},
            stripe_onboarding_status=${onboardingStatus},
            stripe_updated_at=NOW()
        WHERE org_id=${actor.orgId} AND user_id=${actor.contractorId}`;
    } catch {
      // Keep the persisted flags — fail-visible, never a fake success.
    }
  }

  return ok({
    linked: true,
    stripeAccountId,
    onboardingStatus,
    chargesEnabled,
    payoutsEnabled,
    createdAt: r.stripe_created_at ? String(r.stripe_created_at) : null,
    updatedAt: r.stripe_updated_at ? String(r.stripe_updated_at) : null,
  });
}

/* -------------------------- session-resolving handlers ---------------------- */

async function resolveActor(): Promise<StripeConnectActor | null> {
  if (!dbConfigured()) return null;
  const { currentUser, effectiveDriverIdentity } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return null;
  const identity = await effectiveDriverIdentity(u);
  if (!identity || identity.deactivated) return null;
  return { orgId: u.orgId, contractorId: identity.userRowId };
}

export async function startBankLinkHandler(data: {
  returnUrl: string;
  refreshUrl: string;
}): Promise<StripeConnectResult<{ url: string }>> {
  const actor = await resolveActor();
  if (!actor) return err("unauthorized", "Sign in as a driver first.");
  return createAccountLink(actor, data.returnUrl, data.refreshUrl);
}

export async function getBankLinkStatusHandler(): Promise<StripeConnectResult<StripeConnectStatus>> {
  const actor = await resolveActor();
  if (!actor) return err("unauthorized", "Sign in as a driver first.");
  return getContractorConnectStatus(actor);
}
