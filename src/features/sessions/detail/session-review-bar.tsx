"use client";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
import reviewLayout from "./session-review-layout.module.css";

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
  const reviewSnapshotRef = useRef<FeedbackReviewSnapshot | null>(null);
  const [selectedThreadIds, setSelectedThreadIds] = useState<string[]>([]);
  const selectedThreadsRef = useRef<string[]>([]);
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewChanged, setReviewChanged] = useState(false);
  const [preview, setPreview] = useState<{ key: string; text: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewSequence = useRef(0);
  const feedbackFieldId = useId();
  const approveDescriptionId = useId();
  const decisionHeadingId = useId();
  const feedbackErrorId = useId();
  const feedbackCountId = useId();
  const feedbackRef = useRef<HTMLTextAreaElement | null>(null);
  const feedbackTitleRef = useRef<HTMLSpanElement | null>(null);
  const rejectInFlightRef = useRef(false);
  const rejectionArtifactRef = useRef<SessionReviewArtifact | null>(null);
  const rejectionStageRef = useRef(stageName);
  const requestChangesTriggerRef = useRef<HTMLButtonElement | null>(null);
  const approvalFocusRef = useRef<HTMLButtonElement | null>(null);
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
    exactReviewRevision !== undefined &&
    (mode.kind !== "reviewable" || approvalReview.value?.reviewRevision !== exactReviewRevision);
  // Server-owned PR delivery readiness gates only a configured final approval.
  // A missing evaluation is decided by the approval RPC, which fails closed.
  const delivery = approvalReview.value?.delivery ?? null;
  const deliveryState = reviewDeliveryState(delivery, verificationState);
  const deliveryBlocker = delivery?.blockers.find(
    (blocker) => blocker.code !== "artifact_blocking_feedback_open",
  );
  const artifactUnverified = Boolean(sessionId) && !reviewArtifact;
  const approvalBlocked =
    exactReviewClosed ||
    (Boolean(sessionId) &&
      (artifactUnverified ||
        !approvalReview.value ||
        blockingCount > 0 ||
        (deliveryState !== null && deliveryState !== "ready")));
  const phaseActionBusy = phaseActionPending !== null;
  const displayedError = requestError ?? feedbackError;
  const artifactChanged =
    dialogOpen &&
    (reviewArtifact?.artifactId !== rejectionArtifactRef.current?.artifactId ||
      reviewArtifact?.stageId !== rejectionArtifactRef.current?.stageId ||
      reviewArtifact?.version !== rejectionArtifactRef.current?.version);
  const reviewUnavailable = mode.kind !== "reviewable" && !phaseActionBusy;
  const commentsChanged =
    reviewChanged ||
    (reviewSnapshot !== null &&
      (approvalReview.value?.reviewRevision ?? 0) > reviewSnapshot.reviewRevision);
  const previewKey = JSON.stringify([
    rejectionArtifactRef.current,
    reviewSnapshot?.reviewRevision,
    [...selectedThreadIds].sort(),
    feedbackDraft.trim(),
  ]);

  async function previewFeedback() {
    const artifact = rejectionArtifactRef.current;
    const revision = reviewSnapshotRef.current?.reviewRevision;
    if (!sessionId || !artifact || revision === undefined) return;
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
          expectedReviewRevision: revision,
          selectedThreadIds,
          note: feedbackDraft,
        }),
      });
      const result = await response.json();
      if (response.status === 409) void loadReview();
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
    async (cursor: ReviewCursor | null = null, acceptUpdatedReview = false) => {
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
          return;
        }
        const current = reviewSnapshotRef.current;
        if (current && payload.reviewRevision < current.reviewRevision)
          throw new Error("Couldn’t confirm the current comments.");
        if (
          current &&
          payload.reviewRevision !== current.reviewRevision &&
          (cursor || !acceptUpdatedReview)
        ) {
          setReviewChanged(true);
          return;
        }
        const threads = new Map(payload.threads.map((thread) => [thread.id, thread]));
        if (current?.reviewRevision === payload.reviewRevision) {
          payload.nextCursor = cursor ? payload.nextCursor : current.nextCursor;
          payload.threads = [
            ...new Map(
              [...current.threads, ...payload.threads].map((thread) => [thread.id, thread]),
            ).values(),
          ];
          payload.mappings = { ...current.mappings, ...payload.mappings };
          payload.submittedThreadRevisions = {
            ...current.submittedThreadRevisions,
            ...payload.submittedThreadRevisions,
          };
        } else if (current && acceptUpdatedReview) {
          const selected = current.threads.filter((thread) =>
            selectedThreadsRef.current.includes(thread.id),
          );
          const missing = await Promise.all(
            selected
              .filter((thread) => !threads.has(thread.id))
              .map(async ({ id }) => {
                const response = await fetch(`/api/sessions/${sessionId}/reviews/${id}`, {
                  cache: "no-store",
                  signal: controller.signal,
                });
                if (response.status === 404) return null;
                if (!response.ok) throw new Error("Couldn’t refresh selected threads.");
                return (await response.json()) as {
                  thread: ArtifactReviewThread;
                  submittedThreadRevision: number | null;
                };
              }),
          );
          if (controller.signal.aborted || sequence !== reviewLoadSequence.current) return;
          for (const result of missing) {
            if (!result || result.thread.status !== "open") continue;
            const thread = result.thread;
            threads.set(thread.id, thread);
            payload.threads.push(thread);
            const mapping = current.mappings?.[thread.id];
            if (mapping) (payload.mappings ??= {})[thread.id] = mapping;
            if (result.submittedThreadRevision !== null)
              payload.submittedThreadRevisions[thread.id] = result.submittedThreadRevision;
          }
          const kept = selected
            .filter((thread) => {
              const updated = threads.get(thread.id);
              return updated?.status === "open" && updated.revision === thread.revision;
            })
            .map((thread) => thread.id);
          selectedThreadsRef.current = kept;
          setSelectedThreadIds(kept);
          setSelectionNotice(
            kept.length === selected.length ? null : "Changed or closed threads were deselected.",
          );
        }
        if (acceptUpdatedReview) setReviewChanged(false);
        reviewSnapshotRef.current = payload;
        setReviewSnapshot(payload);
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

  const refreshDialogOnFocus = useEffectEvent(() => {
    if (
      phaseActionBusy ||
      artifactChanged ||
      reviewUnavailable ||
      reviewLoading ||
      rejectInFlightRef.current
    )
      return;
    void loadReview();
  });

  useEffect(() => {
    if (!dialogOpen || !sessionId) return;
    void loadReview();
    const refresh = () => refreshDialogOnFocus();
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      reviewLoadSequence.current += 1;
      reviewController.current?.abort();
    };
  }, [dialogOpen, loadReview, sessionId]);

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
      <div className="mt-4 rounded-md border border-border px-3 py-2" role="status">
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
    const reviewRevision = reviewSnapshotRef.current?.reviewRevision;
    if (artifactChanged || reviewUnavailable) return;
    if (
      sessionId &&
      (reviewLoading || commentsChanged || reviewError || reviewRevision === undefined)
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
          reviewRevision,
          ids,
          trimmed,
        ]);
        if (!requestMemory.current.has(fingerprint))
          requestMemory.current.set(fingerprint, crypto.randomUUID());
        submission = {
          requestId: requestMemory.current.get(fingerprint)!,
          expectedReviewRevision: reviewRevision!,
          selectedThreadIds: ids,
        };
      }
      const succeeded = submission
        ? await onReject(trimmed, rejectionArtifactRef.current, submission)
        : await onReject(trimmed, rejectionArtifactRef.current);
      if (succeeded) {
        setFeedbackDraft("");
        selectedThreadsRef.current = [];
        setSelectedThreadIds([]);
        setSelectionNotice(null);
        requestMemory.current.clear();
        setDialogOpen(false);
      } else void loadReview();
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
        id={SESSION_REVIEW_DECISION_ID}
        tabIndex={-1}
        inert={dialogOpen || Boolean(blockingTarget)}
        className={cn(
          reviewLayout.decision,
          "mt-4 rounded-t-md border border-border bg-sheet pt-2 shadow-[0_-4px_20px_-12px_var(--border-strong)] focus-visible:outline-accent",
          "pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))]",
          "pb-[max(0.75rem,env(safe-area-inset-bottom))]",
          (dialogOpen || blockingTarget) && "invisible",
        )}
      >
        <h2 className="sr-only" id={decisionHeadingId}>
          Stage decision
        </h2>
        {mode.kind === "reviewable" &&
        !phaseActionBusy &&
        (artifactUnverified || (mode.canApprove && sessionId && approvalBlocked)) ? (
          <div className="mb-2 flex flex-wrap items-center gap-x-3 text-xs text-muted [overflow-wrap:anywhere]">
            {artifactUnverified ? (
              <span role="status">Checking the displayed artifact…</span>
            ) : approvalReview.error || !approvalReview.value || blockingCount > 0 ? (
              <span role="status">
                {approvalReview.error ??
                  (approvalReview.value
                    ? `${blockingCount} open blocking request${blockingCount === 1 ? "" : "s"} must be resolved before approval.`
                    : "Checking review comments…")}
              </span>
            ) : null}
            {firstBlocker ? (
              <button
                ref={blockerTriggerRef}
                type="button"
                className="min-h-11 text-left text-accent underline underline-offset-2 focus-visible:outline-accent sm:min-h-8"
                onClick={() => setBlockingTarget(firstBlocker)}
              >
                Open blocking request{" "}
                <span className="text-muted">({blockerLabel(firstBlocker)})</span>
              </button>
            ) : null}
            {approvalReview.error || (blockingCount > 0 && !firstBlocker) ? (
              <button
                ref={refreshTriggerRef}
                type="button"
                className="min-h-11 text-left text-accent underline underline-offset-2 focus-visible:outline-accent sm:min-h-8"
                onClick={(event) => {
                  event.currentTarget.closest("section")?.focus({ preventScroll: true });
                  void approvalReview.refresh();
                }}
              >
                {approvalReview.error ? "Retry comments" : "Find blocking request"}
              </button>
            ) : null}
            {deliveryState && deliveryState !== "ready" ? (
              <div className="flex min-w-0 basis-full flex-wrap items-center gap-x-3">
                <span className="max-w-full" role="status">
                  GitHub delivery readiness:{" "}
                  {deliveryState === "checking"
                    ? "Checking…"
                    : `${readinessStateLabel(deliveryState)}.`}
                  {deliveryState !== "checking" && deliveryBlocker
                    ? ` ${formatDeliveryBlocker(deliveryBlocker)}`
                    : null}
                </span>
                {deliveryEvidenceAvailable ? (
                  <a
                    className="inline-flex min-h-11 items-center text-accent hover:underline focus-visible:outline-accent sm:min-h-8"
                    href="#review-evidence"
                  >
                    View GitHub evidence
                  </a>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end sm:gap-4">
          {mode.kind === "reviewable" && mode.canApprove ? (
            approveDescription ? (
              <p className="min-w-0 text-xs leading-5 text-foreground [overflow-wrap:anywhere]">
                {reviewArtifact ? (
                  <>
                    <span className="font-semibold">
                      {stageName} v{reviewArtifact.version}
                    </span>
                    <span aria-hidden="true"> · </span>
                  </>
                ) : null}
                <span id={approveDescriptionId}>{approveDescription}</span>
              </p>
            ) : null
          ) : (
            <p className="min-w-0 text-xs leading-5 text-muted" role="status">
              Only stage approvers can approve.
            </p>
          )}
          <div
            className={cn(
              "gap-2 sm:flex sm:shrink-0",
              mode.kind === "reviewable" && mode.canApprove ? "grid grid-cols-2" : "flex",
            )}
          >
            <button
              ref={requestChangesTriggerRef}
              type="button"
              className="ui-button min-h-11 min-w-0 whitespace-normal focus-visible:outline-accent sm:min-h-9"
              disabled={phaseActionBusy || artifactUnverified || exactReviewClosed}
              onClick={() => {
                const previous = rejectionArtifactRef.current;
                if (
                  previous?.artifactId !== reviewArtifact?.artifactId ||
                  previous?.stageId !== reviewArtifact?.stageId ||
                  previous?.version !== reviewArtifact?.version
                ) {
                  reviewSnapshotRef.current = null;
                  selectedThreadsRef.current = [];
                  setReviewSnapshot(null);
                  setSelectedThreadIds([]);
                  setReviewChanged(false);
                  setSelectionNotice(
                    feedbackDraft
                      ? "Draft kept from the earlier artifact. Check it against this version before sending."
                      : null,
                  );
                }
                setFeedbackError(null);
                rejectionArtifactRef.current = reviewArtifact ? { ...reviewArtifact } : null;
                rejectionStageRef.current = stageName;
                setDialogOpen(true);
              }}
            >
              Request changes
            </button>
            {mode.kind === "reviewable" && mode.canApprove ? (
              <button
                type="button"
                aria-label={phaseActionPending === "approve" ? undefined : approveLabel}
                aria-describedby={approveDescription ? approveDescriptionId : undefined}
                className="ui-button-primary min-h-11 min-w-0 whitespace-normal focus-visible:outline-accent sm:min-h-9"
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
                  idle="Approve"
                  pending={phaseActionPending === "approve"}
                  pendingLabel="Approving…"
                />
              </button>
            ) : null}
          </div>
        </div>
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
              (
                blockerTriggerRef.current ??
                refreshTriggerRef.current ??
                document.getElementById(SESSION_REVIEW_DECISION_ID)
              )?.focus();
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
          className="overscroll-contain"
          description={`Queues another ${rejectionStageRef.current} attempt with your feedback.`}
          dismissible={!phaseActionBusy}
          onKeyDown={(event) => {
            if (!isSessionSubmitShortcut(event)) return;
            event.preventDefault();
            void submitReject();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            requestAnimationFrame(() => {
              const trigger = requestChangesTriggerRef.current;
              (trigger && !trigger.disabled
                ? trigger
                : document.getElementById("session-run-activity")
              )?.focus({ preventScroll: true });
            });
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            feedbackTitleRef.current?.focus();
          }}
          title={
            <span ref={feedbackTitleRef} tabIndex={-1}>
              Request changes
            </span>
          }
        >
          {artifactChanged || reviewUnavailable ? (
            <p className="mb-4 text-sm text-danger" role="alert">
              {artifactChanged
                ? "Artifact changed. Draft kept. Close and review the latest output before submitting."
                : "This review is no longer available. Draft kept."}
            </p>
          ) : null}
          {selectionNotice ? (
            <p className="mb-3 text-xs text-muted" role="status">
              {selectionNotice}
            </p>
          ) : null}
          {sessionId ? (
            <fieldset
              className="mb-4 min-w-0 space-y-2"
              disabled={phaseActionBusy || artifactChanged || reviewUnavailable}
            >
              <legend className="text-xs font-semibold text-foreground">Inline comments</legend>
              {reviewLoading ? (
                <p className="text-xs text-muted" role="status">
                  {reviewSnapshot ? "Checking for updates…" : "Loading inline comments…"}
                </p>
              ) : null}
              {commentsChanged ? (
                <p className="text-xs text-danger" role="alert">
                  {exactReviewRevision !== undefined
                    ? "This review link is no longer current. Open the current review. Note kept."
                    : "Review changed. Check the updated comments before sending. Note kept."}
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
                        disabled={
                          reviewLoading ||
                          commentsChanged ||
                          Boolean(reviewError) ||
                          thread.status !== "open"
                        }
                        aria-label={`Include thread: ${Array.from(quote).slice(0, 120).join("")}`}
                        onChange={(event) => {
                          if (event.target.checked && selectedThreadIds.length >= THREAD_MAX) {
                            setFeedbackError(`Select at most ${THREAD_MAX} threads per revision.`);
                            return;
                          }
                          const ids = event.target.checked
                            ? [...selectedThreadsRef.current, thread.id]
                            : selectedThreadsRef.current.filter((id) => id !== thread.id);
                          selectedThreadsRef.current = ids;
                          setSelectedThreadIds(ids);
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
                    disabled={reviewLoading || commentsChanged || Boolean(reviewError)}
                    onClick={() => void loadReview(reviewSnapshot.nextCursor)}
                  >
                    Load more threads
                  </button>
                ) : null}
                {reviewError || (commentsChanged && exactReviewRevision === undefined) ? (
                  <button
                    type="button"
                    className="ui-button min-h-11"
                    disabled={reviewLoading}
                    onClick={() => {
                      setFeedbackError(null);
                      void loadReview(null, commentsChanged && exactReviewRevision === undefined);
                    }}
                  >
                    {reviewError ? "Retry comments" : "Review updated comments"}
                  </button>
                ) : null}
                {selectedThreadIds.length ? (
                  <p className="text-xs text-muted" role="status">
                    {selectedThreadIds.length} selected · Includes current replies
                    {selectedThreadIds.length >= THREAD_MAX
                      ? ` · Limit of ${THREAD_MAX} reached`
                      : ""}
                  </p>
                ) : null}
              </div>
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
            className="ui-textarea mt-2 min-h-24"
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
          <DialogFooter className="flex-wrap">
            {sessionId ? (
              <button
                type="button"
                aria-label={previewLoading ? undefined : "Preview feedback"}
                className="ui-button"
                disabled={
                  phaseActionBusy ||
                  exactReviewClosed ||
                  previewLoading ||
                  reviewLoading ||
                  commentsChanged ||
                  artifactChanged ||
                  reviewUnavailable ||
                  Boolean(reviewError) ||
                  reviewSnapshot === null
                }
                onClick={() => void previewFeedback()}
              >
                {previewLoading ? "Loading preview…" : "Preview"}
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
                reviewUnavailable ||
                (Boolean(sessionId) &&
                  (reviewLoading ||
                    commentsChanged ||
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
          {preview?.key === previewKey &&
          !commentsChanged &&
          !reviewError &&
          !artifactChanged &&
          !reviewUnavailable ? (
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
