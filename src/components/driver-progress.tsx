/**
 * ProgressRail — the 5-dot lifecycle rail for the driver trip sheet (R2 spec
 * §c item 3). Keyed to TOWBOOK status ids (1 offered → 2 accepted → 3 en route
 * → 4 arrived → 5/6 complete), independent of the demo JOB_LIFECYCLE stepper.
 * Cancelled (255) turns the whole rail danger-500.
 */
import { Check } from "lucide-react";

const STEPS = [
  { id: 1, label: "Offer" },
  { id: 2, label: "Accepted" },
  { id: 3, label: "En route" },
  { id: 4, label: "Arrived" },
  { id: 5, label: "Complete" },
];

/** Index of the current step for a status id: 1→0, 2→1, 3→2, 4→3, 5/6→4.
 *  Anything unknown → -1 (nothing reached). */
export const progressStepIndex = (statusId: number): number => {
  if (statusId === 255) return -1;
  if (statusId === 6) return 4;
  if (statusId >= 1 && statusId <= 5) return statusId - 1;
  return -1;
};

export function ProgressRail({ statusId }: { statusId: number }) {
  const cancelled = statusId === 255;
  const current = progressStepIndex(statusId);
  return (
    <div className="w-full" role="group" aria-label={`Job progress: ${cancelled ? "cancelled" : `${STEPS[Math.max(0, current)]?.label ?? "Unknown"} of ${STEPS.length}`}`}>
      <div className="flex items-center">
        {STEPS.map((step, i) => {
          const reached = !cancelled && current >= i;
          const isCurrent = !cancelled && current === i;
          return (
            <div key={step.id} className={`flex items-center ${i === 0 ? "" : "flex-1"}`}>
              {i > 0 && (
                <span className={`mx-1 h-0.5 flex-1 rounded-full ${cancelled ? "bg-danger-300" : reached ? "bg-success-500" : "bg-ink-100"}`} />
              )}
              <div className="flex flex-col items-center gap-1">
                <span
                  aria-hidden="true"
                  className={`grid size-6 place-items-center rounded-full transition-colors duration-300 ${
                    cancelled
                      ? "bg-danger-500 text-white"
                      : reached
                        ? "bg-success-500 text-white"
                        : isCurrent
                          ? "border-2 border-brand-500 bg-surface text-brand-500"
                          : "bg-ink-100 text-transparent"
                  }`}
                >
                  {cancelled || reached ? <Check className="size-3.5" strokeWidth={3} /> : <span className="size-1.5 rounded-full bg-current opacity-0" />}
                </span>
                <span className={`hidden text-[10px] font-semibold sm:block ${cancelled ? "text-danger-600" : isCurrent ? "text-brand-700" : reached ? "text-success-700" : "text-ink-400"}`}>
                  {step.label}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      {cancelled && <p className="mt-2 text-xs font-semibold text-danger-600">This job was cancelled.</p>}
    </div>
  );
}
