import type { CSSProperties } from "react";

import { PageHeader } from "@/components/ui/page-shell";
import { SkeletonBlock } from "@/components/ui/skeleton";
import { FILTER_CONTROL_CLASS } from "@/components/ui/filter-controls";
import { pipelineLayout } from "@/features/pipeline/layout";
import { cn } from "@/lib/utils";

const LANE_MIN_WIDTH_PX = 280;
const cardTitleWidths = ["w-10/12", "w-8/12", "w-11/12"];

function PipelineCardSkeleton({ index }: { index: number }) {
  return (
    <article className="ui-sheet border-border/80 p-3">
      <div className="space-y-2">
        <SkeletonBlock className={`h-4 ${cardTitleWidths[index % cardTitleWidths.length]}`} />
        <SkeletonBlock className="h-5 w-28 rounded-full" />
        <SkeletonBlock className="h-3 w-7/12" />
        <SkeletonBlock className="h-3 w-5/12" />
      </div>
    </article>
  );
}

function PipelineLaneSkeleton({ index, mobileVisible }: { index: number; mobileVisible: boolean }) {
  return (
    <section
      className={cn(pipelineLayout.lane, mobileVisible ? "flex" : "hidden pipeline-wide:flex")}
    >
      <header className={pipelineLayout.laneHeader}>
        <div className="flex items-baseline justify-between gap-3">
          <SkeletonBlock className="h-[23px] w-24" />
          <SkeletonBlock className="h-3 w-5" />
        </div>
        <div className={pipelineLayout.laneSummary}>
          <SkeletonBlock className="h-4 w-8/12" />
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-2">
        <PipelineCardSkeleton index={index} />
      </div>
    </section>
  );
}

export function PipelineLoadingSkeleton({
  showFactorySelector = true,
  stageCount = 3,
}: {
  showFactorySelector?: boolean;
  stageCount?: number;
}) {
  const lanes = Math.max(1, stageCount);

  return (
    <div className={pipelineLayout.page}>
      <section
        data-route-loading
        aria-busy="true"
        aria-label="Loading pipeline"
        className="flex min-h-0 flex-1 flex-col"
        role="status"
      >
        <div className={pipelineLayout.controlsArea}>
          <div aria-hidden="true">
            <PageHeader
              actions={
                showFactorySelector ? (
                  <SkeletonBlock className={cn(FILTER_CONTROL_CLASS, "w-36 pointer-coarse:h-11")} />
                ) : undefined
              }
              actionsRightOnDesktop
              className={pipelineLayout.header}
              title={
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <SkeletonBlock className="h-8 w-28" />
                  <div className="flex min-h-11 items-center sm:min-h-9 pointer-coarse:min-h-11">
                    <SkeletonBlock className="h-8 w-[108px]" />
                  </div>
                  <div className="flex h-[1.375rem] items-center">
                    <SkeletonBlock className="h-4 w-48" />
                  </div>
                </div>
              }
              titleAsChild
            />
          </div>

          <div aria-hidden="true" className={pipelineLayout.controls}>
            <SkeletonBlock className="h-11 min-w-0 flex-1 basis-full sm:basis-60 md:h-9 pointer-coarse:h-11" />
            <SkeletonBlock className="h-11 w-40 md:h-9 pointer-coarse:h-11" />
          </div>
        </div>

        <div aria-hidden="true" className={pipelineLayout.stageTabs}>
          <div className="flex gap-2 overflow-hidden pb-1">
            {Array.from({ length: lanes }, (_, index) => (
              <SkeletonBlock key={index} className="h-11 w-24 shrink-0" />
            ))}
          </div>
        </div>

        <div aria-hidden="true" className={pipelineLayout.board}>
          <div
            className={pipelineLayout.grid}
            style={
              {
                "--pipeline-lane-min": `${LANE_MIN_WIDTH_PX}px`,
                "--pipeline-stage-count": lanes,
              } as CSSProperties
            }
          >
            {Array.from({ length: lanes }, (_, index) => (
              <PipelineLaneSkeleton key={index} index={index} mobileVisible={index === 0} />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
