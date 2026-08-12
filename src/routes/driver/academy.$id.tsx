import { createFileRoute, useParams } from "@tanstack/react-router";
import { AppShell } from "~/components/app-shell";
import { AcademyLessonView } from "~/components/metrics-views";

export const Route = createFileRoute("/driver/academy/$id")({ component: DriverAcademyLesson });
function DriverAcademyLesson() {
  const { id } = useParams({ from: "/driver/academy/$id" });
  return (
    <AppShell portal="driver" title="Academy" description="Your personal coaching lesson.">
      <AcademyLessonView lessonId={id} />
    </AppShell>
  );
}
