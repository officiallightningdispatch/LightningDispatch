import { createServerFn } from "@tanstack/react-start";

export type ReadinessCheck = {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  required: boolean;
};
export type ProductionReadiness = {
  ready: boolean;
  checks: ReadinessCheck[];
};

export const getProductionReadiness = createServerFn({ method: "GET" }).handler(async (): Promise<ProductionReadiness> => {
  const { currentUser } = await import("./auth-server");
  const u = await currentUser();
  if (!u || (u.role !== "owner" && u.role !== "admin")) return { ready: false, checks: [] };

  const has = (name: string) => Boolean(process.env[name]?.trim());
  const checks: ReadinessCheck[] = [
    { key: "database", label: "Production database", ok: has("DATABASE_URL"), detail: has("DATABASE_URL") ? "Configured" : "Missing DATABASE_URL", required: true },
    { key: "encryption", label: "Sensitive PII encryption key", ok: has("BANK_ENCRYPTION_KEY"), detail: has("BANK_ENCRYPTION_KEY") ? "AES-256-GCM key configured" : "Missing BANK_ENCRYPTION_KEY — tax IDs/bank data must not rely on ephemeral server storage", required: true },
    { key: "b2", label: "Encrypted document storage", ok: has("B2_KEY_ID") && has("B2_APPLICATION_KEY") && has("B2_BUCKET_NAME"), detail: has("B2_KEY_ID") && has("B2_APPLICATION_KEY") && has("B2_BUCKET_NAME") ? "Credentials present" : "Missing Backblaze B2 runtime variables", required: true },
    { key: "stripe", label: "Stripe Connect + Identity", ok: has("STRIPE_SECRET_KEY"), detail: has("STRIPE_SECRET_KEY") ? "Secret key configured" : "Missing STRIPE_SECRET_KEY", required: true },
    { key: "payouts", label: "Instant payouts", ok: (process.env.STRIPE_CONNECT_PAYOUTS_ENABLED ?? "").trim().toLowerCase() === "true", detail: (process.env.STRIPE_CONNECT_PAYOUTS_ENABLED ?? "").trim().toLowerCase() === "true" ? "Money-move gate enabled" : "STRIPE_CONNECT_PAYOUTS_ENABLED is not true", required: true },
    { key: "square", label: "Square payments", ok: has("SQUARE_ACCESS_TOKEN") && has("SQUARE_LOCATION_ID") && has("SQUARE_APPLICATION_ID"), detail: has("SQUARE_ACCESS_TOKEN") && has("SQUARE_LOCATION_ID") && has("SQUARE_APPLICATION_ID") ? "Production Square credentials present" : "Missing one or more SQUARE_* variables", required: true },
    { key: "apns", label: "iPhone push notifications", ok: has("APNS_AUTH_KEY_P8") && has("APNS_KEY_ID") && has("APNS_TEAM_ID"), detail: has("APNS_AUTH_KEY_P8") && has("APNS_KEY_ID") && has("APNS_TEAM_ID") ? "APNs credentials present" : "Missing one or more APNS_* variables", required: true },
    { key: "cron", label: "AI dispatcher scheduler", ok: has("CRON_SECRET"), detail: has("CRON_SECRET") ? "Cron authentication configured" : "Missing CRON_SECRET", required: true },
    { key: "routing", label: "Traffic-aware routing", ok: has("TOMTOM_API_KEY"), detail: has("TOMTOM_API_KEY") ? "TomTom traffic routing configured" : "TomTom key missing — OSRM fallback only", required: false },
    { key: "webpush", label: "Web push fallback", ok: has("VAPID_PUBLIC_KEY") && has("VAPID_PRIVATE_KEY"), detail: has("VAPID_PUBLIC_KEY") && has("VAPID_PRIVATE_KEY") ? "Web push configured" : "Web push fallback not configured", required: false },
  ];

  // Validate B2 authorization without exposing credentials.
  const b2 = checks.find((x) => x.key === "b2")!;
  if (b2.ok) {
    try {
      const { loadB2Config, authorizeAccount } = await import("./b2-client");
      const cfg = await loadB2Config();
      const auth = await authorizeAccount({ keyId: cfg.keyId, applicationKey: cfg.applicationKey });
      b2.detail = auth.s3ApiUrl ? "Connected to Backblaze B2" : "B2 connected without S3 endpoint";
      b2.ok = Boolean(auth.s3ApiUrl);
    } catch (e) {
      b2.ok = false;
      b2.detail = e instanceof Error ? e.message : "Backblaze authorization failed";
    }
  }

  // Validate only that Square credentials can be resolved. No money moves.
  const square = checks.find((x) => x.key === "square")!;
  if (square.ok) {
    try {
      const { loadSquareConfig } = await import("./square-client");
      await loadSquareConfig();
      square.detail = "Square credentials resolved";
    } catch (e) {
      square.ok = false;
      square.detail = e instanceof Error ? e.message : "Square configuration failed";
    }
  }

  return { ready: checks.filter((x) => x.required).every((x) => x.ok), checks };
});
