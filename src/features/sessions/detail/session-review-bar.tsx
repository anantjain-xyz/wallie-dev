"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { useApprovalReview, type ApprovalReviewDelivery } from "./use-approval-review";
import type { BlockingReviewTarget } from "./blocking-review-target";
import { formatDeliveryBlocker, readinessStateLabel } from "./review-evidence-presentation";
import { SESSION_REVIEW_DECISION_ID } from "./session-review-handoff";
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

const BlockingArtifactReviewPanel = dynamic(() =>
  import("@/features/sessions/review/review-panel").then((module) => module.ArtifactReviewPanel),
);

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

export function reviewDeliveryState(
  delivery: ApprovalReviewDelivery | null | undefined,
  verificationState?: ApprovalReviewDelivery["state"],
) {
  if (verificationState !== undefined) {
    return delivery?.required && delivery.state === verificationState ? delivery.state : "checking";
  }
  return delivery?.required ? delivery.state : null;
}

type SessionReviewBarProps = {
  sessionId?: string;
  attached?: boolean;
  approvalReview?: ReturnType<typeof useApprovalReview>;
  verificationState?: ApprovalReviewDelivery["state"];
  deliveryEvidenceAvailable?: boolean;
  onRefreshReview?: () => void;
  stageNames?: Readonly<Record<string, string>>;
  exactReviewRevision?: number;
  approveLabel: string;
  approveDescription?: string;
  mode: ReviewMode;
  onApprove: (artifact: SessionReviewArtifact | null, expectedReviewRevision?: number) => void;
  onReject: (
    feedback: string,
    artifact: SessionReviewArtifact | null,
    submission?: SessionFeedbackSubmission,
  ) => Promise<boolean>;
  requestError?: string | null;
  reviewArtifact: SessionReviewArtifact | null;
  phaseActionPending: "approve" | "reject" | null;
  stageName?: string;
};

