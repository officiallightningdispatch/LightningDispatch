#!/usr/bin/env bun
// QA seed (dev-only fixture, tag-parameterized): a throwaway org with owner +
// dispatcher users and a spread of ai_dispatcher_decisions rows (accepted with
// driver, no-driver accept, and the escalation family) so the AI Dispatcher
// control panel + ops "Needs attention" banner can be verified in the browser.
//
// NEVER seeds the owner org. Idempotent: delete-then-insert for the tag's org.
// Cleanup: DELETE FROM organizations WHERE id = tag org (decisions cascade).
//
// Usage: DATABASE_URL=... bun scripts/qa-seed-ai-dispatch.mjs [tag]  (tag: aidisp)
import { neon } from "../node_modules/@neondatabase/serverless/index.js";
import { scryptSync } from "node:crypto";
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const q = neon(process.env.DATABASE_URL);
const TAG = String(process.argv[2] || "aidisp").replace(/[^a-z0-9-]/gi, "");
const A = `qa-${TAG}`;
const UO = `qa-user-owner-${TAG}`;
const UD = `qa-user-ops-${TAG}`;
const PASSWORD = "QaNavR10Pass!";
const salt = `qa-salt-${TAG}`;
const HASH = `${salt}:${scryptSync(PASSWORD, salt, 64).toString("hex")}`;
const email = (id) => `${id}@lightning.test`;

try {
  // ---- idempotent wipe (FK order; decisions/audit cascade via org) ----
  await q`DELETE FROM ai_dispatcher_decisions WHERE org_id=${A}`;
  await q`DELETE FROM org_settings WHERE org_id=${A}`;
  await q`DELETE FROM audit_log WHERE org_id=${A}`;
  await q`DELETE FROM status_events WHERE org_id=${A}`;
  await q`DELETE FROM dispatch_jobs WHERE org_id=${A}`;
  await q`DELETE FROM dispatch_contractors WHERE org_id=${A}`;
  await q`DELETE FROM organization_memberships WHERE org_id=${A}`;
  await q`DELETE FROM towbook_sessions WHERE org_id=${A}`;
  await q`DELETE FROM users WHERE id IN (${UO},${UD})`;
  await q`DELETE FROM organizations WHERE id=${A}`;
  // ---- org + users (NO towbook_sessions row → panel must show Connect prompt) ----
  await q`INSERT INTO organizations(id,name) VALUES (${A},${`QA AI Dispatcher ${TAG}`})`;
  await q`INSERT INTO users(id,name,email,password_hash) VALUES
    (${UO},'QA AI Owner',${email(UO)},${HASH}),
    (${UD},'QA AI Dispatcher',${email(UD)},${HASH})`;
  await q`INSERT INTO organization_memberships(org_id,user_id,role) VALUES
    (${A},${UO},'owner'),(${A},${UD},'dispatcher')`;
  // ---- org_settings (defaults, enabled) ----
  await q`INSERT INTO org_settings(org_id, ai_dispatcher_enabled, zone_lat, zone_lng, zone_radius_miles, max_eta_minutes)
    VALUES (${A}, TRUE, 41.208862, -73.207253, 30, 45)`;
  // ---- decision ledger spread (intervals are literal SQL text, values bound) ----
  await q`INSERT INTO ai_dispatcher_decisions(id, org_id, call_request_id, call_id, decision, escalated, driver_id, driver_name, eta_minutes, zone_distance_miles, reason, raw_response, created_at) VALUES
    (gen_random_uuid()::text, ${A}, '700001', '900001', 'auto_accept_with_driver', FALSE, 'd1', 'QA Driver One', 18, 4.2,
      ${"accepted and dispatched to QA Driver One (driver d1), ETA 18 min"},
      ${JSON.stringify({ id: 900001, callNumber: 900001, ok: true })}::jsonb, NOW() - INTERVAL '12 minutes'),
    (gen_random_uuid()::text, ${A}, '700002', NULL, 'auto_accept_no_driver', TRUE, NULL, NULL, NULL, 6.1,
      ${"no checked-in free driver with GPS — accepted WITHOUT dispatch so the motor-club offer cannot expire or be missed; assign manually"},
      ${JSON.stringify({ id: 900002, callNumber: 900002, ok: true })}::jsonb, NOW() - INTERVAL '30 minutes'),
    (gen_random_uuid()::text, ${A}, '700003', NULL, 'escalated_accept_failed', TRUE, 'd2', 'QA Driver Two', 22, 3.8,
      ${"accept POST failed after retry (HTTP 500; HTTP 500) — offer NOT auto-accepted, needs a human"},
      ${JSON.stringify({ offer: { callRequestId: 700003, status: 0 }, attempts: [{ status: 500, body: "boom" }] })}::jsonb, NOW() - INTERVAL '1 hour'),
    (gen_random_uuid()::text, ${A}, '700004', NULL, 'escalated_driver_lookup_failed', TRUE, NULL, NULL, NULL, 9.4,
      ${"driver lookup failed (HTTP 502) — cannot dispatch (no accept)"},
      ${JSON.stringify({ offer: { callRequestId: 700004, status: 0 }, nearestDrivers: "HTTP 502" })}::jsonb, NOW() - INTERVAL '2 hours'),
    (gen_random_uuid()::text, ${A}, '700005', NULL, 'escalated_expired', TRUE, NULL, NULL, NULL, 12.7,
      ${"offer expired (expirationDateUtc=2026-08-09T00:00:00Z) — not auto-accepted (no accept)"},
      ${JSON.stringify({ offer: { callRequestId: 700005, status: 0, expirationDateUtc: "2026-08-09T00:00:00Z" } })}::jsonb, NOW() - INTERVAL '3 hours'),
    (gen_random_uuid()::text, ${A}, '700006', NULL, 'escalated_out_of_zone', TRUE, NULL, NULL, NULL, 42.3,
      ${"pickup 42.3 mi from zone center — outside the 30-mile radius (no accept)"},
      ${JSON.stringify({ offer: { callRequestId: 700006, status: 0, startLocationLatitude: 41.9, startLocationLongitude: -72.5 } })}::jsonb, NOW() - INTERVAL '4 hours'),
    (gen_random_uuid()::text, ${A}, 'shape-abc123', NULL, 'escalated_unexpected_shape', TRUE, NULL, NULL, NULL, NULL,
      ${"offer shape unexpected — missing/mistyped: startLocationLatitude, startLocationLongitude (no accept; full offer in raw_response)"},
      ${JSON.stringify({ offer: { callRequestId: 700007, status: 0 } })}::jsonb, NOW() - INTERVAL '5 hours')`;
  const n = await q`SELECT COUNT(*)::int n FROM ai_dispatcher_decisions WHERE org_id=${A}`;
  console.log(`Seeded ${A}: ${n[0].n} decision rows, org_settings enabled, no towbook session`);
} catch (e) {
  console.error("FAIL seed:", e);
  process.exit(1);
}
