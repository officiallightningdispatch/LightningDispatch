import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "~/components/legal-page";
import { PRIVACY_POLICY_MD } from "~/lib/legal-content";

export const Route = createFileRoute("/privacy")({
  component: PrivacyPolicy,
});

function PrivacyPolicy() {
  return <LegalPage markdown={PRIVACY_POLICY_MD} />;
}
