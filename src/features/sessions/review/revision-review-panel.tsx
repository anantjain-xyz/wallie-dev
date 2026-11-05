"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionArtifactMetadata } from "@/features/sessions/types";
import { compareRevisionSources } from "./revision";
import type { FeedbackBatchDetail, FeedbackHistoryPage, ReviewRun } from "./feedback-history";
import type { ReviewCursor, ReviewThreadListPayload } from "./types";
import { RunActivityLink } from "./run-activity-link";

const buttonClass =
  "min-h-11 rounded-[4px] border border-border px-3 py-2 text-xs font-medium hover:bg-control-muted disabled:opacity-60";
const textClass = "whitespace-pre-wrap break-words [overflow-wrap:anywhere]";

async function read<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  const result = await response.json();
  if (!response.ok) throw new Error(result?.error ?? "Could not load revision review.");
  return result as T;
}

export function reviewArtifactLink(
  artifactId: string,
  version: number,
  stage: string,
  threadId?: string,
) {
  const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  params.set("artifactId", artifactId);
  params.set("artifactVersion", String(version));
  params.set("artifactStage", stage);
  if (threadId) params.set("reviewThread", threadId);
  else params.delete("reviewThread");
  return `?${params}`;
}

function RunIdentity({ run, label }: { run: ReviewRun; label: string }) {
  return (
    <div
      id={`review-run-${label === "Producing run" ? "producing" : "revision"}-${run.id}`}
      tabIndex={-1}
      className="mt-2 rounded-[4px] border border-border p-3 text-xs [overflow-wrap:anywhere]"
    >
      <p className="font-semibold">
        {label} · {run.status}
      </p>
      <p>
        {run.model_provider} · {run.model_name} · Attempt {run.attempt_count ?? "unknown"}
      </p>
      <p className="mt-1 font-mono">{run.id}</p>
      <RunActivityLink
        className="mt-2 inline-flex min-h-11 items-center text-accent underline"
        runId={run.id}
        aria-label={`${label} activity`}
      >
        View run activity
      </RunActivityLink>
    </div>
  );
}

