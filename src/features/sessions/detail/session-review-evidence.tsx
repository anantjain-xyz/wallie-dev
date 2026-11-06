"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { TimeDisplay } from "@/components/shared/time-display";
import { cn } from "@/lib/utils";
import type { ReviewEvidenceDelivery } from "./review-evidence-contracts";
import {
  checkStatusLabel,
  deliveryBlockerSource,
  evidenceStatusLabel,
  formatDeliveryBlocker,
  readinessStateLabel,
} from "./review-evidence-presentation";
import { SessionReviewDiff } from "./session-review-diff";
import { useReviewEvidence } from "./use-review-evidence";

function shortSha(value: string | null) {
  return value ? value.slice(0, 7) : "unknown";
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024).toLocaleString()} KiB`;
  return `${(bytes / (1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB`;
}

function freshnessLabel(seconds: number) {
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} hr`;
  return `${Math.round(seconds / 86_400)} days`;
}

function stateTone(state: ReviewEvidenceDelivery["evaluation"]["state"]) {
  if (state === "ready") return "border-success/30 bg-success-soft text-success";
  if (state === "blocked") return "border-danger/30 bg-danger-soft text-danger";
  if (state === "checking") return "border-warning/30 bg-warning-soft text-warning";
  if (state === "merged" || state === "closed")
    return "border-accent/20 bg-accent-soft text-accent";
  return "border-border bg-control-muted text-muted";
}

function checkTone(status: ReviewEvidenceDelivery["checks"][number]["status"]) {
  if (status === "passed") return "text-success";
  if (status === "failed") return "text-danger";
  if (status === "pending") return "text-warning";
  return "text-muted";
}

function evidenceTone(status: "passed" | "missing" | "stale" | "failed" | "unavailable") {
  if (status === "passed") return "text-success";
  if (status === "failed" || status === "unavailable") return "text-danger";
  if (status === "missing" || status === "stale") return "text-warning";
  return "text-muted";
}

function reviewDecisionLabel(decision: string | null) {
  switch (decision) {
    case "APPROVED":
      return "Approved";
    case "CHANGES_REQUESTED":
      return "Changes requested";
    case "REVIEW_REQUIRED":
      return "Review required";
    default:
      return "Unknown";
  }
}

const BlockingArtifactReviewPanel = dynamic(() =>
  import("@/features/sessions/review/review-panel").then((module) => module.ArtifactReviewPanel),
);

function SourceLink({
  source,
  onOpenComments,
  commentsAvailable,
}: {
  source: ReturnType<typeof deliveryBlockerSource>;
  onOpenComments: (opener: HTMLButtonElement) => void;
  commentsAvailable: boolean;
}) {
  if (!source) return null;
  if (source.kind === "comments")
    return (
      <button
        type="button"
        className="min-h-11 shrink-0 text-accent underline"
        disabled={!commentsAvailable}
        onClick={(event) => onOpenComments(event.currentTarget)}
      >
        {source.label}
      </button>
    );
  if (source.kind === "anchor")
    return (
      <a className="min-h-11 shrink-0 content-center text-accent underline" href={source.href}>
        {source.label}
      </a>
    );
  return (
    <a
      className="min-h-11 shrink-0 content-center text-accent underline"
      href={source.href}
      rel="noreferrer"
      target="_blank"
    >
      {source.label}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function EvidenceSection({
  delivery,
  initialNow,
}: {
  delivery: ReviewEvidenceDelivery;
  initialNow: string;
}) {
  const evidence = delivery.evidence;
  return (
    <section aria-labelledby="review-evidence-evidence-heading" id="review-evidence-evidence">
      <h3 id="review-evidence-evidence-heading" className="text-sm font-semibold text-foreground">
        Verification evidence
      </h3>
      {evidence?.commitSha ? (
        <p className="mt-1 text-xs text-muted">
          Accepted commit <code className="font-mono">{shortSha(evidence.commitSha)}</code>
          {evidence.validationTreeSha ? (
            <>
              {" "}
              · validation tree{" "}
              <code className="font-mono">{shortSha(evidence.validationTreeSha)}</code>
            </>
          ) : null}
        </p>
      ) : null}
      {evidence?.required.length ? (
        <ul className="mt-2 space-y-1 text-xs">
          {evidence.required.map((item) => (
            <li key={item.key} className="flex flex-wrap items-baseline gap-2">
              <span className={cn("font-medium", evidenceTone(item.status))}>
                {evidenceStatusLabel(item.status)}
              </span>
              <code className="break-all font-mono">{item.key}</code>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-muted">
          No named validation evidence is required by this delivery policy.
        </p>
      )}
      {evidence?.records.length ? (
        <>
          <h4 className="mt-3 text-xs font-semibold text-foreground">Harness receipts</h4>
          <ul className="mt-2 space-y-1 text-xs text-muted">
            {evidence.records.map((record) => (
              <li key={`${record.key}:${record.completedAt}`} className="flex flex-wrap gap-x-2">
                <span
                  className={
                    record.status === "passed" && record.exitCode === 0
                      ? "font-medium text-success"
                      : "font-medium text-danger"
                  }
                >
                  {record.status}
                </span>
                <code className="break-all font-mono">{record.key}</code>
                <span>exit {record.exitCode ?? "unknown"}</span>
                <span>
                  <TimeDisplay
                    initialNow={initialNow}
                    value={record.completedAt}
                    variant="relative"
                  />
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-2 text-xs text-muted">
          No harness receipt is recorded for the accepted commit.
        </p>
      )}
      {evidence?.assets.length ? (
        <>
          <h4 className="mt-3 text-xs font-semibold text-foreground">Evidence files</h4>
          <ul className="mt-2 flex flex-wrap gap-2">
            {evidence.assets.map((asset) => (
              <li key={asset.id}>
                <a
                  className="ui-button min-h-11 text-xs"
                  href={asset.downloadUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  {asset.key}
                  <span className="text-muted">
                    {" "}
                    · {asset.kind} · {formatBytes(asset.sizeBytes)}
                  </span>
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

/** Server-owned readiness, source links, and bounded code diff for review. */
export function SessionReviewEvidence({
  historical,
  initialNow,
  sessionId,
}: {
  historical: boolean;
  initialNow: string;
  sessionId: string;
}) {
  const { value, error, loading, refresh } = useReviewEvidence(sessionId);
  const valueRef = useRef(value);
  valueRef.current = value;
  const [refreshPending, setRefreshPending] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [commentsTarget, setCommentsTarget] =
    useState<ReviewEvidenceDelivery["artifactBlockingTarget"]>(null);
  const commentsOpenerRef = useRef<HTMLButtonElement | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentsSelectionRevision, setCommentsSelectionRevision] = useState(0);
  const pollBaselineRef = useRef<string | null>(null);
  const pollAttemptsRef = useRef(0);
  const autoPollKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!value || value.requirements.deliveryMode !== "code") return;
    if (value.refresh.status !== "pending" && value.refresh.status !== "claimed") return;
    if (polling) return;
    if (autoPollKeyRef.current === "manual") return;
    const key = `${value.refresh.status}:${value.sourceObservationId ?? ""}`;
    if (autoPollKeyRef.current === key) return;
    autoPollKeyRef.current = key;
    pollBaselineRef.current = value.sourceObservationId;
    pollAttemptsRef.current = 0;
    setPolling(true);
  }, [polling, value]);

  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      if (cancelled) return;
      pollAttemptsRef.current += 1;
      const next = await refresh();
      if (cancelled) return;
      if (next?.refresh.status === "error") {
        setRefreshError("GitHub verification refresh failed. Retry to collect a new observation.");
        setPolling(false);
        return;
      }
      const settled =
        Boolean(next) &&
        next?.refresh.status === "current" &&
        next.sourceObservationId !== pollBaselineRef.current;
      if (settled) {
        setRefreshError(null);
        setPolling(false);
        return;
      }
      if (pollAttemptsRef.current >= 10) {
        setPolling(false);
        return;
      }
      timer = window.setTimeout(poll, 2_000);
    };
    timer = window.setTimeout(poll, 1_200);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [polling, refresh]);

  const queueRefreshing =
    value?.refresh.status === "pending" || value?.refresh.status === "claimed";
  const refreshBusy = refreshPending || polling;
  const displayedError = refreshError;

  const requestRefresh = useCallback(async () => {
    setRefreshPending(true);
    setRefreshError(null);
    autoPollKeyRef.current = "manual";
    pollBaselineRef.current = valueRef.current?.sourceObservationId ?? null;
    pollAttemptsRef.current = 0;
    try {
      const response = await fetch(`/api/sessions/${sessionId}/pr-verification/refresh`, {
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? "GitHub refresh could not be queued.");
      setPolling(true);
      await refresh();
    } catch (cause) {
      setRefreshError(
        cause instanceof Error
          ? cause.message
          : "GitHub refresh could not be queued. Retry to verify again.",
      );
    } finally {
      setRefreshPending(false);
    }
  }, [refresh, sessionId]);

  if (!value && loading) {
    return (
      <section aria-label="Delivery readiness" className="min-w-0 border-t border-border pt-5">
        <p className="text-xs text-muted" role="status">
          Loading delivery readiness…
        </p>
      </section>
    );
  }
  if (!value && error) {
    return (
      <section aria-label="Delivery readiness" className="min-w-0 border-t border-border pt-5">
        <div className="rounded-[4px] border border-danger/20 bg-danger-soft p-3" role="alert">
          <p className="text-xs text-danger">{error}</p>
          <button type="button" className="ui-button mt-2 min-h-11" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      </section>
    );
  }
  if (!value || value.requirements.deliveryMode !== "code") return null;

  const delivery = value;
  const openBlockingComments = (opener: HTMLButtonElement) => {
    const target = delivery.artifactBlockingTarget;
    if (!target) return;
    commentsOpenerRef.current = opener;
    setCommentsTarget(target);
    setCommentsOpen(true);
    setCommentsSelectionRevision((revision) => revision + 1);
  };
  const pr = delivery.pr;
  const blockers = delivery.evaluation.blockers;
  const evidenceHref = "#review-evidence-evidence";
  const prChecksUrl = pr?.url ? `${pr.url}/checks` : null;
  const terminal = delivery.evaluation.state === "merged" || delivery.evaluation.state === "closed";
  const historicalNote = historical
    ? "Historical view: readiness and code changes describe the current canonical pull request, not the older artifact selection shown above."
    : !delivery.finalStage
      ? "This is not the final delivery stage. Readiness is advisory here; final approval applies the delivery gate."
      : null;

  return (
    <section
      aria-labelledby="review-evidence-heading"
      className="min-w-0 border-t border-border pt-5"
      id="review-evidence"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="review-evidence-heading" className="text-base font-semibold text-foreground">
            Delivery readiness
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted">
            Server-derived from GitHub observations and recorded validation evidence. Approval never
            implies a merge or deployment.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "rounded-[4px] border px-2 py-1 text-xs font-medium",
              stateTone(delivery.evaluation.state),
            )}
            role="status"
          >
            {readinessStateLabel(delivery.evaluation.state)}
          </span>
          {delivery.refresh.canRefresh ? (
            <button
              id="review-evidence-refresh"
              type="button"
              aria-busy={refreshBusy || undefined}
              className="ui-button min-h-11"
              disabled={refreshBusy}
              onClick={() => void requestRefresh()}
            >
              <ActionButtonLabel
                idle={queueRefreshing && !refreshBusy ? "Refresh again" : "Refresh verification"}
                pending={refreshBusy}
                pendingLabel="Refreshing…"
              />
            </button>
          ) : null}
        </div>
      </div>

      {historicalNote ? (
        <p
          className="mt-3 rounded-[4px] border border-warning/20 bg-warning-soft px-3 py-2 text-xs text-warning"
          role="note"
        >
          {historicalNote}
        </p>
      ) : null}
      {delivery.observationStale ? (
        <p
          className="mt-3 rounded-[4px] border border-warning/20 bg-warning-soft px-3 py-2 text-xs text-warning"
          role="status"
        >
          The last GitHub observation belongs to an earlier or unconfirmed PR epoch. Current
          canonical PR identity is shown without predecessor head, checks, or review detail. Refresh
          verification to collect the current PR.
        </p>
      ) : null}

      {delivery.finalStage && !delivery.approvalGated ? (
        <p className="mt-3 text-xs text-muted">
          This policy does not require readiness for final approval. The summary stays advisory.
        </p>
      ) : null}

      {terminal ? (
        <p className="mt-3 rounded-[4px] border border-accent/20 bg-accent-soft px-3 py-2 text-xs text-accent">
          GitHub reports this pull request as {delivery.evaluation.state}. Wallie does not infer a
          deployment from approval or merge state.
        </p>
      ) : blockers.length ? (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-foreground">
            Blocking delivery ({blockers.length})
          </h3>
          <ul className="mt-2 space-y-2">
            {blockers.map((blocker) => {
              const source = deliveryBlockerSource(blocker, {
                canRefresh: delivery.refresh.canRefresh,
                evidenceHref,
                prUrl: pr?.url ?? null,
                prChecksUrl,
                repositoryUrl: pr?.repositoryUrl ?? null,
              });
              return (
                <li
                  key={`${blocker.code}:${blocker.requirement ?? ""}`}
                  className="flex min-w-0 flex-wrap items-start justify-between gap-2 rounded-[4px] border border-border px-3 py-2 text-xs"
                >
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    {formatDeliveryBlocker(blocker)}
                  </span>
                  <SourceLink
                    source={source}
                    onOpenComments={openBlockingComments}
                    commentsAvailable={Boolean(delivery.artifactBlockingTarget)}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p className="mt-4 rounded-[4px] border border-success/30 bg-success-soft px-3 py-2 text-xs text-success">
          Every configured delivery requirement is satisfied for the observed revision.
        </p>
      )}

      {displayedError ? (
        <p className="mt-3 text-xs text-danger" role="alert">
          {displayedError}
        </p>
      ) : null}
      {error && value ? (
        <p className="mt-3 text-xs text-warning" role="status">
          Could not refresh the latest delivery state. Showing the last loaded evidence.
        </p>
      ) : null}
      {queueRefreshing ? (
        <p className="mt-3 text-xs text-muted" role="status">
          {delivery.refresh.status === "pending"
            ? "GitHub verification refresh is queued."
            : "GitHub verification refresh is running."}{" "}
          This panel updates when a new observation lands.
        </p>
      ) : polling ? (
        <p className="mt-3 text-xs text-muted" role="status">
          Waiting for a new GitHub verification observation…
        </p>
      ) : null}
      {delivery.refresh.status === "error" ? (
        <p className="mt-3 text-xs text-warning" role="status">
          The last GitHub verification refresh failed
          {delivery.refresh.lastErrorCode
            ? ` (${delivery.refresh.lastErrorCode.replaceAll("_", " ")})`
            : ""}
          . Use Refresh verification to retry.
        </p>
      ) : null}

      <dl className="mt-4 grid min-w-0 grid-cols-1 gap-x-6 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <div className="min-w-0">
          <dt className="text-muted">Pull request</dt>
          <dd className="mt-1 min-w-0 font-medium text-foreground [overflow-wrap:anywhere]">
            {pr?.url ? (
              <a className="text-accent underline" href={pr.url} rel="noreferrer" target="_blank">
                {pr.repositoryFullName ?? "Repository"}#{pr.number}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : (
              "Not created"
            )}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Head</dt>
          <dd className="mt-1 font-mono text-foreground">{shortSha(pr?.headSha ?? null)}</dd>
        </div>
        <div>
          <dt className="text-muted">Base</dt>
          <dd className="mt-1 font-mono text-foreground">{shortSha(pr?.baseSha ?? null)}</dd>
        </div>
        <div>
          <dt className="text-muted">Observed</dt>
          <dd className="mt-1 text-foreground">
            {pr?.observedAt ? (
              <TimeDisplay initialNow={initialNow} value={pr.observedAt} variant="relative" />
            ) : (
              "Not yet observed"
            )}
            <span className="text-muted">
              {" "}
              · {freshnessLabel(delivery.requirements.freshnessSeconds)} freshness
            </span>
          </dd>
        </div>
      </dl>

      <div className="mt-5 grid min-w-0 gap-5 lg:grid-cols-2">
        <section aria-labelledby="review-evidence-checks-heading">
          <h3 id="review-evidence-checks-heading" className="text-sm font-semibold text-foreground">
            Checks
          </h3>
          {delivery.checks.length ? (
            <ul className="mt-2 space-y-1 text-xs">
              {delivery.checks.map((check) => (
                <li key={check.context} className="flex flex-wrap items-baseline gap-2">
                  <span className={cn("font-medium", checkTone(check.status))}>
                    {checkStatusLabel(check.status)}
                  </span>
                  <code className="break-all font-mono">{check.context}</code>
                  <span className="text-muted">
                    {check.sources
                      .map((source) =>
                        source === "policy"
                          ? "policy"
                          : source === "ruleset"
                            ? "ruleset"
                            : "branch protection",
                      )
                      .join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-muted">No named required checks are configured.</p>
          )}
          {prChecksUrl ? (
            <a
              className="mt-2 inline-flex min-h-11 items-center text-xs text-accent underline"
              href={prChecksUrl}
              rel="noreferrer"
              target="_blank"
            >
              Open GitHub checks
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : null}
        </section>

        <section aria-labelledby="review-evidence-reviews-heading">
          <h3
            id="review-evidence-reviews-heading"
            className="text-sm font-semibold text-foreground"
          >
            Reviews and threads
          </h3>
          {delivery.review ? (
            <ul className="mt-2 space-y-1 text-xs text-muted">
              <li>
                Current-head approvals:{" "}
                <span className="font-medium text-foreground">
                  {delivery.review.currentHeadApprovals} of {delivery.review.minimumApprovals}{" "}
                  required
                </span>
              </li>
              <li>
                GitHub decision:{" "}
                <span className="font-medium text-foreground">
                  {reviewDecisionLabel(delivery.review.decision)}
                </span>
              </li>
              <li>
                Unresolved GitHub threads:{" "}
                <span className="font-medium text-foreground">
                  {delivery.review.unresolvedThreads}
                </span>
                {delivery.review.requireResolvedThreads ? " (resolution required)" : ""}
              </li>
              <li>
                Wallie blocking requests:{" "}
                <span className="font-medium text-foreground">
                  {delivery.artifactBlockingCount}
                </span>
              </li>
              <li>
                Merge state:{" "}
                <span className="font-medium text-foreground">
                  {delivery.review.mergeStateStatus ?? "Unknown"}
                </span>
              </li>
            </ul>
          ) : (
            <p className="mt-2 text-xs text-muted">
              No GitHub review detail is recorded for the current observation.
            </p>
          )}
          {pr?.url ? (
            <a
              className="mt-2 inline-flex min-h-11 items-center text-xs text-accent underline"
              href={`${pr.url}#pullrequestreviews`}
              rel="noreferrer"
              target="_blank"
            >
              Open GitHub reviews
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : null}
          {delivery.artifactBlockingCount > 0 ? (
            <button
              type="button"
              className="mt-2 flex min-h-11 items-center text-xs text-accent underline"
              disabled={!delivery.artifactBlockingTarget}
              onClick={(event) => openBlockingComments(event.currentTarget)}
            >
              Open Comments
            </button>
          ) : null}
        </section>
      </div>

      {delivery.artifactBlockingCount > 0 && !delivery.artifactBlockingTarget ? (
        <p className="mt-3 text-xs text-warning">
          Refresh delivery readiness to locate the blocking feedback.
        </p>
      ) : null}
      {commentsTarget ? (
        <section className="mt-5" aria-label="Blocking artifact feedback" hidden={!commentsOpen}>
          <p className="mb-2 text-xs text-muted">
            Blocking feedback on {commentsTarget.stageSlug} · Version{" "}
            {commentsTarget.artifactVersion}
          </p>
          <BlockingArtifactReviewPanel
            key={commentsTarget.threadId}
            panelId="review-evidence-comments"
            syncLocation={false}
            sessionId={sessionId}
            artifactId={commentsTarget.artifactId}
            artifactVersion={commentsTarget.artifactVersion}
            initialThreadId={commentsTarget.threadId}
            sourceSelectionRevision={commentsSelectionRevision}
            historical={false}
            anchor={null}
            onClearAnchor={() => undefined}
            onClose={() => setCommentsOpen(false)}
            openerRef={commentsOpenerRef}
          />
        </section>
      ) : null}

      <div className="mt-5">
        <EvidenceSection delivery={delivery} initialNow={initialNow} />
      </div>

      <div className="mt-5">
        <SessionReviewDiff
          key={pr?.url ?? "no-pull-request"}
          historical={historical}
          observedHeadSha={pr?.headSha ?? null}
          observedBaseSha={pr?.baseSha ?? null}
          prUrl={pr?.url ?? null}
          sessionId={sessionId}
        />
      </div>
    </section>
  );
}
