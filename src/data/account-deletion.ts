/**
 * Account deletion — CLIENT-SAFE FACADE (Apple App Store requirement, 2026-09-03).
 * The ONLY piece of the account-deletion feature imported by client code
 * (driver profile screen). The createServerFn handler dynamic-imports the
 * SERVER-ONLY core (./account-deletion-core.ts) so the client bundle never
 * pulls in node:crypto / db / auth-server / b2-client code (client-graph rule).
 */
import { createServerFn } from "@tanstack/react-start";
import type { DeleteAccountResult } from "./account-deletion-core";
export type { DeleteAccountResult } from "./account-deletion-core";

/** Delete the CURRENTLY signed-in CONTRACTOR's account. Staff (owner/admin/
 *  dispatcher) accounts are refused — the business org must never be nuked.
 *  On success the LD session rows are gone, so the caller should navigate to
 *  the signed-out fallback surface (which points to lightroad29@gmail.com). */
export const deleteMyAccount = createServerFn({ method: "POST" }).handler(async (): Promise<DeleteAccountResult> => {
  const core = await import("./account-deletion-core");
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u) return { ok: false, code: "unavailable", message: "Sign in to delete your account." };
  return core.deleteMyAccountCore(u);
});
