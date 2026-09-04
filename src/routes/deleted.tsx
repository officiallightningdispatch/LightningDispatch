import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "~/components/legal-page";

/**
 * /deleted — signed-out account-deletion confirmation (Apple App Store
 * requirement). Shown after a contractor deletes their account in-app. Public
 * path (the AuthGate allows it) so a just-deleted, now-signed-out user can
 * still land here. Points to the manual email fallback.
 */
export const Route = createFileRoute("/deleted")({
  component: Deleted,
});

function Deleted() {
  return (
    <LegalPage
      markdown={`# Account deleted

Your account and personal data have been removed. Payroll and tax records the business is required to keep are retained.

If you need anything else — including confirming a deletion request you couldn't complete in the app — email **[lightroad29@gmail.com](mailto:lightroad29@gmail.com)** or call **(203) 892-4122**.

[Back to Lightning Dispatch](/)
`}
    />
  );
}
