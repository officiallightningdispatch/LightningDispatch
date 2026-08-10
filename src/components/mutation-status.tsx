import { CircleAlert } from "lucide-react";

/**
 * Small shared bits for mutation UX: inline errors with a retry affordance.
 * Errors are keyed by mutationKey() in the dispatch store; the action button
 * itself is the retry path (re-invoking the action clears and re-runs).
 */
export function InlineError({ message, className }: { message: string; className?: string }) {
  return (
    <p
      role="alert"
      className={`flex items-start gap-2 rounded-xl border border-danger-100 bg-danger-50 px-3 py-2.5 text-xs font-medium text-danger-700 ${className ?? ""}`}
    >
      <CircleAlert className="mt-px size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{message}</span>
    </p>
  );
}
