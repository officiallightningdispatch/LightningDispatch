/**
 * Contractor sign-up-on-login-screen (owner-directed 2026-09-04, "Uber-style
 * onboarding" pulled forward from Phase C) — SERVER-ONLY core.
 *
 * This module is imported ONLY by the client-safe facade (./contractor-signup.ts,
 * whose createServerFn handlers dynamic-import this module) and by hermetic
 * tests. Static server imports are fine here — this module never enters the
 * client bundle graph (the facade only `import type`s from it).
 *
 * Slice 1 scope (tight):
 *   - `signupContractorCore` — public; creates an LD account (role 'contractor')
 *     + organization_memberships row (role 'contractor'), hashes the password
 *     the same way createOwner does. Session start lives in
 *     `signupContractorHandler` (request runtime only). Duplicate email refused
 *     (pre-check + users.email UNIQUE constraint backstop).
 *   - `submitContractorApplicationCore` — signed-in contractor; persists an
 *     application row (status 'submitted') with tools, service_area and phone.
 *     Fail-closed on bad input.
 *   - `getMyApplicationStatusCore` — the signed-in contractor's own application
 *     (or null).
 *   - `listContractorApplicationsCore` / `setContractorApplicationStatusCore` —
 *     owner/admin only, enforced on the actor (fail closed).
 *
 * Actors mirror contractor-admin-core: `{ orgId, id, role }`. The `*Handler`
 * wrappers resolve the actor from the session; the `*Core` functions re-check
 * the role so an unauthorized literal actor is still refused (testable without
 * sessions).
 *
 * State machine is deliberately minimal: 'interested' | 'submitted' |
 * 'activated' | 'waitlisted'. We never hard-reject an applicant: out-of-area
 * goes 'waitlisted' ("coming to your area"). The AI dispatcher's existing
 * missing-compliance exclusion (plus a fresh signup having no Towbook driver
 * id) is the actual "can't receive jobs" enforcement — this slice does not
 * weaken it.
 */
import { z } from "zod";
import { sql } from "~/db";
import { PRODUCTION_ORG_ID } from "./db-guard";
import { ensureAuthSchema, hash, makeId, currentUser, startSession } from "./auth-server";
import { normalizeServiceSelectionType } from "./service-time-core";

export const APPLICATION_STATUSES = ["interested", "submitted", "activated", "waitlisted"] as const;
export type ContractorApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export type SignupActor = { orgId: string; id: string; role: string };

/** Seroval-safe application row crossing to the client. */
export type ContractorApplicationRow = {
  id: string;
  orgId: string;
  userId: string;
  status: ContractorApplicationStatus;
  tools: string[];
  serviceArea: string | null;
  phone: string | null;
  notes: string | null;
  reviewerUserId: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Owner review row: the application plus the applicant's LD identity
 *  (name + email joined from `users`) for the owner dashboard table. */
export type ContractorApplicationWithUser = ContractorApplicationRow & {
  applicantName: string | null;
  applicantEmail: string | null;
};

export type SignupCoreResult = { ok: true; userId: string } | { ok: false; error: string };

export type ApplicationErrorCode = "unauthorized" | "invalid_input" | "duplicate" | "not_found" | "database_error";
export type ApplicationResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ApplicationErrorCode; message: string };

const ok = <T>(data: T): ApplicationResult<T> => ({ ok: true, data });
const err = (code: ApplicationErrorCode, message: string) => ({ ok: false as const, code, message });

const configured = () => Boolean(process.env.DATABASE_URL);
let schemaInit: Promise<void> | undefined;
function ensure() {
  if (!configured()) return Promise.resolve();
  schemaInit ??= (async () => {
    await ensureAuthSchema();
    const { ensureSchema } = await import("./migrations");
    await ensureSchema();
  })();
  return schemaInit;
}

/* ------------------------------- validation ------------------------------- */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const signupSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().min(3).max(254).refine((v) => EMAIL.test(v), "invalid email"),
  password: z.string().min(10).max(256),
});

const applicationSchema = z.object({
  tools: z.array(z.string()).max(50).default([]),
  serviceArea: z.string().trim().max(128).optional().default(""),
  phone: z.string().trim().max(64).optional().default(""),
});

const setStatusSchema = z.object({
  applicationId: z.string().trim().min(1).max(128),
  status: z.enum(APPLICATION_STATUSES),
});

/** Minimal transition table. We never hard-reject: 'waitlisted' is the
 *  "coming to your area" out-of-area state. */
const ALLOWED_TRANSITIONS: Readonly<Record<ContractorApplicationStatus, ContractorApplicationStatus[]>> = {
  interested: ["submitted", "waitlisted"],
  submitted: ["activated", "waitlisted"],
  activated: ["submitted", "waitlisted"],
  waitlisted: ["submitted", "activated"],
};

