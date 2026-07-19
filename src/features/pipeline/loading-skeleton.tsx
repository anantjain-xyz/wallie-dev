import type { CSSProperties } from "react";

import { SkeletonBlock } from "@/components/ui/skeleton";
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
      className={cn(
        "border-t border-border/70 pt-4 md:flex md:min-h-[calc(100vh-230px)] md:flex-col md:border-l md:border-t-0 md:px-3 md:pt-0 md:first:border-l-0 md:first:pl-0 md:last:pr-0",
        mobileVisible ? "flex" : "hidden md:flex",
      )}
    >
      <header className="sticky top-0 z-10 mb-3 border-b border-border/60 bg-canvas/95 pb-3">
        <div className="flex items-baseline justify-between gap-3">
          <SkeletonBlock className="h-4 w-24" />
          <SkeletonBlock className="h-3 w-5" />
        </div>
        <div className="mt-2">
          <SkeletonBlock className="h-3 w-8/12" />
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
    <div className="min-h-[calc(100svh-3.5rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] bg-canvas">
      <section aria-busy="true" aria-label="Loading pipeline" role="status">
        <div className="px-4 pb-4 pt-8 sm:px-8 sm:pt-10">
          <div className="mb-8 space-y-3 sm:mb-10">
            <SkeletonBlock className="h-8 w-32" />
            <SkeletonBlock className="h-4 w-full max-w-[520px]" />
            <SkeletonBlock className="h-4 w-8/12 max-w-[420px]" />
          </div>

          <div aria-hidden="true" className="mb-5 flex flex-wrap gap-3 border-y border-border py-3">
            <SkeletonBlock className="h-10 min-w-[14rem] flex-1" />
            <SkeletonBlock className="h-8 w-28" />
            <SkeletonBlock className="h-8 w-32" />
            <SkeletonBlock className="h-8 w-28" />
          </div>
        </div>

        <div aria-hidden="true" className="px-4 pb-4 md:hidden">
          <SkeletonBlock className="h-4 w-28" />
          <div className="mt-2 flex gap-2 overflow-hidden">
            <SkeletonBlock className="h-8 w-24 shrink-0" />
            <SkeletonBlock className="h-8 w-24 shrink-0" />
            <SkeletonBlock className="h-8 w-24 shrink-0" />
          </div>
        </div>

        <div
          aria-hidden="true"
          className="max-h-[calc(100svh-12.5rem)] overflow-auto overscroll-contain px-4 pb-10 sm:px-8 md:max-h-[calc(100svh-11rem)] md:px-6 md:pb-12"
        >
          <div
            className="pipeline-board grid w-full grid-cols-1 md:[grid-template-columns:repeat(var(--pipeline-stage-count),minmax(280px,1fr))]"
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
