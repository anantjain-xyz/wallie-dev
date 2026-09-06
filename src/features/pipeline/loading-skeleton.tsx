import type { CSSProperties } from "react";

import { SkeletonBlock } from "@/components/ui/skeleton";
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
        <div className="mt-1">
          <SkeletonBlock className="h-4 w-8/12" />
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-2">
        <PipelineCardSkeleton index={index} />
      </div>
    </section>
  );
}

export function PipelineLoadingSkeleton({ stageCount = 3 }: { stageCount?: number }) {
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
          <div className="hidden space-y-3 pipeline-wide:mb-10 pipeline-wide:block">
            <SkeletonBlock className="h-8 w-32" />
            <SkeletonBlock className="h-4 w-full max-w-[520px]" />
            <SkeletonBlock className="h-4 w-8/12 max-w-[420px]" />
          </div>

          <div aria-hidden="true" className={pipelineLayout.controls}>
            <SkeletonBlock className="h-[46px] min-w-0 pipeline-wide:h-10 pipeline-wide:min-w-[14rem] pipeline-wide:flex-1" />
            <SkeletonBlock className="h-[46px] min-[380px]:w-48 pipeline-wide:hidden" />
            <div className="hidden gap-3 pipeline-wide:flex">
              <SkeletonBlock className="h-8 w-28" />
              <SkeletonBlock className="h-8 w-32" />
              <SkeletonBlock className="h-8 w-28" />
            </div>
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
