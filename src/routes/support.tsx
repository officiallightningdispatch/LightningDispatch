import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "~/components/legal-page";
import { SUPPORT_MD } from "~/lib/legal-content";

export const Route = createFileRoute("/support")({
  component: Support,
});

function Support() {
  return <LegalPage markdown={SUPPORT_MD} />;
}
