/** The "Send feedback" form. Opened by openFeedback() (lib/feedback.ts); mounted once in the app shell. */
import { useState } from "react";
import { cn } from "../lib/cn";
import {
  dismissFeedback,
  FEEDBACK_KIND_QUESTION,
  FEEDBACK_MESSAGE_QUESTION,
  type FeedbackKind,
  submitFeedback,
  useFeedbackDialog,
} from "../lib/feedback";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";
import { Textarea } from "./ui/textarea";
import { toast } from "./ui/toaster";

export function FeedbackDialog() {
  const open = useFeedbackDialog((s) => s.open);
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : dismissFeedback())}>
      {open ? <FeedbackForm /> : null}
    </Dialog>
  );
}

function FeedbackForm() {
  const [kind, setKind] = useState<FeedbackKind | null>(null);
  const [message, setMessage] = useState("");
  const ready = kind !== null && message.trim() !== "";
  return (
    <DialogContent title="Send feedback" description="We read every message.">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!kind || !ready) return;
          submitFeedback(kind, message);
          toast({
            title: "Thank you",
            description: "If we need more detail, we'll email you.",
            tone: "positive",
          });
        }}
      >
        <fieldset>
          <legend className="mb-2 text-[13px] font-medium text-ink">
            {FEEDBACK_KIND_QUESTION.question}
          </legend>
          <div role="radiogroup" className="grid gap-2 sm:grid-cols-3">
            {FEEDBACK_KIND_QUESTION.choices.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={kind === c}
                onClick={() => setKind(c)}
                className={cn(
                  "rounded-md border px-3 py-2 text-left text-[13px] transition-colors pointer-coarse:min-h-11",
                  kind === c
                    ? "border-accent bg-accent-soft text-ink"
                    : "border-border bg-surface text-ink-2 hover:border-border-strong hover:text-ink",
                )}
              >
                {c}
              </button>
            ))}
          </div>
        </fieldset>
        <label className="block">
          <span className="mb-2 block text-[13px] font-medium text-ink">
            {FEEDBACK_MESSAGE_QUESTION.question}
          </span>
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={5}
            placeholder="What happened, or what would help?"
          />
          <span className="mt-1.5 block text-[12px] text-ink-3">
            Please don't include account numbers or passwords.
          </span>
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={dismissFeedback}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!ready}>
            Send
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}
