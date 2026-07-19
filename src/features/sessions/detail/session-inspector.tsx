"use client";

import { type ReactNode, useId, useState } from "react";

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
  activity: ReactNode;
  creatorDisplayName: string | null;
  initialNow: string;
  repository: SessionInspectorRepository | null;
  session: SessionReviewSession;
};

type InspectorTab = "context" | "activity";

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
  activity,
  creatorDisplayName,
  initialNow,
  repository,
  session,
}: SessionInspectorProps) {
  const [tab, setTab] = useState<InspectorTab>("context");
  const [runInputOpen, setRunInputOpen] = useState(false);
  const runInputId = useId();
  const contextPanelId = useId();
  const activityPanelId = useId();
  const hasConnections =
    !!session.linearIssueUrl ||
    session.pullRequests.some((pullRequest) => pullRequest.pullRequestUrl);

  return (
    <section className="flex min-h-0 flex-col border-border lg:border-l lg:pl-5">
      <div aria-label="Inspector" className="mb-3 flex gap-1" role="tablist">
        {(
          [
            { id: "context" as const, label: "Context", panelId: contextPanelId },
            { id: "activity" as const, label: "Activity", panelId: activityPanelId },
          ] as const
        ).map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-controls={entry.panelId}
            aria-selected={tab === entry.id}
            id={`${entry.id}-tab`}
            tabIndex={tab === entry.id ? 0 : -1}
            className={cn(
              "rounded-[4px] px-2.5 py-1 text-xs font-medium",
              tab === entry.id
                ? "bg-control-muted text-foreground"
                : "text-muted hover:text-foreground",
            )}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === "context" ? (
        <div
          aria-labelledby="context-tab"
          className="min-h-0 flex-1 overflow-y-auto"
          id={contextPanelId}
          role="tabpanel"
        >
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
                  {creatorDisplayName}
                </span>
              ) : (
                <span className="text-muted">Unknown</span>
              )}
            </ContextRow>

            <ContextRow label="Created">
              <TimeDisplay
                absoluteStyle="short"
                initialNow={initialNow}
                value={session.createdAt}
              />
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
              <pre
                id={runInputId}
                className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[4px] border border-border bg-canvas p-3 text-xs leading-5 text-foreground"
              >
                {session.promptMd || "No run input recorded."}
              </pre>
            ) : (
              <p className="mt-1 type-annotation text-muted">
                Collapsed — expand to inspect the prompt Wallie used.
              </p>
            )}
          </div>
        </div>
      ) : (
        <div
          aria-labelledby="activity-tab"
          className="min-h-0 flex-1 overflow-y-auto"
          id={activityPanelId}
          role="tabpanel"
        >
          {activity}
        </div>
      )}
    </section>
  );
}
