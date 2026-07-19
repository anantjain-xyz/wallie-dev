"use client";

import { useEffect, useId, useRef, useState } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import type { ReviewMode } from "@/features/sessions/detail/review-mode";
import { cn } from "@/lib/utils";

const FEEDBACK_MAX = 4_000;

type SessionReviewBarProps = {
  approveLabel: string;
  mode: ReviewMode;
  onApprove: () => void;
  onReject: (feedback: string) => Promise<boolean>;
  onStopRun: () => void;
  phaseActionPending: "approve" | "reject" | null;
  stopPending: boolean;
};

export function SessionReviewBar({
  approveLabel,
  mode,
  onApprove,
  onReject,
  onStopRun,
  phaseActionPending,
  stopPending,
}: SessionReviewBarProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [feedbackDraft, setFeedbackDraft] = useState("");
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const feedbackFieldId = useId();
  const feedbackRef = useRef<HTMLTextAreaElement | null>(null);
  const phaseActionBusy = phaseActionPending !== null;

  useEffect(() => {
    if (!dialogOpen) return;
    const frame = window.requestAnimationFrame(() => {
      feedbackRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [dialogOpen]);

  if (mode.kind === "other_stage") {
    return null;
  }

  if (
    mode.kind === "archived" ||
    mode.kind === "completed" ||
    mode.kind === "canceled" ||
    mode.kind === "unauthorized" ||
    mode.kind === "failed"
  ) {
    return (
      <div
        className={cn(
          "sticky bottom-0 z-20 border-t border-border bg-sheet/95 px-4 py-3 backdrop-blur",
          "pb-[max(0.75rem,env(safe-area-inset-bottom))]",
        )}
        role="status"
      >
        <p className="text-sm text-muted">{mode.reason}</p>
      </div>
    );
  }

  if (mode.kind === "running") {
    return (
      <div
        className={cn(
          "sticky bottom-0 z-20 border-t border-border bg-sheet/95 px-4 py-3 backdrop-blur",
          "pb-[max(0.75rem,env(safe-area-inset-bottom))]",
        )}
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted">Wallie is generating this stage’s artifact.</p>
          <button
            type="button"
            className="ui-button-danger"
            disabled={stopPending || phaseActionBusy}
            onClick={() => void onStopRun()}
          >
            <ActionButtonLabel idle="Stop run" pending={stopPending} pendingLabel="Stopping…" />
          </button>
        </div>
      </div>
    );
  }

  async function submitReject() {
    if (phaseActionBusy) return;
    const trimmed = feedbackDraft.trim();
    if (!trimmed) {
      setFeedbackError("Feedback is required. Whitespace-only notes are not accepted.");
      feedbackRef.current?.focus();
      return;
    }

    setFeedbackError(null);
    const succeeded = await onReject(trimmed);
    if (succeeded) {
      setFeedbackDraft("");
      setDialogOpen(false);
    }
    // On failure, keep the dialog open and preserve the draft.
  }

  return (
    <>
      <div
        className={cn(
          "sticky bottom-0 z-20 border-t border-border bg-sheet/95 px-4 py-3 backdrop-blur",
          "pb-[max(0.75rem,env(safe-area-inset-bottom))]",
        )}
      >
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
          <button
            type="button"
            className="ui-button"
            disabled={phaseActionBusy}
            onClick={() => {
              setFeedbackError(null);
              setDialogOpen(true);
            }}
          >
            Request changes
          </button>
          <button
            type="button"
            className="ui-button-primary"
            disabled={phaseActionBusy}
            onClick={() => {
              if (phaseActionBusy) return;
              onApprove();
            }}
          >
            <ActionButtonLabel
              idle={approveLabel}
              pending={phaseActionPending === "approve"}
              pendingLabel="Approving…"
            />
          </button>
        </div>
      </div>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (phaseActionBusy && !open) return;
          setDialogOpen(open);
          if (!open) setFeedbackError(null);
        }}
      >
        <DialogContent
          description="Wallie will rerun the current stage with your feedback injected into the prompt."
          dismissible={!phaseActionBusy}
          title="Request changes"
        >
          <label className="block text-xs font-semibold text-foreground" htmlFor={feedbackFieldId}>
            Feedback for Wallie
          </label>
          <textarea
            ref={feedbackRef}
            id={feedbackFieldId}
            value={feedbackDraft}
            maxLength={FEEDBACK_MAX}
            onChange={(event) => {
              setFeedbackDraft(event.target.value);
              if (feedbackError) setFeedbackError(null);
            }}
            className="ui-textarea mt-2 min-h-28"
            placeholder="What should change?"
            disabled={phaseActionBusy}
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <p className="type-annotation text-muted">
              {feedbackDraft.trim().length}/{FEEDBACK_MAX}
            </p>
            {feedbackError ? (
              <p className="text-xs text-danger" role="alert">
                {feedbackError}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <button
              type="button"
              className="ui-button"
              disabled={phaseActionBusy}
              onClick={() => setDialogOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="ui-button-primary"
              disabled={phaseActionBusy}
              onClick={() => void submitReject()}
            >
              <ActionButtonLabel
                idle="Queue rerun"
                pending={phaseActionPending === "reject"}
                pendingLabel="Queueing…"
              />
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
