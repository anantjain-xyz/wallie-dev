"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import type { ReviewMode } from "@/features/sessions/detail/review-mode";
import type {
  ArtifactReviewThread,
  ReviewCursor,
  ReviewThreadListPayload,
} from "@/features/sessions/review/types";
import {
  isSessionSubmitShortcut,
  SESSION_SUBMIT_KEY_SHORTCUTS,
} from "@/features/sessions/session-submit-shortcut";
import { cn } from "@/lib/utils";

const FEEDBACK_MAX = 4_000;
const THREAD_MAX = 20;

export type SessionReviewArtifact = { artifactId: string; stageId: string; version: number };
export type SessionFeedbackSubmission = {
  requestId: string;
  expectedReviewRevision: number;
  selectedThreadIds: string[];
};
type FeedbackReviewSnapshot = ReviewThreadListPayload & {
  reviewRevision: number;
  submittedThreadRevisions: Record<string, number>;
};

function threadQuote(thread: ArtifactReviewThread) {
  const anchor = thread.anchor;
  return anchor &&
    typeof anchor === "object" &&
    !Array.isArray(anchor) &&
    typeof anchor.quote === "string"
    ? anchor.quote
    : "Artifact text";
}

type SessionReviewBarProps = {
  sessionId?: string;
  attached?: boolean;
  approveLabel: string;
  approveDescription?: string;
  mode: ReviewMode;
  onApprove: (artifact: SessionReviewArtifact | null) => void;
  onReject: (
    feedback: string,
    artifact: SessionReviewArtifact | null,
    submission?: SessionFeedbackSubmission,
  ) => Promise<boolean>;
  requestError?: string | null;
  reviewArtifact: SessionReviewArtifact | null;
  phaseActionPending: "approve" | "reject" | null;
};

