"use client";

import Image from "next/image";
import { useId, useState } from "react";

import { ChevronDownIcon } from "@/components/shared/icons/chevron-down-icon";
import { GitHubIcon } from "@/components/shared/icons/github-icon";
import { TimeDisplay } from "@/components/shared/time-display";
import { SessionConnections } from "@/features/sessions/components/session-connections";
import type { SessionReviewSession } from "@/features/sessions/detail/data";
import { cn } from "@/lib/utils";

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

/** Session-wide context stays above the stage workspace, including its original input. */
export function SessionInspector({
  creatorDisplayName,
  initialNow,
  repository,
  session,
}: SessionInspectorProps) {
  const [inputOpen, setInputOpen] = useState(false);
  const inputId = useId();
  const hasInput = Boolean(session.promptMd || session.attachments.length);

  return (
    <section aria-label="Session context" className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted">
        {repository ? (
          <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-2">
            <GitHubIcon className="size-3.5 shrink-0" />
            <a
              className="min-w-0 text-accent hover:underline [overflow-wrap:anywhere]"
              href={repository.htmlUrl}
              rel="noreferrer"
              target="_blank"
            >
              <span className="sr-only">Repository: </span>
              {repository.fullName}
            </a>
            {repository.defaultBranch ? (
              <span className="max-w-full rounded-[4px] bg-control-muted px-1.5 py-0.5 font-mono type-annotation [overflow-wrap:anywhere]">
                <span className="sr-only">Default branch: </span>
                {repository.defaultBranch}
              </span>
            ) : null}
          </span>
        ) : null}
        <SessionConnections
          linearIssueId={session.linearIssueId}
          linearIssueUrl={session.linearIssueUrl}
          pullRequests={session.pullRequests}
          quiet
        />
        <span className="inline-flex min-w-0 flex-wrap items-center gap-2">
          {creatorDisplayName ? (
            <>
              <span
                aria-hidden="true"
                className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-control-muted type-annotation text-foreground"
              >
                {creatorDisplayName.trim().charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <span className="sr-only">Created by </span>
                {creatorDisplayName}
              </span>
              <span aria-hidden="true">·</span>
            </>
          ) : null}
          <span>
            <span className="sr-only">Created </span>
            <TimeDisplay absoluteStyle="short" initialNow={initialNow} value={session.createdAt} />
          </span>
        </span>
        {hasInput ? (
          <button
            type="button"
            aria-controls={inputId}
            aria-expanded={inputOpen}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-[4px] text-xs text-muted hover:text-foreground focus-visible:outline-accent"
            onClick={() => setInputOpen((open) => !open)}
          >
            Original request
            <ChevronDownIcon
              className={cn(
                "size-3.5 transition-transform motion-reduce:transition-none",
                inputOpen && "rotate-180",
              )}
            />
          </button>
        ) : null}
      </div>
      {hasInput ? (
        <div id={inputId} hidden={!inputOpen}>
          {inputOpen ? (
            <div
              aria-label="Original request"
              className="mt-3 space-y-3 rounded-[6px] bg-control-muted p-4"
              role="region"
            >
              {session.promptMd ? (
                <p className="whitespace-pre-wrap text-sm leading-6 text-foreground [overflow-wrap:anywhere]">
                  {session.promptMd}
                </p>
              ) : null}
              {session.attachments.length > 0 ? (
                <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {session.attachments.map((attachment) => (
                    <li key={attachment.id} className="min-w-0">
                      <a
                        className="block overflow-hidden rounded-[4px] border border-border bg-sheet"
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
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
