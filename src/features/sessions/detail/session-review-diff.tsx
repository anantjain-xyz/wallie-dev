"use client";

import { useEffect, useState } from "react";

import { GitHubIcon } from "@/components/shared/icons/github-icon";
import type { PrDiffFile } from "./review-evidence-contracts";
import { usePrDiff } from "./use-pr-diff";

function shortSha(value: string | null) {
  return value ? value.slice(0, 7) : "unknown";
}

function patchLineKind(line: string) {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+") && !line.startsWith("+++")) return "added";
  if (line.startsWith("-") && !line.startsWith("---")) return "removed";
  return "context";
}

function DiffPatch({ file }: { file: PrDiffFile }) {
  if (!file.patch) return null;
  return (
    <pre
      aria-label={`Unified diff for ${file.filename}`}
      className="mt-2 max-h-[28rem] overflow-auto rounded-[4px] border border-border bg-canvas p-3 text-xs leading-5"
      tabIndex={0}
    >
      <code>
        {file.patch.split("\n").map((line, index) => {
          const kind = patchLineKind(line);
          return (
            <span
              key={`${index}:${line.slice(0, 20)}`}
              className={
                kind === "added"
                  ? "block bg-success-soft text-success"
                  : kind === "removed"
                    ? "block bg-danger-soft text-danger"
                    : kind === "hunk"
                      ? "block text-accent"
                      : "block text-foreground"
              }
            >
              {line}
              {"\n"}
            </span>
          );
        })}
      </code>
    </pre>
  );
}

/** Lazily loads the bounded canonical GitHub diff only when a reviewer asks for it. */
export function SessionReviewDiff({
  historical,
  observedHeadSha,
  prUrl,
  sessionId,
}: {
  historical?: boolean;
  observedHeadSha: string | null;
  prUrl: string | null;
  sessionId: string;
}) {
  const [open, setOpen] = useState(false);
  const { value, error, loading, refresh } = usePrDiff(sessionId);
  const fullDiffUrl = prUrl ? `${prUrl}/files` : null;
  const headMoved = Boolean(
    value && observedHeadSha && value.headSha.toLowerCase() !== observedHeadSha.toLowerCase(),
  );

  useEffect(() => {
    if (!open || value || loading || error) return;
    void refresh();
  }, [error, loading, open, refresh, value]);

  if (!prUrl) return null;

  return (
    <section aria-labelledby="review-evidence-diff-heading" className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-2">
          <h3 id="review-evidence-diff-heading" className="text-sm font-semibold text-foreground">
            Code changes
          </h3>
          {historical ? (
            <span className="text-xs text-warning">
              Current canonical PR diff · not the historical artifact above
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {open ? (
            <button
              type="button"
              className="min-h-11 rounded-[4px] px-3 text-xs font-medium text-muted hover:bg-control-muted hover:text-foreground"
              disabled={loading}
              onClick={() => void refresh()}
            >
              {loading ? "Reloading…" : "Reload"}
            </button>
          ) : null}
          <button
            type="button"
            aria-controls="review-evidence-diff-region"
            aria-expanded={open}
            className="min-h-11 rounded-[4px] px-3 text-xs font-medium text-accent hover:bg-control-muted"
            onClick={() => setOpen((current) => !current)}
          >
            {open ? "Hide code changes" : "Show code changes"}
          </button>
        </div>
      </div>
      {open ? (
        <div id="review-evidence-diff-region" className="mt-3 min-w-0">
          {loading && !value ? (
            <p className="text-xs text-muted" role="status">
              Loading code changes from GitHub…
            </p>
          ) : null}
          {error ? (
            <div className="rounded-[4px] border border-danger/20 bg-danger-soft p-3" role="alert">
              <p className="text-xs text-danger">{error}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className="ui-button min-h-11" onClick={() => void refresh()}>
                  Retry
                </button>
                {fullDiffUrl ? (
                  <a
                    className="ui-button min-h-11"
                    href={fullDiffUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Open full diff on GitHub
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                ) : null}
              </div>
            </div>
          ) : null}
          {value ? (
            <>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                <span>
                  {value.files.length} changed file{value.files.length === 1 ? "" : "s"}
                </span>
                <span className="text-success">+{value.additions.toLocaleString()}</span>
                <span className="text-danger">−{value.deletions.toLocaleString()}</span>
                <span>
                  Head <code className="font-mono">{shortSha(value.headSha)}</code>
                </span>
                <span>
                  Base <code className="font-mono">{shortSha(value.baseSha)}</code>
                </span>
                {value.state === "merged" ? <span>Merged on GitHub</span> : null}
                {value.state === "closed" ? <span>Closed on GitHub</span> : null}
                {value.draft ? <span>Draft</span> : null}
              </div>
              {headMoved ? (
                <p
                  className="mt-2 rounded-[4px] border border-warning/20 bg-warning-soft px-3 py-2 text-xs text-warning"
                  role="status"
                >
                  GitHub now reports head{" "}
                  <code className="font-mono">{shortSha(value.headSha)}</code>, while the last
                  verification observed{" "}
                  <code className="font-mono">{shortSha(observedHeadSha)}</code>. Refresh delivery
                  readiness before approving.
                </p>
              ) : null}
              {value.truncated ? (
                <p className="mt-2 text-xs text-muted">
                  This diff is intentionally bounded. Open GitHub for the complete file and line
                  view.
                </p>
              ) : null}
              {value.files.length === 0 ? (
                <p className="mt-3 text-xs text-muted">
                  GitHub returned no changed files for this pull request.
                </p>
              ) : (
                <ul className="mt-3 space-y-4">
                  {value.files.map((file) => (
                    <li
                      key={`${file.status}:${file.filename}`}
                      className="min-w-0 rounded-[4px] border border-border p-3"
                    >
                      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-foreground">
                            <span className="mr-2 uppercase tracking-wide text-muted">
                              {file.status}
                            </span>
                            <code className="break-all font-mono">{file.filename}</code>
                          </p>
                          {file.previousFilename ? (
                            <p className="mt-1 text-xs text-muted">
                              Renamed from{" "}
                              <code className="break-all font-mono">{file.previousFilename}</code>
                            </p>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-2 text-xs text-muted">
                          <span className="text-success">+{file.additions.toLocaleString()}</span>
                          <span className="text-danger">−{file.deletions.toLocaleString()}</span>
                          {file.blobUrl ? (
                            <a
                              className="text-accent underline"
                              href={file.blobUrl}
                              rel="noreferrer"
                              target="_blank"
                            >
                              Open file
                              <span className="sr-only"> (opens in a new tab)</span>
                            </a>
                          ) : null}
                        </div>
                      </div>
                      <DiffPatch file={file} />
                      {file.patchUnavailable ? (
                        <p className="mt-2 text-xs text-muted">
                          GitHub did not return a text diff for this file (binary or too large).
                          Open the file on GitHub to inspect it.
                        </p>
                      ) : null}
                      {file.patchTruncated ? (
                        <p className="mt-2 text-xs text-warning">
                          This file&apos;s diff is truncated at the review limit. Open the full diff
                          on GitHub.
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {value.hasMore ? (
                <p className="mt-3 text-xs text-muted">
                  Only the first {value.limits.maxFiles} changed files are shown. Open the full diff
                  on GitHub for the rest.
                </p>
              ) : null}
              {fullDiffUrl ? (
                <a
                  className="ui-button mt-3 min-h-11"
                  href={fullDiffUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  <GitHubIcon className="size-4" />
                  Open full diff on GitHub
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
