import { SkeletonBlock } from "@/components/ui/skeleton";

const laneCardCounts = [3, 2, 3];
const cardTitleWidths = ["w-10/12", "w-8/12", "w-11/12"];

function PipelineCardSkeleton({ index }: { index: number }) {
  return (
    <article className="ui-sheet border-border/80 p-3">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <SkeletonBlock className={`h-4 ${cardTitleWidths[index % cardTitleWidths.length]}`} />
          <SkeletonBlock className="h-4 w-7/12" />
        </div>
        <SkeletonBlock className="mt-[3px] h-4 w-16 shrink-0 rounded-full" />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <SkeletonBlock className="h-4 w-16 rounded-full" />
        <SkeletonBlock className="h-3 w-20" />
      </div>
    </article>
  );
}

function PipelineLaneSkeleton({ index }: { index: number }) {
  return (
    <section className="border-t border-border/70 pt-4 first:border-t-0 md:flex md:min-h-[calc(100vh-230px)] md:w-[260px] md:shrink-0 md:flex-col md:border-l md:border-t-0 md:px-3 md:pt-0 md:first:border-l-0 md:first:pl-0 md:last:pr-0">
      <header className="mb-3 md:mb-0 md:pb-3">
        <div className="flex items-baseline justify-between gap-3">
          <SkeletonBlock className="h-4 w-24" />
          <SkeletonBlock className="h-3 w-5" />
        </div>
        <div className="mt-2 space-y-1.5">
          <SkeletonBlock className="h-3 w-full" />
          <SkeletonBlock className="h-3 w-8/12" />
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-2">
        {Array.from({ length: laneCardCounts[index % laneCardCounts.length] }, (_, cardIndex) => (
          <PipelineCardSkeleton key={cardIndex} index={cardIndex} />
        ))}
      </div>
    </section>
  );
}

export function PipelineLoadingSkeleton() {
  return (
    <div className="min-h-[calc(100svh-3.5rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] bg-canvas">
      <section aria-busy="true" aria-label="Loading pipeline" role="status">
        <header className="px-4 pb-8 pt-10 sm:px-8 md:pb-10 md:pt-14">
          <div className="mx-auto w-full md:max-w-[780px]">
            <div className="max-w-2xl space-y-3">
              <SkeletonBlock className="h-8 w-32" />
              <SkeletonBlock className="h-4 w-full max-w-[520px]" />
              <SkeletonBlock className="h-4 w-8/12 max-w-[420px]" />
            </div>
          </div>
        </header>

        <div aria-hidden="true" className="px-4 pb-10 sm:px-8 md:hidden">
          <div className="space-y-6">
            {Array.from({ length: 3 }, (_, index) => (
              <PipelineLaneSkeleton key={index} index={index} />
            ))}
          </div>
        </div>

        <div
          aria-hidden="true"
          className="hidden overflow-x-auto overscroll-x-contain px-6 pb-12 sm:px-8 md:block"
        >
          <div className="mx-auto flex w-[780px]">
            {Array.from({ length: 3 }, (_, index) => (
              <PipelineLaneSkeleton key={index} index={index} />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
