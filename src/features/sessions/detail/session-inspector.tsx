"use client";

import Image from "next/image";
import { useId, useState } from "react";

import { ChevronDownIcon } from "@/components/shared/icons/chevron-down-icon";
import { TimeDisplay } from "@/components/shared/time-display";
import { WorkflowInspectionDisclosure } from "@/features/factory-workflows/workflow-inspection-disclosure";
import { SessionConnections } from "@/features/sessions/components/session-connections";
import type { SessionReviewSession } from "@/features/sessions/detail/data";
import type { WorkflowInspectionHeader } from "@/lib/factory-workflows/inspection-contracts";
import { cn } from "@/lib/utils";

import { SessionConversationPanel, useSessionConversation } from "./session-conversation";

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
  workflowInspection?: { header: WorkflowInspectionHeader; workspaceSlug: string };
};

/** Session-wide context stays above the stage workspace, including its original input. */
export function SessionInspector({
  creatorDisplayName,
  initialNow,
  repository,
  session,
  workflowInspection,
}: SessionInspectorProps) {
  const [inputOpen, setInputOpen] = useState(false);
  const inputId = useId();
  const conversationId = useId();
  const conversation = useSessionConversation(session.id);
  const hasInput = Boolean(session.promptMd || session.attachments.length);

  return (
    <section aria-label="Session context" className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 text-xs text-muted">
        <SessionConnections
          linearIssueId={session.linearIssueId}
          linearIssueUrl={session.linearIssueUrl}
          pullRequests={session.pullRequests}
          quiet
        />
        {hasInput ? (
          <button
            type="button"
            aria-controls={inputId}
            aria-expanded={inputOpen}
            className="inline-flex min-h-11 items-center gap-1 rounded-[4px] text-xs text-muted hover:text-foreground focus-visible:outline-accent sm:min-h-8"
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
        <button
          type="button"
          aria-controls={conversationId}
          aria-expanded={conversation.open}
          className="inline-flex min-h-11 items-center gap-1 rounded-[4px] text-xs text-muted hover:text-foreground focus-visible:outline-accent sm:min-h-8"
          onClick={conversation.toggle}
        >
          Conversation
          <ChevronDownIcon
            className={cn(
              "size-3.5 transition-transform motion-reduce:transition-none",
              conversation.open && "rotate-180",
            )}
          />
        </button>
        <details className="group/metadata min-w-0 open:basis-full">
          <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-[4px] hover:text-foreground focus-visible:outline-accent sm:min-h-8 [&::-webkit-details-marker]:hidden">
            Details
            <ChevronDownIcon className="size-3.5 group-open/metadata:rotate-180" />
          </summary>
          <dl className="flex flex-wrap gap-x-5 gap-y-2 rounded-md bg-control-muted p-3 [overflow-wrap:anywhere]">
            {repository ? (
              <div className="min-w-0">
                <dt>Repository</dt>
                <dd>
                  <a
                    className="text-accent hover:underline focus-visible:outline-accent"
                    href={repository.htmlUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {repository.fullName}
                  </a>
                </dd>
              </div>
            ) : null}
            {repository?.defaultBranch ? (
              <div className="min-w-0">
                <dt>Default branch</dt>
                <dd className="font-mono text-foreground">{repository.defaultBranch}</dd>
              </div>
            ) : null}
            {creatorDisplayName ? (
              <div className="min-w-0">
                <dt>Created by</dt>
                <dd className="text-foreground">{creatorDisplayName}</dd>
              </div>
            ) : null}
            <div className="min-w-0">
              <dt>Created</dt>
              <dd className="text-foreground">
                <TimeDisplay
                  absoluteStyle="short"
                  initialNow={initialNow}
                  value={session.createdAt}
                />
              </dd>
            </div>
          </dl>
        </details>
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
      <div id={conversationId} hidden={!conversation.open}>
        {conversation.open ? (
          <SessionConversationPanel
            initialNow={initialNow}
            loadOlder={conversation.loadOlder}
            retry={conversation.retry}
            view={conversation.view}
          />
        ) : null}
      </div>
      {workflowInspection ? (
        <WorkflowInspectionDisclosure {...workflowInspection} initialNow={initialNow} />
      ) : null}
    </section>
  );
}
