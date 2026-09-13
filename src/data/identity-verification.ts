/** Client-safe facade for automated contractor identity verification. */
import { createServerFn } from "@tanstack/react-start";
import type { IdentityResult, IdentityStatus } from "./identity-verification-core";

const passthrough = (x: unknown) => x;

export const startIdentityVerification = createServerFn({ method: "POST" })
  .validator(passthrough)
  .handler(async ({ data }): Promise<IdentityResult<{ url: string }>> => {
    const core = await import("./identity-verification-core");
    const d = (data ?? {}) as { returnUrl?: string };
    return core.startIdentityVerificationCore(typeof d.returnUrl === "string" ? d.returnUrl : "");
  });

export const getIdentityVerificationStatus = createServerFn({ method: "GET" })
  .handler(async (): Promise<IdentityResult<IdentityStatus>> => {
    const core = await import("./identity-verification-core");
    return core.getIdentityVerificationStatusCore();
  });
