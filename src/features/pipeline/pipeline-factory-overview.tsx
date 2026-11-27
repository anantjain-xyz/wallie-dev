import Link from "next/link";
import type { ReactNode } from "react";

import { withFactoryQuery } from "@/features/factories/factory-selection";
import { pipelineLaneKey } from "@/features/pipeline/model";
import type { PipelineBoardLane } from "@/features/pipeline/types";
import type { SessionBrowseFactory } from "@/features/sessions/browse-pipeline-owners";
import { workspaceBasePath } from "@/lib/routes";

export function PipelineFactoryOverview({
  busy,
  factories,
  filtersActive,
  lanes,
  renderStage,
  workspaceSlug,
}: {
  busy: boolean;
  factories: readonly SessionBrowseFactory[];
  filtersActive: boolean;
  lanes: readonly PipelineBoardLane[];
  renderStage: (lane: PipelineBoardLane) => ReactNode;
  workspaceSlug: string;
}) {
  const groups = new Map<string, { factory: SessionBrowseFactory; lanes: PipelineBoardLane[] }>();
  for (const factory of factories) groups.set(factory.id, { factory, lanes: [] });
  for (const lane of lanes) {
    if (!lane.factory) continue;
    const group = groups.get(lane.factory.id) ?? { factory: lane.factory, lanes: [] };
    group.factory = lane.factory;
    group.lanes.push(lane);
    groups.set(lane.factory.id, group);
  }
  const visibleGroups = [...groups.values()].filter(
    (group) => !filtersActive || group.lanes.some((lane) => lane.totalCount > 0),
  );
  return (
    <div aria-busy={busy} aria-label="All factories overview" className="space-y-6" role="region">
      {visibleGroups.length === 0 ? (
        <p className="ui-sheet border-dashed px-6 py-12 text-center text-sm text-muted">
          {filtersActive ? "No matching sessions" : "No factories available"}
        </p>
      ) : null}
      {visibleGroups.map(({ factory, lanes }) => {
        const headingId = `overview-factory-${factory.id}`;
        const stages = lanes.filter((lane) => lane.totalCount > 0);
        const showPipeline = new Set(lanes.map((lane) => lane.pipeline.id)).size > 1;
        return (
          <section aria-labelledby={headingId} key={factory.id}>
            <header className="mb-2 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h2
                  className="break-words text-base font-semibold leading-snug text-foreground"
                  id={headingId}
                >
                  {factory.name}
                </h2>
                {factory.status === "archived" ? (
                  <span className="text-xs text-muted">Archived</span>
                ) : null}
              </div>
              <Link
                aria-label={`Open board for ${factory.name}`}
                className="ui-button min-h-11 shrink-0 px-3 md:min-h-9"
                href={withFactoryQuery(workspaceBasePath(workspaceSlug), factory.id)}
              >
                Open board
              </Link>
            </header>
            <div className="ui-sheet divide-y divide-border">
              {stages.length === 0 ? (
                <p className="px-4 py-3 text-sm text-muted">No active sessions</p>
              ) : (
                stages.map((lane) => {
                  const key = pipelineLaneKey(lane);
                  const stageHeadingId = `overview-stage-${key}`;
                  const pipelineLabelId = `${stageHeadingId}-pipeline`;
                  return (
                    <section
                      aria-labelledby={
                        showPipeline ? `${stageHeadingId} ${pipelineLabelId}` : stageHeadingId
                      }
                      data-pipeline-lane={key}
                      key={key}
                    >
                      <div className="flex items-baseline justify-between gap-3 border-b border-border/70 px-4 py-2">
                        <div className="min-w-0 break-words">
                          <h3
                            className="inline text-[13px] font-semibold text-foreground"
                            id={stageHeadingId}
                          >
                            {lane.name}
                          </h3>
                          {showPipeline ? (
                            <span className="ml-2 text-xs text-muted" id={pipelineLabelId}>
                              {lane.pipeline.name}
                            </span>
                          ) : null}
                        </div>
                        <span className="shrink-0 font-mono text-xs tabular-nums text-muted">
                          {lane.totalCount}
                        </span>
                      </div>
                      {renderStage(lane)}
                    </section>
                  );
                })
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