export function SessionReviewBar({
  sessionId,
  attached = false,
  approveLabel,
  approveDescription,
  mode,
  onApprove,
  onReject,
  reviewArtifact,
  phaseActionPending,
  requestError,
}: SessionReviewBarProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [feedbackDraft, setFeedbackDraft] = useState("");
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [reviewSnapshot, setReviewSnapshot] = useState<FeedbackReviewSnapshot | null>(null);
  const [selectedThreadIds, setSelectedThreadIds] = useState<string[]>([]);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewChanged, setReviewChanged] = useState(false);
  const feedbackFieldId = useId();
  const approveDescriptionId = useId();
  const feedbackErrorId = useId();
  const feedbackCountId = useId();
  const feedbackRef = useRef<HTMLTextAreaElement | null>(null);
  const rejectInFlightRef = useRef(false);
  const rejectionArtifactRef = useRef<SessionReviewArtifact | null>(null);
  const requestChangesTriggerRef = useRef<HTMLButtonElement | null>(null);
  const reviewRevisionRef = useRef<number | null>(null);
  const reviewLoadSequence = useRef(0);
  const reviewController = useRef<AbortController | null>(null);
  const requestMemory = useRef(new Map<string, string>());
  const phaseActionBusy = phaseActionPending !== null;
  const displayedError = requestError ?? feedbackError;
  const artifactChanged =
    dialogOpen &&
    (reviewArtifact?.artifactId !== rejectionArtifactRef.current?.artifactId ||
      reviewArtifact?.stageId !== rejectionArtifactRef.current?.stageId ||
      reviewArtifact?.version !== rejectionArtifactRef.current?.version);

  const loadReview = useCallback(
    async (cursor: ReviewCursor | null = null) => {
      const artifact = rejectionArtifactRef.current;
      if (!sessionId || !artifact) return;
      const sequence = ++reviewLoadSequence.current;
      reviewController.current?.abort();
      const controller = new AbortController();
      reviewController.current = controller;
      setReviewLoading(true);
      setReviewError(null);
      try {
        const query = new URLSearchParams({ artifactId: artifact.artifactId });
        if (cursor) {
          query.set("cursorCreatedAt", cursor.createdAt);
          query.set("cursorId", cursor.id);
        }
        const response = await fetch(`/api/sessions/${sessionId}/reviews?${query}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = (await response.json().catch(() => null)) as
          | FeedbackReviewSnapshot
          | { error?: string }
          | null;
        if (!response.ok)
          throw new Error(
            payload && "error" in payload ? payload.error : "Could not load inline comments.",
          );
        if (
          !payload ||
          !("threads" in payload) ||
          !Array.isArray(payload.threads) ||
          !Number.isSafeInteger(payload.reviewRevision) ||
          payload.reviewRevision < 0
        )
          throw new Error("Could not confirm this review. Refresh comments before submitting.");
        if (controller.signal.aborted || sequence !== reviewLoadSequence.current) return;
        if (cursor && reviewRevisionRef.current !== payload.reviewRevision) {
          setReviewChanged(true);
          setReviewError(
            "This review changed while comments were loading. Refresh comments and select the threads again. Your note is retained.",
          );
          return;
        }
        reviewRevisionRef.current = payload.reviewRevision;
        setReviewSnapshot((current) => ({
          ...payload,
          submittedThreadRevisions:
            cursor && current
              ? { ...current.submittedThreadRevisions, ...payload.submittedThreadRevisions }
              : payload.submittedThreadRevisions,
          threads:
            cursor && current
              ? [
                  ...new Map(
                    [...current.threads, ...payload.threads].map((thread) => [thread.id, thread]),
                  ).values(),
                ]
              : payload.threads,
        }));
      } catch (error) {
        if (!controller.signal.aborted && sequence === reviewLoadSequence.current)
          setReviewError(
            error instanceof Error ? error.message : "Could not load inline comments.",
          );
      } finally {
        if (!controller.signal.aborted && sequence === reviewLoadSequence.current)
          setReviewLoading(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    if (!dialogOpen || !sessionId) return;
    void loadReview();
    return () => {
      reviewLoadSequence.current += 1;
      reviewController.current?.abort();
    };
  }, [dialogOpen, loadReview, sessionId]);

  useEffect(() => {
    if (!dialogOpen) return;
    const frame = window.requestAnimationFrame(() => {
      feedbackRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [dialogOpen]);

  if (!dialogOpen && (mode.kind === "other_stage" || mode.kind === "completed")) {
    return null;
  }

  if (
    !dialogOpen &&
    (mode.kind === "archived" ||
      mode.kind === "canceled" ||
      mode.kind === "unauthorized" ||
      mode.kind === "failed" ||
      mode.kind === "unavailable" ||
      mode.kind === "historical_version")
  ) {
    return (
      <div
        className={cn(
          "bg-sheet/95 py-3 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] backdrop-blur",
          attached ? "rounded-b-[6px] border-t border-border" : "sticky bottom-0 z-20",
          "pb-[max(0.75rem,env(safe-area-inset-bottom))]",
        )}
        role="status"
      >
        <p className="text-sm text-muted">{mode.reason}</p>
      </div>
    );
  }

  if (!dialogOpen && mode.kind === "running") {
    return null;
  }

  async function submitReject() {
    if (phaseActionBusy || rejectInFlightRef.current) return;
    const trimmed = feedbackDraft.trim();
    if (artifactChanged) return;
    if (
      sessionId &&
      (reviewLoading || reviewChanged || reviewError || reviewRevisionRef.current === null)
    ) {
      setFeedbackError("Refresh inline comments before submitting. Your note is retained.");
      return;
    }
    if (!trimmed && selectedThreadIds.length === 0) {
      setFeedbackError(
        sessionId
          ? "Write a note or select at least one inline thread."
          : "Feedback is required. Whitespace-only notes are not accepted.",
      );
      feedbackRef.current?.focus();
      return;
    }
    if (Array.from(trimmed).length > FEEDBACK_MAX) {
      setFeedbackError(
        `Keep the whole-stage note within ${FEEDBACK_MAX.toLocaleString()} characters.`,
      );
      feedbackRef.current?.focus();
      return;
    }

    setFeedbackError(null);
    rejectInFlightRef.current = true;
    try {
      let submission: SessionFeedbackSubmission | undefined;
      if (sessionId) {
        const ids = [...selectedThreadIds].sort();
        const fingerprint = JSON.stringify([
          rejectionArtifactRef.current,
          reviewRevisionRef.current,
          ids,
          trimmed,
        ]);
        if (!requestMemory.current.has(fingerprint))
          requestMemory.current.set(fingerprint, crypto.randomUUID());
        submission = {
          requestId: requestMemory.current.get(fingerprint)!,
          expectedReviewRevision: reviewRevisionRef.current!,
          selectedThreadIds: ids,
        };
      }
      const succeeded = submission
        ? await onReject(trimmed, rejectionArtifactRef.current, submission)
        : await onReject(trimmed, rejectionArtifactRef.current);
      if (succeeded) {
        setFeedbackDraft("");
        requestMemory.current.clear();
        setDialogOpen(false);
      }
      // On failure, keep the dialog open and preserve the draft.
    } catch {
      setFeedbackError(
        "Could not confirm the submission. Your draft is retained. Retry the same submission.",
      );
    } finally {
      rejectInFlightRef.current = false;
    }
  }

  return (
    <>
      <div
        className={cn(
          "bg-sheet/95 py-3 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] backdrop-blur",
          attached ? "rounded-b-[6px] border-t border-border" : "sticky bottom-0 z-20",
          "pb-[max(0.75rem,env(safe-area-inset-bottom))]",
        )}
      >
        <div
          className={cn(
            "gap-2 sm:flex sm:items-center sm:justify-end",
            mode.kind === "reviewable" && mode.canApprove
              ? "grid grid-cols-2 items-stretch"
              : "flex flex-col",
          )}
        >
          <button
            ref={requestChangesTriggerRef}
            type="button"
            className="ui-button min-h-11 sm:min-h-9"
            disabled={phaseActionBusy}
            onClick={() => {
              setFeedbackError(null);
              rejectionArtifactRef.current = reviewArtifact ? { ...reviewArtifact } : null;
              reviewRevisionRef.current = null;
              setReviewSnapshot(null);
              setSelectedThreadIds([]);
              setReviewChanged(false);
              setReviewError(null);
              setDialogOpen(true);
            }}
          >
            Request changes
          </button>
          {mode.kind === "reviewable" && mode.canApprove ? (
            <button
              type="button"
              aria-describedby={approveDescription ? approveDescriptionId : undefined}
              className="ui-button-primary min-h-11 min-w-0 whitespace-normal [overflow-wrap:anywhere] sm:min-h-9"
              disabled={phaseActionBusy}
              onClick={() => {
                if (phaseActionBusy) return;
                onApprove(reviewArtifact);
              }}
            >
              <ActionButtonLabel
                idle={approveLabel}
                pending={phaseActionPending === "approve"}
                pendingLabel="Approving…"
              />
            </button>
          ) : (
            <p className="text-sm text-muted" role="status">
              You are not authorized to approve this stage.
            </p>
          )}
        </div>
        {mode.kind === "reviewable" && mode.canApprove && approveDescription ? (
          <p id={approveDescriptionId} className="mt-2 text-xs leading-5 text-muted sm:text-right">
            {approveDescription}
          </p>
        ) : null}
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
          description="Select inline threads or write a note. Wallie will revise the artifact and code you reviewed."
          dismissible={!phaseActionBusy}
          onKeyDown={(event) => {
            if (!isSessionSubmitShortcut(event)) return;
            event.preventDefault();
            void submitReject();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            requestChangesTriggerRef.current?.focus();
          }}
          title="Request changes"
        >
          {artifactChanged ? (
            <p className="mb-4 text-sm text-danger" role="alert">
              A different artifact is now shown. Your draft is retained. Close this dialog and
              review the latest output before submitting.
            </p>
          ) : null}
          {sessionId ? (
            <fieldset
              className="mb-5 min-w-0 space-y-3"
              disabled={phaseActionBusy || artifactChanged}
            >
              <legend className="text-xs font-semibold text-foreground">Inline comments</legend>
              <p className="text-xs leading-5 text-muted">
                Select up to {THREAD_MAX} threads to send, including their current replies. Later
                comments and edits stay unsent.
              </p>
              {reviewLoading ? (
                <p className="text-xs text-muted" role="status">
                  Loading inline comments…
                </p>
              ) : null}
              {reviewError ? (
                <p className="text-xs text-danger" role="alert">
                  {reviewError}
                </p>
              ) : null}
              {reviewSnapshot?.threads.length === 0 ? (
                <p className="text-xs text-muted">No inline comments on this artifact yet.</p>
              ) : null}
              <div className="max-h-52 space-y-2 overflow-auto">
                {reviewSnapshot?.threads.map((thread) => {
                  const quote = threadQuote(thread);
                  const sentRevision = reviewSnapshot.submittedThreadRevisions?.[thread.id];
                  return (
                    <label
                      key={thread.id}
                      className="flex min-h-11 cursor-pointer items-start gap-3 rounded-[4px] border border-border p-3"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-accent"
                        checked={selectedThreadIds.includes(thread.id)}
                        disabled={reviewLoading || reviewChanged || thread.status !== "open"}
                        aria-label={`Include thread: ${Array.from(quote).slice(0, 120).join("")}`}
                        onChange={(event) => {
                          if (event.target.checked && selectedThreadIds.length >= THREAD_MAX) {
                            setFeedbackError(`Select at most ${THREAD_MAX} threads per revision.`);
                            return;
                          }
                          setSelectedThreadIds((current) =>
                            event.target.checked
                              ? [...current, thread.id]
                              : current.filter((id) => id !== thread.id),
                          );
                          setFeedbackError(null);
                        }}
                      />
                      <span className="min-w-0 flex-1 text-xs">
                        <span className="block font-medium text-foreground">
                          {thread.kind === "blocking" ? "Blocking request" : "Discussion"} ·{" "}
                          {thread.status}
                        </span>
                        <span className="mt-1 line-clamp-2 block whitespace-pre-wrap break-words text-muted">
                          {quote}
                        </span>
                        <span className="mt-1 block text-muted">
                          {sentRevision === undefined
                            ? "Not submitted"
                            : sentRevision < thread.revision
                              ? "Unsent changes"
                              : "Submitted"}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {reviewSnapshot?.nextCursor ? (
                  <button
                    type="button"
                    className="ui-button min-h-11"
                    disabled={reviewLoading || reviewChanged}
                    onClick={() => void loadReview(reviewSnapshot.nextCursor)}
                  >
                    Load more threads
                  </button>
                ) : null}
                <button
                  type="button"
                  className="ui-button min-h-11"
                  disabled={reviewLoading}
                  onClick={() => {
                    reviewRevisionRef.current = null;
                    setReviewChanged(false);
                    setSelectedThreadIds([]);
                    setReviewSnapshot(null);
                    setFeedbackError(null);
                    void loadReview();
                  }}
                >
                  Refresh comments
                </button>
                <p className="text-xs text-muted" role="status">
                  {selectedThreadIds.length} selected
                </p>
              </div>
              <p className="text-xs text-muted">
                Refreshing clears the thread selection and keeps your note.
              </p>
            </fieldset>
          ) : null}
          <label className="block text-xs font-semibold text-foreground" htmlFor={feedbackFieldId}>
            Feedback for Wallie
          </label>
          <textarea
            ref={feedbackRef}
            id={feedbackFieldId}
            value={feedbackDraft}
            aria-invalid={Boolean(displayedError)}
            aria-describedby={displayedError ? feedbackErrorId : feedbackCountId}
            onChange={(event) => {
              setFeedbackDraft(event.target.value);
              if (feedbackError) setFeedbackError(null);
            }}
            className="ui-textarea mt-2 min-h-28"
            placeholder="What should change?"
            disabled={phaseActionBusy}
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <p id={feedbackCountId} className="type-annotation text-muted">
              {Array.from(feedbackDraft.trim()).length}/{FEEDBACK_MAX}
              {sessionId ? " · Optional when threads are selected" : ""}
            </p>
            {displayedError ? (
              <p id={feedbackErrorId} className="text-xs text-danger" role="alert">
                {displayedError}
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
              aria-keyshortcuts={SESSION_SUBMIT_KEY_SHORTCUTS}
              className="ui-button-primary"
              disabled={
                phaseActionBusy ||
                artifactChanged ||
                (Boolean(sessionId) &&
                  (reviewLoading ||
                    reviewChanged ||
                    Boolean(reviewError) ||
                    reviewSnapshot === null))
              }
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
