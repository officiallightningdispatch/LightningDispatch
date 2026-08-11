/**
 * JobFeedbackPanel — the driver's post-job 1-5 star rating + optional note
 * (R2 spec §c item 12). SEPARATE from the customer survey in
 * job_completions.survey. Rendered on completed-job rows (Earnings list);
 * dismissible ("Skip"), never blocks. Stars are accent-400 (yellow = ratings,
 * per the token rules). Real data only: submits via submitDriverFeedback.
 */
import { Star } from "lucide-react";
import { useState } from "react";
import { Button, useToast } from "~/components/ui";
import { submitDriverFeedback } from "~/data/driver-support";

export function JobFeedbackPanel({ jobId, callLabel }: { jobId: string; callLabel: string }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  if (done) {
    return (
      <p className="rounded-xl bg-success-50 px-3 py-2 text-xs font-semibold text-success-700">
        Thanks — your feedback helps. ✓
      </p>
    );
  }
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-between gap-2 rounded-xl border border-ink-100 bg-ink-50/60 px-3 py-2 text-xs font-semibold text-ink-600 transition-colors hover:bg-ink-100/70"
      >
        <span className="flex items-center gap-1.5">
          <Star className="size-3.5 text-accent-400" /> How was this job?
        </span>
        <span className="text-ink-400">Rate it →</span>
      </button>
    );
  }

  const submit = async () => {
    if (rating < 1) {
      setError("Pick a rating to submit.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const r = await submitDriverFeedback({ data: { jobId, rating, comment: comment.trim() || null } });
      if (r.ok) {
        setDone(true);
        toast("Feedback saved — thanks!");
      } else {
        setError(r.message ?? "Couldn't save feedback — try again.");
      }
    } catch {
      setError("Couldn't save feedback — check your connection.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-xl border border-ink-100 bg-surface p-3">
      <p className="text-xs font-bold text-ink-700">{callLabel}</p>
      <div className="mt-2 flex items-center gap-1" role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={rating === n}
            aria-label={`${n} star${n === 1 ? "" : "s"}`}
            onClick={() => { setRating(n); setError(""); }}
            className="p-0.5 transition-transform active:scale-90"
          >
            <Star className={`size-7 ${n <= rating ? "fill-accent-400 text-accent-400" : "fill-ink-100 text-ink-100"}`} />
          </button>
        ))}
        <span className="ml-2 text-xs font-semibold text-ink-500">{rating > 0 ? `${rating}/5` : ""}</span>
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value.slice(0, 300))}
        rows={2}
        placeholder="Anything we should know? (optional)"
        className="mt-2 w-full resize-none rounded-xl border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:border-brand-500 focus:outline-2 focus:outline-brand-500/40"
      />
      <div className="mt-1 text-right text-[10px] tabular-nums text-ink-400">{comment.length}/300</div>
      {error && <p role="alert" className="text-xs font-semibold text-danger-600">{error}</p>}
      <div className="mt-2 flex gap-2">
        <Button size="sm" className="flex-1" loading={submitting} onClick={() => void submit()}>Submit</Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Skip</Button>
      </div>
    </div>
  );
}
