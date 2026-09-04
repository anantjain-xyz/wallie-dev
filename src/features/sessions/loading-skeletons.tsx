import { SkeletonBlock } from "@/components/ui/skeleton";
import { PageContainer, PageHeader } from "@/components/ui/page-shell";

const listRowTitleWidths = ["w-7/12", "w-5/12", "w-8/12", "w-6/12", "w-9/12", "w-4/12"];

function FilterChipSkeleton({ className = "w-20" }: { className?: string }) {
  return <SkeletonBlock className={`h-8 rounded-[6px] ${className}`} />;
}

function SessionRowSkeleton({ index }: { index: number }) {
  const titleWidth = listRowTitleWidths[index % listRowTitleWidths.length];

  return (
    <li className="flex flex-col gap-3 px-4 py-4 sm:px-5 md:flex-row md:items-center">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <SkeletonBlock className="h-3 w-8 shrink-0" />
          <SkeletonBlock className={`h-4 min-w-0 ${titleWidth}`} />
          <SkeletonBlock className="h-7 w-7 shrink-0 rounded-[6px]" />
          <SkeletonBlock className="h-7 w-7 shrink-0 rounded-[6px]" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SkeletonBlock className="h-3 w-16" />
          <SkeletonBlock className="h-3 w-20" />
          <SkeletonBlock className="h-3 w-24" />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <SkeletonBlock className="h-7 w-20 rounded-full" />
        <SkeletonBlock className="h-7 w-16 rounded-full" />
      </div>
    </li>
  );
}

function StageRailSkeleton() {
  return (
    <div className="mb-4 flex flex-wrap gap-1.5 border-b border-border pb-3" aria-hidden="true">
      {Array.from({ length: 3 }, (_, index) => (
        <SkeletonBlock key={index} className="h-10 w-28" />
      ))}
    </div>
  );
}

function ArtifactPanelSkeleton() {
  return (
    <section className="ui-sheet flex min-h-0 flex-col lg:rounded-r-none lg:border-r-0">
      <div className="space-y-2 border-b border-border px-4 py-3">
        <SkeletonBlock className="h-4 w-40 max-w-full" />
        <SkeletonBlock className="h-3 w-56 max-w-full" />
      </div>
      <div className="space-y-3 p-4">
        <SkeletonBlock className="h-4 w-11/12" />
        <SkeletonBlock className="h-4 w-full" />
        <SkeletonBlock className="h-4 w-10/12" />
        <SkeletonBlock className="mt-5 h-36 w-full" />
        <SkeletonBlock className="h-4 w-8/12" />
      </div>
    </section>
  );
}

export function SessionsListLoadingSkeleton() {
  return (
    <PageContainer>
      <section aria-busy="true" aria-label="Loading sessions" role="status">
        <SkeletonBlock className="mb-8 h-8 w-36 sm:mb-10" />

        <div className="mb-6 flex flex-wrap items-center gap-3" aria-hidden="true">
          <SkeletonBlock className="h-10 w-full flex-none sm:min-w-[220px] sm:max-w-md sm:flex-1" />
          <div className="flex flex-wrap items-center gap-1.5">
            <FilterChipSkeleton className="w-14" />
            <FilterChipSkeleton className="w-20" />
            <FilterChipSkeleton className="w-20" />
            <FilterChipSkeleton className="w-24" />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <FilterChipSkeleton className="w-24" />
            <FilterChipSkeleton className="w-16" />
            <FilterChipSkeleton className="w-16" />
            <FilterChipSkeleton className="w-20" />
          </div>
        </div>

        <ul aria-hidden="true" className="ui-sheet divide-y divide-border overflow-hidden">
          {Array.from({ length: 3 }, (_, index) => (
            <SessionRowSkeleton key={index} index={index} />
          ))}
        </ul>
      </section>
    </PageContainer>
  );
}

export function SessionDetailLoadingSkeleton() {
  return (
    <PageContainer className="pb-4">
      <section aria-busy="true" aria-label="Loading session" role="status">
        <span className="sr-only">Loading session…</span>
        <PageHeader
          actionsRightOnDesktop
          eyebrow={<SkeletonBlock className="h-4 w-32" />}
          titleAsChild
          title={<SkeletonBlock className="h-8 w-full max-w-[520px]" />}
          actions={<SkeletonBlock className="h-9 w-24" />}
        />

        <StageRailSkeleton />

        <div
          className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(18rem,3fr)] lg:gap-0 lg:gap-x-0"
          aria-hidden="true"
        >
          <ArtifactPanelSkeleton />
          <aside className="ui-sheet space-y-5 p-4 lg:rounded-l-none">
            <SkeletonBlock className="h-4 w-20" />
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="flex items-center justify-between gap-4">
                <SkeletonBlock className="h-3 w-16" />
                <SkeletonBlock className="h-3 w-28" />
              </div>
            ))}
            <SkeletonBlock className="h-8 w-full" />
          </aside>
        </div>

        <section className="ui-sheet mt-6" aria-hidden="true">
          <div className="space-y-2 border-b border-border px-4 py-3">
            <SkeletonBlock className="h-4 w-16" />
            <SkeletonBlock className="h-3 w-64 max-w-full" />
          </div>
          <div className="space-y-3 p-4">
            <SkeletonBlock className="h-12 w-full" />
            <SkeletonBlock className="h-12 w-full" />
          </div>
        </section>
      </section>
    </PageContainer>
  );
}