function mapRow(r: Record<string, unknown>): ContractorApplicationRow {
  const tools = Array.isArray(r.tools) ? r.tools.map(String) : [];
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    userId: String(r.user_id),
    status: String(r.status) as ContractorApplicationStatus,
    tools,
    serviceArea: r.service_area != null ? String(r.service_area) : null,
    phone: r.phone != null ? String(r.phone) : null,
    notes: r.notes != null ? String(r.notes) : null,
    reviewerUserId: r.reviewer_user_id != null ? String(r.reviewer_user_id) : null,
    reviewedAt: r.reviewed_at != null ? new Date(String(r.reviewed_at)).toISOString() : null,
    createdAt: new Date(String(r.created_at)).toISOString(),
    updatedAt: new Date(String(r.updated_at)).toISOString(),
  };
}

/* ------------------------------ account creation ------------------------------ */
/** Public signup: create an LD contractor account. Hashes the password the same
 *  way createOwner does (auth-server.hash). `orgId` defaults to the PROD org —
 *  the test seam passes a QA org so production is never touched. Duplicate
 *  email is refused — pre-check for a clean message, UNIQUE constraint as the
 *  race backstop. */
export async function signupContractorCore(data: unknown, orgId: string = PRODUCTION_ORG_ID): Promise<SignupCoreResult> {
  const parsed = signupSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, error: "Enter your name, a valid email, and a password of at least 10 characters." };
  }
  const { name, email, password } = parsed.data;
  if (!configured()) return { ok: false, error: "Database mode is not active." };
  await ensureAuthSchema();
  const q = sql();

  const orgRows = await q`SELECT id FROM organizations WHERE id = ${orgId} LIMIT 1`;
  if (!orgRows.length) return { ok: false, error: "Contractor sign-up isn't available yet." };

  const existing = await q`SELECT id FROM users WHERE LOWER(email) = ${email} LIMIT 1`;
  if (existing.length) return { ok: false, error: "That email is already registered — sign in instead." };

  const userId = makeId();
  try {
    await q`INSERT INTO users(id, name, email, password_hash) VALUES(${userId}, ${name}, ${email}, ${hash(password)})`;
  } catch (e) {
    if (e instanceof Error && /unique|duplicate|users_email/i.test(e.message)) {
      return { ok: false, error: "That email is already registered — sign in instead." };
    }
    return { ok: false, error: "Unable to create your account right now — please try again." };
  }

  try {
    await q`INSERT INTO organization_memberships(org_id, user_id, role) VALUES(${orgId}, ${userId}, 'contractor')`;
  } catch (e) {
    // Best-effort rollback of the orphaned users row so the email isn't locked.
    await q`DELETE FROM users WHERE id = ${userId}`.catch(() => {});
    return { ok: false, error: "Unable to create your account right now — please try again." };
  }

  return { ok: true, userId };
}

/** Handler form for the facade: PROD org signup + session start (request
 *  runtime only — the core stays directly testable). */
export async function signupContractorHandler(data: unknown): Promise<SignupCoreResult> {
  const res = await signupContractorCore(data);
  if (res.ok) {
    try { await startSession(res.userId); } catch { /* account created; session start is best-effort */ }
  }
  return res;
}

/* ------------------------------ applications ------------------------------ */
const OWNER_ROLES = ["owner", "admin"] as const;

async function resolveActor(): Promise<SignupActor | null> {
  if (!configured()) return null;
  const u = await currentUser();
  if (!u) return null;
  return { orgId: u.orgId, id: u.id, role: u.role };
}

/** The signed-in contractor's own application (or null). */
export async function getMyApplicationStatusCore(actor: SignupActor): Promise<ApplicationResult<ContractorApplicationRow | null>> {
  if (actor.role !== "contractor") return err("unauthorized", "Contractor access required.");
  if (!configured()) return err("database_error", "Applications require database mode.");
  await ensure();
  const q = sql();
  const rows = await q`SELECT id, org_id, user_id, status, tools, service_area, phone, notes, reviewer_user_id, reviewed_at, created_at, updated_at
    FROM contractor_applications WHERE org_id = ${actor.orgId} AND user_id = ${actor.id} LIMIT 1`;
  return ok(rows.length ? mapRow(rows[0] as Record<string, unknown>) : null);
}

/** Signed-in contractor: create/refresh the application row. */
export async function submitContractorApplicationCore(actor: SignupActor, data: unknown): Promise<ApplicationResult<ContractorApplicationRow>> {
  if (actor.role !== "contractor") return err("unauthorized", "Contractor access required.");
  if (!configured()) return err("database_error", "Applications require database mode.");
  const parsed = applicationSchema.safeParse(data ?? {});
  if (!parsed.success) return err("invalid_input", "Invalid application details.");
  await ensure();
  const q = sql();

  const tools = [...new Set(
    parsed.data.tools
      .map((t) => normalizeServiceSelectionType(t))
      .filter((x): x is string => Boolean(x)),
  )].sort();
  const serviceArea = parsed.data.serviceArea || null;
  const phone = parsed.data.phone || null;

  const id = makeId();
  try {
    // One application per (org, user): re-submitting refreshes in place.
    await q`INSERT INTO contractor_applications(id, org_id, user_id, status, tools, service_area, phone, updated_at)
      VALUES(${id}, ${actor.orgId}, ${actor.id}, 'submitted', ${JSON.stringify(tools)}::jsonb, ${serviceArea}, ${phone}, NOW())
      ON CONFLICT (org_id, user_id) DO UPDATE SET
        status='submitted', tools=EXCLUDED.tools, service_area=EXCLUDED.service_area,
        phone=EXCLUDED.phone, updated_at=NOW()`;
  } catch (e) {
    return err("database_error", e instanceof Error ? e.message : "Unable to submit your application.");
  }
  const rows = await q`SELECT id, org_id, user_id, status, tools, service_area, phone, notes, reviewer_user_id, reviewed_at, created_at, updated_at
    FROM contractor_applications WHERE org_id = ${actor.orgId} AND user_id = ${actor.id} LIMIT 1`;
  return ok(mapRow(rows[0] as Record<string, unknown>));
}

