"use client";

import Image from "next/image";
import { type ReactNode, useId, useState } from "react";

import { TimeDisplay } from "@/components/shared/time-display";
import { SessionConnections } from "@/features/sessions/components/session-connections";
import type { SessionReviewSession } from "@/features/sessions/detail/data";

export type SessionInspectorRepository = {
  defaultBranch: string | null;
  fullName: string;
  htmlUrl: string;
};

type SessionInspectorProps = {
  creatorDisplayName: string | null;
  initialNow: string;
  repository: SessionInspectorRepository | null;
  session: SessionReviewSession;
};

function CreatorAvatar({ displayName }: { displayName: string }) {
  const initial = displayName.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden="true"
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border bg-control-hover type-annotation font-semibold text-foreground"
    >
      {initial}
    </span>
  );
}

function ContextRow({ label, children }: { children: ReactNode; label: string }) {
  return (
    <div className="grid gap-1 border-b border-border py-3 last:border-b-0 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
      <dt className="type-annotation font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className="min-w-0 text-sm text-foreground">{children}</dd>
    </div>
  );
}

export function SessionInspector({
  creatorDisplayName,
  initialNow,
  repository,
  session,
}: SessionInspectorProps) {
  const [runInputOpen, setRunInputOpen] = useState(false);
  const runInputId = useId();
  const hasConnections =
    !!session.linearIssueUrl ||
    session.pullRequests.some((pullRequest) => pullRequest.pullRequestUrl);

  return (
    <section className="flex min-h-0 flex-col">
      <h2 className="mb-3 text-[13px] font-semibold text-foreground">Context</h2>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <dl>
          <ContextRow label="Linear">
            {session.linearIssueUrl ? (
              <SessionConnections
                linearIssueId={session.linearIssueId}
                linearIssueUrl={session.linearIssueUrl}
                quiet
              />
            ) : (
              <span className="text-muted">No Linear issue linked.</span>
            )}
          </ContextRow>

          <ContextRow label="Repository">
            {repository ? (
              <div className="space-y-1">
                <a
                  className="font-medium text-accent hover:underline"
                  href={repository.htmlUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  {repository.fullName}
                </a>
                {repository.defaultBranch ? (
                  <p className="type-annotation text-muted">
                    Branch{" "}
                    <span className="font-mono text-foreground">{repository.defaultBranch}</span>
                  </p>
                ) : null}
              </div>
            ) : (
              <span className="text-muted">No repository configured.</span>
            )}
          </ContextRow>

          <ContextRow label="Pull request">
            {hasConnections && session.pullRequests.some((pr) => pr.pullRequestUrl) ? (
              <SessionConnections
                linearIssueId={null}
                linearIssueUrl={null}
                pullRequests={session.pullRequests}
                quiet
              />
            ) : (
              <span className="text-muted">No pull request yet.</span>
            )}
          </ContextRow>

          <ContextRow label="Creator">
            {creatorDisplayName ? (
              <span className="inline-flex items-center gap-2">
                <CreatorAvatar displayName={creatorDisplayName} />
                <span className="min-w-0 break-all">{creatorDisplayName}</span>
              </span>
            ) : (
              <span className="text-muted">Unknown</span>
            )}
          </ContextRow>

          <ContextRow label="Created">
            <TimeDisplay absoluteStyle="short" initialNow={initialNow} value={session.createdAt} />
          </ContextRow>
        </dl>

        <div className="mt-2 border-t border-border pt-3">
          <button
            type="button"
            aria-controls={runInputId}
            aria-expanded={runInputOpen}
            className="flex w-full items-center justify-between gap-2 text-left text-xs font-semibold text-foreground"
            onClick={() => setRunInputOpen((open) => !open)}
          >
            <span>Run input</span>
            <span className="font-normal text-muted">{runInputOpen ? "Hide" : "Show"}</span>
          </button>
          {runInputOpen ? (
            <div
              aria-label="Run input"
              id={runInputId}
              className="mt-2 max-h-80 space-y-3 overflow-auto rounded-[4px] border border-border bg-canvas p-3"
              role="region"
              tabIndex={0}
            >
              <pre className="whitespace-pre-wrap break-words text-xs leading-5 text-foreground">
                {session.promptMd || "No run input recorded."}
              </pre>
              {session.attachments.length > 0 ? (
                <ul className="grid grid-cols-2 gap-2">
                  {session.attachments.map((attachment) => (
                    <li key={attachment.id} className="min-w-0">
                      <a
                        className="block overflow-hidden rounded-[4px] border border-border bg-control-muted"
                        href={`/api/sessions/${session.id}/attachments/${attachment.id}`}
                        rel="noreferrer"
                        target="_blank"
                      >
                        <Image
                          alt={attachment.fileName}
                          className="h-24 w-full object-cover"
                          height={96}
                          src={`/api/sessions/${session.id}/attachments/${attachment.id}`}
                          unoptimized
                          width={160}
                        />
                        <span className="block truncate px-2 py-1 type-annotation text-foreground">
                          {attachment.fileName}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : (
            <p className="mt-1 type-annotation text-muted">
              Collapsed — expand to inspect the original session input.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
