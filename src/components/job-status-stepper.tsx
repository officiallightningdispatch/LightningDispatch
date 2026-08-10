import { Check } from "lucide-react";
import type { JobStatus } from "~/data/seed";
import { JOB_LIFECYCLE, JOB_STATUS_META } from "~/lib/job-ui";

/**
 * Shared lifecycle stepper (dispatcher console + contractor view) so every
 * role sees the same status progression. Uses job-ui tokens (design-spec §3):
 * - done    : success-500 fill + Check icon
 * - current : status color + ring-4 ring-{status}-100
 * - upcoming: border-ink-200 on surface, ink-300 label
 * Labels are hidden below `sm` so 6 steps never collide on 360–390px phones.
 */
export function JobStatusStepper({ status }: { status: JobStatus }) {
  const current = JOB_LIFECYCLE.indexOf(status);
  return (
    <div className="flex items-center" role="list" aria-label={`Job status: ${JOB_STATUS_META[status].label}`}>
      {JOB_LIFECYCLE.map((step, i) => {
        const meta = JOB_STATUS_META[step];
        const done = i < current;
        const isCurrent = i === current;
        return (
          <div key={step} className="flex flex-1 items-center last:flex-none" role="listitem">
            <div className="flex flex-col items-center gap-1.5">
              <span
                aria-hidden={done}
                className={`grid size-7 place-items-center rounded-full text-xs font-bold ${
                  done
                    ? "border-2 border-success-500 bg-success-500 text-white"
                    : isCurrent
                      ? `${meta.step} ring-4 ${meta.ring}`
                      : "border-2 border-ink-200 bg-surface text-ink-300"
                }`}
              >
                {done ? <Check className="size-4" strokeWidth={3} /> : i + 1}
              </span>
              <span
                className={`hidden whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide sm:block ${
                  isCurrent ? "text-ink-700" : "text-ink-300"
                }`}
              >
                {meta.label}
              </span>
            </div>
            {i < JOB_LIFECYCLE.length - 1 && (
              <div
                aria-hidden="true"
                className={`mx-1 h-0.5 flex-1 rounded sm:mb-5 ${done ? "bg-success-400" : "bg-ink-100"}`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
