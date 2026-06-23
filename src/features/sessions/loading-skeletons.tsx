import { SkeletonBlock } from "@/components/ui/skeleton";
import { PageContainer } from "@/components/ui/page-shell";

const listRowTitleWidths = ["w-7/12", "w-5/12", "w-8/12", "w-6/12", "w-9/12", "w-4/12"];

function FilterChipSkeleton({ className = "w-20" }: { className?: string }) {
  return <SkeletonBlock className={`h-8 rounded-full ${className}`} />;
}

function SessionRowSkeleton({ index }: { index: number }) {
  const titleWidth = listRowTitleWidths[index % listRowTitleWidths.length];

  return (
    <li className="flex flex-col gap-3 px-4 py-4 sm:px-5 md:flex-row md:items-center">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <SkeletonBlock className="h-3 w-8 shrink-0" />
          <SkeletonBlock className={`h-4 min-w-0 ${titleWidth}`} />
          <SkeletonBlock className="h-7 w-7 shrink-0 rounded-full" />
          <SkeletonBlock className="h-7 w-7 shrink-0 rounded-full" />
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
    <div className="grid gap-3 sm:grid-cols-3" aria-hidden="true">
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="flex min-w-0 items-center gap-2">
          <SkeletonBlock className="h-6 w-6 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <SkeletonBlock className="h-3 w-24 max-w-full" />
            <SkeletonBlock className="h-2 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ArtifactPanelSkeleton() {
  return (
    <section className="rounded-[8px] border border-border bg-surface">
      <div className="flex flex-col gap-2 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-2">
          <SkeletonBlock className="h-4 w-40" />
          <SkeletonBlock className="h-3 w-56 max-w-full" />
        </div>
        <SkeletonBlock className="h-6 w-28 shrink-0 rounded-full" />
      </div>
      <div className="space-y-3 p-4">
        <SkeletonBlock className="h-4 w-11/12" />
        <SkeletonBlock className="h-4 w-full" />
        <SkeletonBlock className="h-4 w-10/12" />
        <SkeletonBlock className="mt-5 h-28 w-full" />
      </div>
      <div className="flex justify-end gap-2 border-t border-border bg-surface-muted p-4">
        <SkeletonBlock className="h-9 w-40" />
        <SkeletonBlock className="h-9 w-36" />
      </div>
    </section>
  );
}

function CompactPanelSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <section className="rounded-[8px] border border-border bg-surface p-4">
      <SkeletonBlock className="h-3 w-24" />
      <div className="mt-3 space-y-2">
        {Array.from({ length: lines }, (_, index) => (
          <SkeletonBlock
            key={index}
            className={index === lines - 1 ? "h-3 w-7/12" : "h-3 w-full"}
          />
        ))}
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

        <ul
          aria-hidden="true"
          className="divide-y divide-border overflow-hidden rounded-[10px] border border-border bg-surface"
        >
          {Array.from({ length: 7 }, (_, index) => (
            <SessionRowSkeleton key={index} index={index} />
          ))}
        </ul>
      </section>
    </PageContainer>
  );
}

export function SessionDetailLoadingSkeleton() {
  return (
    <PageContainer>
      <section aria-busy="true" aria-label="Loading session" role="status">
        <header className="mb-8 flex flex-wrap items-start justify-between gap-x-6 gap-y-3 sm:mb-10">
          <div className="min-w-0 flex-1 space-y-3">
            <SkeletonBlock className="h-3 w-32" />
            <div className="flex min-w-0 items-center gap-2">
              <SkeletonBlock className="h-8 w-8/12 max-w-[520px]" />
              <SkeletonBlock className="h-8 w-8 shrink-0 rounded-full" />
            </div>
          </div>
          <SkeletonBlock className="h-9 w-24 shrink-0" />
        </header>

        <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1.5" aria-hidden="true">
          <SkeletonBlock className="h-4 w-28" />
          <SkeletonBlock className="h-4 w-32" />
          <SkeletonBlock className="h-4 w-24" />
          <SkeletonBlock className="h-4 w-28" />
        </div>

        <div className="mb-6 rounded-[10px] border border-border bg-surface px-5 py-4">
          <StageRailSkeleton />
        </div>

        <div className="flex flex-col gap-6">
          <ArtifactPanelSkeleton />
          <CompactPanelSkeleton lines={4} />
          <CompactPanelSkeleton lines={3} />
        </div>
      </section>
    </PageContainer>
  );
}