/** Loaded only when a reviewer opens Compare. Every source selection uses UUIDs. */
export function RevisionReviewPanel({
  sessionId,
  artifactId,
  version,
  stageSlug,
  source,
}: {
  sessionId: string;
  artifactId: string;
  version: number;
  stageSlug: string;
  source: unknown;
}) {
  const base = `/api/sessions/${sessionId}`;
  const [history, setHistory] = useState<FeedbackHistoryPage | null>(null);
  const [threads, setThreads] = useState<ReviewThreadListPayload | null>(null);
  const [versions, setVersions] = useState<SessionArtifactMetadata[]>([]);
  const [beforeId, setBeforeId] = useState("");
  const [before, setBefore] = useState<{ id: string; payload: unknown } | null>(null);
  const [detail, setDetail] = useState<FeedbackBatchDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [batchPage, setBatchPage] = useState<ReviewCursor | null>(null);
  const [threadPage, setThreadPage] = useState<ReviewCursor | null>(null);
  const detailSequence = useRef(0);
  useEffect(
    () => () => {
      detailSequence.current += 1;
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    const cursorParams = (cursor: ReviewCursor | null): Record<string, string> =>
      cursor ? { cursorCreatedAt: cursor.createdAt, cursorId: cursor.id } : {};
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        setLoading(true);
        setError(null);
      }
    });
    void Promise.all([
      read<FeedbackHistoryPage>(
        `${base}/feedback-batches?${new URLSearchParams({ artifactId, ...cursorParams(batchPage) })}`,
        controller.signal,
      ),
      read<ReviewThreadListPayload>(
        `${base}/reviews?${new URLSearchParams({ artifactId, includeUnresolved: "true", ...cursorParams(threadPage) })}`,
        controller.signal,
      ),
      read<{ artifacts: SessionArtifactMetadata[] }>(
        `${base}/artifacts?stage=${encodeURIComponent(stageSlug)}`,
        controller.signal,
      ),
    ])
      .then(([nextHistory, nextThreads, metadata]) => {
        if (controller.signal.aborted) return;
        setHistory((current) => ({
          ...nextHistory,
          batches:
            batchPage && current
              ? [
                  ...new Map(
                    [...current.batches, ...nextHistory.batches].map((row) => [row.id, row]),
                  ).values(),
                ]
              : nextHistory.batches,
        }));
        setThreads((current) => ({
          ...nextThreads,
          threads:
            threadPage && current
              ? [
                  ...new Map(
                    [...current.threads, ...nextThreads.threads].map((row) => [row.id, row]),
                  ).values(),
                ]
              : nextThreads.threads,
          mappings:
            threadPage && current
              ? { ...current.mappings, ...nextThreads.mappings }
              : nextThreads.mappings,
        }));
        setVersions(metadata.artifacts);
        setBeforeId(
          (current) =>
            current || metadata.artifacts.find((row) => row.id && row.version < version)?.id || "",
        );
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Could not load revision review.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [artifactId, base, stageSlug, version, refresh, batchPage, threadPage]);

  useEffect(() => {
    if (!beforeId) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        setBefore(null);
        setCompareError(null);
      }
    });
    void read<{ artifact: { id: string; payload: unknown } }>(
      `${base}/artifacts?${new URLSearchParams({ stage: stageSlug, artifactId: beforeId })}`,
      controller.signal,
    )
      .then((result) => {
        if (result.artifact.id !== beforeId) throw new Error("Comparison source identity changed.");
        if (!controller.signal.aborted) setBefore(result.artifact);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setCompareError(cause instanceof Error ? cause.message : "Could not load comparison.");
      });
    return () => controller.abort();
  }, [beforeId, base, stageSlug, refresh]);

  const diff = useMemo(
    () =>
      before?.id === beforeId && typeof before.payload === "string" && typeof source === "string"
        ? compareRevisionSources(before.payload, source)
        : null,
    [before, beforeId, source],
  );

  async function showBatch(id: string, cursor: ReviewCursor | null = null) {
    const sequence = ++detailSequence.current;
    if (!cursor) setDetail(null);
    setDetailLoading(true);
    setDetailError(null);
    try {
      const result = await read<FeedbackBatchDetail>(
        `${base}/feedback-batches?${new URLSearchParams({ artifactId, batchId: id, ...(cursor ? { cursorCreatedAt: cursor.createdAt, cursorId: cursor.id } : {}) })}`,
      );
      if (sequence === detailSequence.current)
        setDetail((current) =>
          cursor && current?.batch.id === result.batch.id
            ? {
                ...result,
                outputs: [
                  ...new Map(
                    [...current.outputs, ...result.outputs].map((row) => [row.artifactId, row]),
                  ).values(),
                ],
              }
            : result,
        );
    } catch (cause) {
      if (sequence === detailSequence.current)
        setDetailError(
          cause instanceof Error ? cause.message : "Could not load submitted feedback.",
        );
    } finally {
      if (sequence === detailSequence.current) setDetailLoading(false);
    }
  }

  const groups = [
    { label: "Unresolved feedback", outdated: false },
    { label: "Outdated selections", outdated: true },
  ];
  return (
    <div className="min-w-0 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">
          Version {version} · Original feedback stays open until a reviewer changes its status.
        </p>
        <button
          type="button"
          className={buttonClass}
          disabled={loading}
          onClick={() => {
            setBatchPage(null);
            setThreadPage(null);
            setRefresh((value) => value + 1);
          }}
        >
          Refresh review
        </button>
      </div>
      {loading ? (
        <p role="status" className="text-xs text-muted">
          Loading revision review…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error} Use Refresh review to retry.
        </p>
      ) : null}
      <section aria-label="Compare artifact revisions" className="min-w-0 space-y-3">
        <h4 className="text-sm font-semibold">Compare revisions</h4>
        <label className="block text-xs" htmlFor="compare-artifact-source">
          Compare version {version} with
        </label>
        <select
          id="compare-artifact-source"
          value={beforeId}
          className="min-h-11 w-full rounded-[4px] border border-border bg-surface px-2 text-xs"
          onChange={(event) => setBeforeId(event.target.value)}
        >
          <option value="">Choose a version</option>
          {versions
            .filter((row) => row.id && row.id !== artifactId)
            .map((row) => (
              <option key={row.id} value={row.id}>
                Version {row.version} · {row.authorLabel} · {row.id!.slice(0, 8)}
              </option>
            ))}
        </select>
        {compareError ? (
          <p role="alert" className="text-xs text-danger">
            {compareError} Use Refresh review to retry.
          </p>
        ) : null}
        {beforeId && !before && !compareError ? (
          <p role="status" className="text-xs text-muted">
            Loading comparison…
          </p>
        ) : null}
        {diff ? (
          <div
            aria-label="Source changes"
            tabIndex={0}
            className="max-h-[36rem] min-w-0 overflow-auto rounded-[4px] border border-border"
          >
            <p className="border-b border-border p-3 text-xs text-muted">
              Exact Markdown source · Removed from selected version / Added in version {version}
            </p>
            {diff.map((row, index) => (
              <div
                key={index}
                className={`min-w-0 border-b border-border p-3 ${row.kind === "added" ? "bg-success-soft" : row.kind === "removed" ? "bg-warning-soft" : ""}`}
              >
                <p className="mb-1 text-xs font-semibold">
                  {row.kind === "added"
                    ? "+ Added"
                    : row.kind === "removed"
                      ? "− Removed"
                      : "Unchanged"}
                </p>
                <pre className={`text-xs ${textClass}`}>{row.text}</pre>
              </div>
            ))}
          </div>
        ) : before && !compareError ? (
          <p className="text-xs text-muted">Only Markdown artifacts support source comparison.</p>
        ) : null}
      </section>
      <section aria-label="Feedback disposition" className="space-y-4">
        <h4 className="text-sm font-semibold">Feedback disposition</h4>
        <p className="text-xs text-muted">
          Unchanged, unique source blocks can be mapped. Other selections remain outdated and
          available for explicit resubmission in Request changes.
        </p>
        {groups.map((group) => (
          <section key={group.label} aria-label={group.label}>
            <h5 className="text-xs font-semibold">{group.label}</h5>
            <ul className="mt-2 space-y-2">
              {threads?.threads
                .filter(
                  (thread) =>
                    thread.status === "open" &&
                    (threads.mappings?.[thread.id]?.status !== "mapped") === group.outdated,
                )
                .map((thread) => {
                  const mapping = threads.mappings?.[thread.id];
                  const quote =
                    thread.anchor &&
                    typeof thread.anchor === "object" &&
                    !Array.isArray(thread.anchor)
                      ? String(thread.anchor.quote ?? "")
                      : "";
                  return (
                    <li key={thread.id} className="rounded-[4px] border border-border p-3">
                      <p className="text-xs font-semibold">
                        {thread.kind === "blocking" ? "Blocking request" : "Discussion"} · Open ·{" "}
                        {thread.author_label}
                      </p>
                      <p className="mt-1 text-xs text-muted">
                        Original version {thread.artifact_version}
                        {thread.artifact_id !== artifactId ? " · Carried forward" : ""}
                      </p>
                      <blockquote
                        className={`mt-2 max-h-28 overflow-auto text-xs ${textClass}`}
                        tabIndex={0}
                      >
                        {quote}
                      </blockquote>
                      <p className="mt-2 text-xs text-muted">
                        {mapping?.status === "outdated"
                          ? mapping.reason
                          : mapping?.status === "mapped"
                            ? `Mapped to code points ${mapping.anchor.start}–${mapping.anchor.end} in version ${version}.`
                            : "Mapping unavailable."}
                      </p>
                      <a
                        className={`${buttonClass} mt-2 inline-flex items-center`}
                        href={reviewArtifactLink(
                          thread.artifact_id,
                          thread.artifact_version,
                          stageSlug,
                          thread.id,
                        )}
                      >
                        Open original thread
                      </a>
                    </li>
                  );
                })}
            </ul>
          </section>
        ))}
        {threads && !threads.threads.some((thread) => thread.status === "open") ? (
          <p className="text-xs text-muted">No unresolved feedback in this page.</p>
        ) : null}
        {threads?.nextCursor ? (
          <button
            type="button"
            className={buttonClass}
            disabled={loading}
            onClick={() => setThreadPage(threads.nextCursor)}
          >
            Load more unresolved threads
          </button>
        ) : null}
      </section>
      <section aria-label="Submitted feedback" className="space-y-3">
        <h4 className="text-sm font-semibold">Submitted feedback</h4>
        {history?.producingRun ? (
          <>
            <RunActivityLink
              className="text-xs text-accent underline"
              runId={history.producingRun.id}
            >
              Producing run for version {version}
            </RunActivityLink>
            <RunIdentity run={history.producingRun} label="Producing run" />
          </>
        ) : history ? (
          <p className="text-xs text-muted">
            An exact producing run is unavailable for this artifact.
          </p>
        ) : null}
        {history?.receivedBatchId ? (
          <button
            className={buttonClass}
            type="button"
            onClick={() => void showBatch(history.receivedBatchId!)}
          >
            View feedback received by this revision
          </button>
        ) : null}
        {history?.batches.length === 0 ? (
          <p className="text-xs text-muted">No feedback batches submitted for this stage.</p>
        ) : null}
        <ul className="space-y-2">
          {history?.batches.map((batch) => (
            <li key={batch.id}>
              <button
                type="button"
                className={`${buttonClass} w-full text-left [overflow-wrap:anywhere]`}
                onClick={() => void showBatch(batch.id)}
              >
                Feedback on version {batch.artifact_version} · {batch.actor_label}
                <span className="mt-1 block text-muted">
                  {batch.created_at} · {batch.id.slice(0, 8)}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {history?.nextCursor ? (
          <button
            type="button"
            className={buttonClass}
            disabled={loading}
            onClick={() => setBatchPage(history.nextCursor)}
          >
            Load more feedback batches
          </button>
        ) : null}
        {detailLoading ? (
          <p role="status" className="text-xs text-muted">
            Loading exact submitted feedback…
          </p>
        ) : null}
        {detailError ? (
          <p role="alert" className="text-xs text-danger">
            {detailError} Select the batch again to retry.
          </p>
        ) : null}
        {detail ? (
          <section
            aria-label="Exact submitted feedback"
            className="space-y-3 rounded-[4px] border border-border p-3"
          >
            <h5 className="text-sm font-semibold">
              Exact submitted feedback · Version {detail.batch.artifact_version}
            </h5>
            <p className="text-xs text-muted">
              Submitted by {detail.batch.actor_label}. Later edits and replies are not part of this
              batch.
            </p>
            <a
              className="inline-block text-xs text-accent underline"
              href={reviewArtifactLink(
                detail.batch.artifact_id,
                detail.batch.artifact_version,
                stageSlug,
              )}
            >
              Reviewed artifact
            </a>
            {detail.batch.whole_stage_feedback ? (
              <p className={`text-sm ${textClass}`}>{detail.batch.whole_stage_feedback}</p>
            ) : null}
            {detail.threads.map((thread) => (
              <section
                key={thread.thread_id}
                aria-label={`Submitted thread from version ${thread.sourceVersion}`}
                className="space-y-2 border-t border-border pt-3"
              >
                <p className="text-xs font-semibold">
                  {thread.kind} · Original version {thread.sourceVersion} · Thread revision{" "}
                  {thread.thread_revision}
                </p>
                <blockquote tabIndex={0} className={`max-h-32 overflow-auto text-xs ${textClass}`}>
                  {thread.anchor &&
                  typeof thread.anchor === "object" &&
                  !Array.isArray(thread.anchor)
                    ? String(thread.anchor.quote ?? "")
                    : ""}
                </blockquote>
                <a
                  className="text-xs text-accent underline"
                  href={reviewArtifactLink(
                    thread.artifact_id,
                    thread.sourceVersion,
                    stageSlug,
                    thread.thread_id,
                  )}
                >
                  Inspect original selection and discussion
                </a>
                {thread.comments.map((comment) => (
                  <div key={comment.id}>
                    <p className="text-xs font-semibold">
                      {comment.author_label} · Comment revision {comment.revision}
                    </p>
                    <p className={`mt-1 text-sm ${textClass}`}>{comment.body}</p>
                  </div>
                ))}
              </section>
            ))}
            <details>
              <summary className="min-h-11 cursor-pointer py-3 text-xs font-medium">
                Exact agent input
              </summary>
              <pre tabIndex={0} className={`max-h-72 overflow-auto text-xs ${textClass}`}>
                {detail.batch.rendered_feedback_text}
              </pre>
            </details>
            {detail.initialRun ? (
              <RunIdentity run={detail.initialRun} label="Initial revision run" />
            ) : (
              <p className="text-xs text-muted">Initial run unavailable.</p>
            )}
            {detail.outputs.length ? (
              <ul aria-label="Revision outputs" className="space-y-3">
                {detail.outputs.map((output) => (
                  <li key={output.artifactId}>
                    <a
                      className="text-xs text-accent underline"
                      href={reviewArtifactLink(output.artifactId, output.version, stageSlug)}
                    >
                      Output version {output.version}
                    </a>
                    {output.run && output.run.id !== detail.initialRun?.id ? (
                      <RunIdentity run={output.run} label="Successful revision run" />
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted">
                No accepted output yet. Failed or canceled runs keep this feedback intact; use Retry
                Run, or explicitly select these threads in Request changes on the next review.
              </p>
            )}
            {detail.outputNextCursor ? (
              <button
                type="button"
                className={buttonClass}
                disabled={detailLoading}
                onClick={() => void showBatch(detail.batch.id, detail.outputNextCursor)}
              >
                Load more revision outputs
              </button>
            ) : null}
          </section>
        ) : null}
      </section>
    </div>
  );
}