export function SessionReviewBar({
  sessionId,
  attached = false,
  approvalReview: suppliedApprovalReview,
  verificationState,
  deliveryEvidenceAvailable,
  onRefreshReview,
  stageNames,
  exactReviewRevision,
  approveLabel,
  approveDescription,
  mode,
  onApprove,
  onReject,
  reviewArtifact,
  phaseActionPending,
  requestError,
  stageName = "this stage",
}: SessionReviewBarProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [blockingTarget, setBlockingTarget] = useState<BlockingReviewTarget | null>(null);
  const blockerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const refreshTriggerRef = useRef<HTMLButtonElement | null>(null);
  const blockerLabel = (target: BlockingReviewTarget) =>
    `${stageNames?.[target.stageSlug] ?? "Earlier stage"} · Version ${target.artifactVersion}`;
  const [feedbackDraft, setFeedbackDraft] = useState("");
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [reviewSnapshot, setReviewSnapshot] = useState<FeedbackReviewSnapshot | null>(null);
  const [selectedThreadIds, setSelectedThreadIds] = useState<string[]>([]);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewChanged, setReviewChanged] = useState(false);
  const [preview, setPreview] = useState<{ key: string; text: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewSequence = useRef(0);
  const feedbackFieldId = useId();
  const approveDescriptionId = useId();
  const rejectDescriptionId = useId();
  const decisionHeadingId = attached ? SESSION_REVIEW_DECISION_ID : undefined;
  const feedbackErrorId = useId();
  const feedbackCountId = useId();
  const feedbackRef = useRef<HTMLTextAreaElement | null>(null);
  const rejectInFlightRef = useRef(false);
  const rejectionArtifactRef = useRef<SessionReviewArtifact | null>(null);
  const requestChangesTriggerRef = useRef<HTMLButtonElement | null>(null);
  const approvalFocusRef = useRef<HTMLButtonElement | null>(null);
  const reviewRevisionRef = useRef<number | null>(null);
  const reviewLoadSequence = useRef(0);
  const reviewController = useRef<AbortController | null>(null);
  const requestMemory = useRef(new Map<string, string>());
  const currentApprovalReview = useApprovalReview(
    !suppliedApprovalReview && mode.kind === "reviewable" && mode.canApprove
      ? sessionId
      : undefined,
    reviewArtifact?.artifactId,
  );
  const approvalReview = suppliedApprovalReview ?? currentApprovalReview;
  const firstBlocker = approvalReview.value?.blockingTarget;
  const blockingCount = approvalReview.value?.blockingCount ?? 0;
  const refreshReview = onRefreshReview ?? (() => void approvalReview.refresh());
  const exactReviewClosed =
    exactReviewRevision !== undefined && (mode.kind !== "reviewable" || !approvalReview.value);
  // Server-owned PR delivery readiness gates only a configured final approval.
  // A missing evaluation is decided by the approval RPC, which fails closed.
  const delivery = approvalReview.value?.delivery ?? null;
  const deliveryState = reviewDeliveryState(delivery, verificationState);
  const deliveryBlocker = delivery?.blockers.find(
    (blocker) => blocker.code !== "artifact_blocking_feedback_open",
  );
  const artifactUnverified = Boolean(sessionId) && !reviewArtifact;
  const approvalBlocked =
    Boolean(sessionId) &&
    (artifactUnverified ||
      !approvalReview.value ||
      blockingCount > 0 ||
      (deliveryState !== null && deliveryState !== "ready"));
  const phaseActionBusy = phaseActionPending !== null;
  const displayedError = requestError ?? feedbackError;
  const artifactChanged =
    dialogOpen &&
    (reviewArtifact?.artifactId !== rejectionArtifactRef.current?.artifactId ||
      reviewArtifact?.stageId !== rejectionArtifactRef.current?.stageId ||
      reviewArtifact?.version !== rejectionArtifactRef.current?.version);
  const previewKey = JSON.stringify([
    rejectionArtifactRef.current,
    reviewSnapshot?.reviewRevision,
    [...selectedThreadIds].sort(),
    feedbackDraft.trim(),
  ]);

  async function previewFeedback() {
    const artifact = rejectionArtifactRef.current;
    if (!sessionId || !artifact || reviewRevisionRef.current === null) return;
    const sequence = ++previewSequence.current;
    setPreviewLoading(true);
    setFeedbackError(null);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/feedback-batches/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artifactId: artifact.artifactId,
          version: artifact.version,
          expectedReviewRevision: reviewRevisionRef.current,
          selectedThreadIds,
          note: feedbackDraft,
        }),
      });
      const result = await response.json();
      if (!response.ok || typeof result.renderedFeedback !== "string")
        throw new Error(result.error ?? "Could not preview feedback.");
      if (sequence === previewSequence.current)
        setPreview({ key: previewKey, text: result.renderedFeedback });
    } catch (cause) {
      if (sequence === previewSequence.current)
        setFeedbackError(
          cause instanceof Error ? cause.message : "Couldn’t preview feedback. Draft kept.",
        );
    } finally {
      if (sequence === previewSequence.current) setPreviewLoading(false);
    }
  }

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
        const query = new URLSearchParams({
          artifactId: artifact.artifactId,
          includeUnresolved: "true",
        });
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
        if (exactReviewRevision !== undefined && payload.reviewRevision !== exactReviewRevision) {
          setReviewChanged(true);
          setReviewError("This review link is no longer current. Note kept.");
          return;
        }
        if (cursor && reviewRevisionRef.current !== payload.reviewRevision) {
          setReviewChanged(true);
          setReviewError("Review changed. Refresh comments and reselect threads. Note kept.");
          return;
        }
        reviewRevisionRef.current = payload.reviewRevision;
        setReviewSnapshot((current) => ({
          ...payload,
          mappings:
            cursor && current ? { ...current.mappings, ...payload.mappings } : payload.mappings,
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
    [exactReviewRevision, sessionId],
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

  useLayoutEffect(() => {
    if (phaseActionBusy || !approvalFocusRef.current) return;
    const button = approvalFocusRef.current;
    approvalFocusRef.current = null;
    if (document.activeElement !== document.body) return;
    const target =
      button.isConnected && !button.disabled
        ? button
        : document.getElementById("session-run-activity");
    target?.focus({ preventScroll: true });
  }, [phaseActionBusy]);

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
    if (phaseActionBusy || exactReviewClosed || rejectInFlightRef.current) return;
    const trimmed = feedbackDraft.trim();
    if (artifactChanged) return;
    if (
      sessionId &&
      (reviewLoading || reviewChanged || reviewError || reviewRevisionRef.current === null)
    ) {
      setFeedbackError("Refresh comments before submitting. Note kept.");
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
      setFeedbackError("Submission unconfirmed. Draft kept. Retry this submission.");
    } finally {
      rejectInFlightRef.current = false;
    }
  }

  return (
    <>
      <section
        aria-labelledby={decisionHeadingId}
        className={cn(
          "bg-sheet/95 py-3 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] backdrop-blur",
          attached ? "rounded-b-[6px] border-t border-border" : "sticky bottom-0 z-20",
          "pb-[max(0.75rem,env(safe-area-inset-bottom))]",
        )}
      >
        {attached ? (
          <h3
            className="mb-2 scroll-mt-20 rounded-[4px] text-sm font-semibold focus-visible:outline-accent"
            id={decisionHeadingId}
            tabIndex={-1}
          >
            Stage decision
          </h3>
        ) : null}
        {attached && mode.kind === "reviewable" && artifactUnverified && !phaseActionBusy ? (
          <p className="mb-2 text-xs text-muted" role="status">
            Checking the displayed artifact before you can act…
          </p>
        ) : null}
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
            aria-describedby={attached ? rejectDescriptionId : undefined}
            className="ui-button min-h-11 min-w-0 whitespace-normal sm:min-h-9"
            disabled={phaseActionBusy || artifactUnverified || exactReviewClosed}
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
              disabled={phaseActionBusy || approvalBlocked}
              onClick={(event) => {
                if (phaseActionBusy || approvalBlocked) return;
                if (document.activeElement === event.currentTarget)
                  approvalFocusRef.current = event.currentTarget;
                if (sessionId) onApprove(reviewArtifact, approvalReview.value?.reviewRevision);
                else onApprove(reviewArtifact);
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
        {mode.kind === "reviewable" && mode.canApprove && sessionId ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted sm:justify-end">
            {!phaseActionBusy &&
            (approvalReview.error || !approvalReview.value || blockingCount > 0) ? (
              <span role="status">
                {approvalReview.error ??
                  (approvalReview.value
                    ? `${blockingCount} open blocking request${blockingCount === 1 ? "" : "s"}.${firstBlocker ? "" : " Reload review comments to locate the blocking feedback."}`
                    : "Checking blocking requests…")}
              </span>
            ) : null}
            {firstBlocker ? (
              <button
                ref={blockerTriggerRef}
                type="button"
                className="min-h-11 text-left text-accent underline underline-offset-2"
                disabled={phaseActionBusy}
                onClick={() => setBlockingTarget(firstBlocker)}
              >
                Open blocking request{" "}
                <span className="text-muted">({blockerLabel(firstBlocker)})</span>
              </button>
            ) : null}
            <button
              ref={refreshTriggerRef}
              type="button"
              className="min-h-11 min-w-0 text-left text-accent underline underline-offset-2 focus-visible:outline-accent"
              disabled={phaseActionBusy}
              onClick={() => void approvalReview.refresh()}
            >
              Reload review comments
            </button>
            {deliveryState ? (
              <div className="flex min-w-0 basis-full flex-wrap items-center gap-x-2 sm:justify-end">
                <span className="max-w-full" role="status">
                  GitHub delivery readiness:{" "}
                  {deliveryState === "checking"
                    ? "Checking…"
                    : `${readinessStateLabel(deliveryState)}.`}
                  {deliveryState !== "checking" && deliveryBlocker
                    ? ` ${formatDeliveryBlocker(deliveryBlocker)}`
                    : null}
                </span>
                {deliveryEvidenceAvailable && deliveryState !== "ready" ? (
                  <a
                    className="inline-flex min-h-11 items-center text-accent hover:underline"
                    href="#review-evidence"
                  >
                    View GitHub evidence
                  </a>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {attached ? (
          <p id={rejectDescriptionId} className="mt-2 text-xs leading-5 text-muted sm:text-right">
            Requesting changes queues another {stageName} attempt with your feedback.
          </p>
        ) : null}
        {mode.kind === "reviewable" && mode.canApprove && approveDescription ? (
          <p id={approveDescriptionId} className="mt-2 text-xs leading-5 text-muted sm:text-right">
            {approveDescription}
          </p>
        ) : null}
      </section>

      <Dialog
        open={Boolean(blockingTarget)}
        onOpenChange={(open) => !open && setBlockingTarget(null)}
      >
        {blockingTarget && sessionId ? (
          <DialogContent
            title="Blocking request"
            description={blockerLabel(blockingTarget)}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              (blockerTriggerRef.current ?? refreshTriggerRef.current)?.focus();
            }}
          >
            <BlockingArtifactReviewPanel
              syncLocation={false}
              sessionId={sessionId}
              artifactId={blockingTarget.artifactId}
              artifactVersion={blockingTarget.artifactVersion}
              initialThreadId={blockingTarget.threadId}
              historical={blockingTarget.artifactId !== reviewArtifact?.artifactId}
              anchor={null}
              onClearAnchor={() => undefined}
              onBlockingChange={refreshReview}
            />
          </DialogContent>
        ) : null}
      </Dialog>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (phaseActionBusy && !open) return;
          setDialogOpen(open);
          if (!open) setFeedbackError(null);
        }}
      >
        <DialogContent
          description={`Select inline threads or write a note. Wallie will rerun ${stageName} with your feedback.`}
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
              Artifact changed. Draft kept. Close and review the latest output before submitting.
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
                          Original version {thread.artifact_version} · {thread.author_label}
                          {thread.artifact_id !== rejectionArtifactRef.current?.artifactId
                            ? " · Carried forward"
                            : ""}
                          {reviewSnapshot.mappings?.[thread.id]?.status === "outdated"
                            ? " · Outdated selection"
                            : ""}
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
            {sessionId ? (
              <button
                type="button"
                className="ui-button"
                disabled={
                  phaseActionBusy ||
                  exactReviewClosed ||
                  previewLoading ||
                  reviewLoading ||
                  reviewChanged ||
                  artifactChanged ||
                  Boolean(reviewError)
                }
                onClick={() => void previewFeedback()}
              >
                {previewLoading ? "Loading preview…" : "Preview feedback"}
              </button>
            ) : null}
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
                exactReviewClosed ||
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
          {preview?.key === previewKey ? (
            <section
              aria-label="Feedback preview"
              className="mt-3 min-w-0 border-t border-border pt-3"
            >
              <p className="text-xs text-muted">
                Exact current selection. A concurrent review edit will require a refresh before
                submission.
              </p>
              <pre
                tabIndex={0}
                className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs [overflow-wrap:anywhere]"
              >
                {preview.text}
              </pre>
            </section>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
