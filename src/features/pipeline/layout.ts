import { FILTER_BAR_CLASS } from "@/components/ui/filter-controls";

/** Shared geometry keeps the route fallback and loaded board in the same scroll mode. */
export const pipelineLayout = {
  page: "flex min-h-[calc(100svh-6.75rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] flex-col bg-sheet lg:min-h-[calc(100svh-3rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] pipeline-wide:h-[calc(100svh-6.75rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] pipeline-wide:min-h-0 pipeline-wide:lg:h-[calc(100svh-3rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))]",
  emptyPage: "mx-auto w-full max-w-[1080px] px-4 pb-24 pt-8 sm:px-8 sm:pt-10",
  controlsArea: "shrink-0 px-4 py-3 pipeline-wide:px-8 pipeline-wide:pb-4 pipeline-wide:pt-10",
  controls: `${FILTER_BAR_CLASS} pipeline-wide:mb-5`,
  stageTabs: "shrink-0 px-4 pb-2 pipeline-wide:hidden",
  board:
    "min-h-0 flex-1 px-4 pb-10 pipeline-wide:overflow-auto pipeline-wide:overscroll-contain pipeline-wide:px-6 pipeline-wide:pb-12",
  grid: "pipeline-board grid w-full grid-cols-1 pipeline-wide:[grid-template-columns:repeat(var(--pipeline-stage-count),minmax(280px,1fr))]",
  lane: "w-full flex-col border-t border-border/70 pt-3 pipeline-wide:min-h-[calc(100vh-230px)] pipeline-wide:border-l pipeline-wide:border-t-0 pipeline-wide:px-3 pipeline-wide:pt-0 pipeline-wide:first:border-l-0 pipeline-wide:first:pl-0 pipeline-wide:last:pr-0",
  laneHeader:
    "z-10 -mx-1 mb-3 border-b border-border/60 bg-sheet/95 px-1 pb-3 backdrop-blur-sm pipeline-wide:sticky pipeline-wide:top-0",
} as const;
