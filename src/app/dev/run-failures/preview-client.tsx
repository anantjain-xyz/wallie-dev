"use client";

import { useState } from "react";

import { SessionRunHistory } from "@/features/sessions/detail/session-activity-presentation";
import { WallieRunCard } from "@/features/wallie/run-activity";
import type { WallieRun } from "@/features/wallie/types";

const noAction = async () => {};

export function RunFailuresPreview({
  runs,
  initialNow,
  titles,
}: {
  runs: WallieRun[];
  initialNow: string;
  titles: Record<string, string>;
}) {
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  return (
    <main id="main-content" className="mx-auto w-full max-w-4xl space-y-6 p-4 sm:p-8">
      <div>
        <p className="type-annotation text-muted">Session #42 · Build</p>
        <h1 className="mt-1 text-2xl font-semibold">Run failure explanations</h1>
        <p className="mt-2 text-sm text-muted">
          Persisted run fixtures. Recovery actions are disabled in this preview.
        </p>
      </div>
      <SessionRunHistory count={runs.length}>
        <div className="ui-sheet divide-y divide-border px-4 sm:px-5">
          {runs.map((run) => (
            <section
              key={run.id}
              aria-label={titles[run.id]}
              className="min-w-0 py-2"
              data-failure-scenario={run.id}
            >
              <h3 className="pt-3 text-xs font-semibold text-muted">{titles[run.id]}</h3>
              <WallieRunCard
                actionPending={false}
                branchName={run.branchName}
                cancelLocked
                connectionState="live"
                isExpanded={expandedIds.has(run.id)}
                messagesLoaded
                messagesLoadFailed={false}
                nowMs={Date.parse(initialNow)}
                onCancel={noAction}
                onRetry={noAction}
                onToggle={(runId) =>
                  setExpandedIds((current) => {
                    const next = new Set(current);
                    if (next.has(runId)) next.delete(runId);
                    else next.add(runId);
                    return next;
                  })
                }
                renderNow={initialNow}
                retryLocked
                run={run}
                stallTimeoutMs={900_000}
              />
            </section>
          ))}
        </div>
      </SessionRunHistory>
    </main>
  );
}
