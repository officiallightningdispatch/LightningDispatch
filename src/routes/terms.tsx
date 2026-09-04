import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "~/components/legal-page";
import { TERMS_OF_SERVICE_MD } from "~/lib/legal-content";

export const Route = createFileRoute("/terms")({
  component: TermsOfService,
});

function TermsOfService() {
  return <LegalPage markdown={TERMS_OF_SERVICE_MD} />;
}