/** Owner/admin: all applications for the org, with the applicant's LD name +
 *  email joined from `users` for the owner review table. */
export async function listContractorApplicationsCore(actor: SignupActor): Promise<ApplicationResult<ContractorApplicationWithUser[]>> {
  if (!OWNER_ROLES.includes(actor.role as (typeof OWNER_ROLES)[number])) {
    return err("unauthorized", "Owner access required.");
  }
  if (!configured()) return err("database_error", "Applications require database mode.");
  await ensure();
  const q = sql();
  const rows = await q`SELECT a.id, a.org_id, a.user_id, a.status, a.tools, a.service_area, a.phone, a.notes,
      a.reviewer_user_id, a.reviewed_at, a.created_at, a.updated_at,
      u.name AS applicant_name, u.email AS applicant_email
    FROM contractor_applications a
    LEFT JOIN users u ON u.id = a.user_id
    WHERE a.org_id = ${actor.orgId}
    ORDER BY a.created_at DESC, a.id ASC`;
  return ok((rows as Record<string, unknown>[]).map((r) => ({
    ...mapRow(r),
    applicantName: r.applicant_name != null ? String(r.applicant_name) : null,
    applicantEmail: r.applicant_email != null ? String(r.applicant_email) : null,
  })));
}

/** Owner/admin: move an application between states. Records reviewer_user_id
 *  + reviewed_at. Refuses unknown/out-of-org rows and disallowed transitions. */
export async function setContractorApplicationStatusCore(actor: SignupActor, data: unknown): Promise<ApplicationResult<ContractorApplicationRow>> {
  if (!OWNER_ROLES.includes(actor.role as (typeof OWNER_ROLES)[number])) {
    return err("unauthorized", "Owner access required.");
  }
  if (!configured()) return err("database_error", "Applications require database mode.");
  const parsed = setStatusSchema.safeParse(data ?? {});
  if (!parsed.success) return err("invalid_input", "Invalid application status.");
  await ensure();
  const q = sql();

  const rows = await q`SELECT id, status FROM contractor_applications WHERE id = ${parsed.data.applicationId} AND org_id = ${actor.orgId} LIMIT 1`;
  if (!rows.length) return err("not_found", "Application not found.");
  const current = String((rows[0] as Record<string, unknown>).status) as ContractorApplicationStatus;
  const allowed = ALLOWED_TRANSITIONS[current] ?? [];
  if (!allowed.includes(parsed.data.status)) {
    return err("invalid_input", `Can't move this application from ${current} to ${parsed.data.status}.`);
  }

  await q`UPDATE contractor_applications
    SET status = ${parsed.data.status}, reviewer_user_id = ${actor.id}, reviewed_at = NOW(), updated_at = NOW()
    WHERE id = ${parsed.data.applicationId} AND org_id = ${actor.orgId}`;
  const updated = await q`SELECT id, org_id, user_id, status, tools, service_area, phone, notes, reviewer_user_id, reviewed_at, created_at, updated_at
    FROM contractor_applications WHERE id = ${parsed.data.applicationId} AND org_id = ${actor.orgId} LIMIT 1`;
  return ok(mapRow(updated[0] as Record<string, unknown>));
}

/* --------------------- session-resolving handler wrappers --------------------- */
/** The facade calls these; they resolve the request actor then delegate to the
 *  actor-based cores above. */
export async function submitContractorApplicationHandler(data: unknown): Promise<ApplicationResult<ContractorApplicationRow>> {
  const actor = await resolveActor();
  if (!actor) return err("unauthorized", "Sign in first.");
  return submitContractorApplicationCore(actor, data);
}
export async function getMyApplicationStatusHandler(): Promise<ApplicationResult<ContractorApplicationRow | null>> {
  const actor = await resolveActor();
  if (!actor) return err("unauthorized", "Sign in first.");
  return getMyApplicationStatusCore(actor);
}
export async function listContractorApplicationsHandler(): Promise<ApplicationResult<ContractorApplicationWithUser[]>> {
  const actor = await resolveActor();
  if (!actor) return err("unauthorized", "Sign in first.");
  return listContractorApplicationsCore(actor);
}
export async function setContractorApplicationStatusHandler(data: unknown): Promise<ApplicationResult<ContractorApplicationRow>> {
  const actor = await resolveActor();
  if (!actor) return err("unauthorized", "Sign in first.");
  return setContractorApplicationStatusCore(actor, data);
}
