import { SkeletonBlock } from "@/components/ui/skeleton";
import { PageContainer, PageHeader } from "@/components/ui/page-shell";

const listRowTitleWidths = ["w-7/12", "w-5/12", "w-8/12", "w-6/12", "w-9/12", "w-4/12"];

function FilterChipSkeleton({ className = "w-20" }: { className?: string }) {
  return <SkeletonBlock className={`h-8 rounded-[6px] ${className}`} />;
}

function SessionRowSkeleton({ index }: { index: number }) {
  return (
    <li className="sessions-ledger-row">
      <div className="flex min-w-0 items-center gap-2">
        <SkeletonBlock className="h-3 w-8 shrink-0" />
        <SkeletonBlock className={`h-4 ${listRowTitleWidths[index % listRowTitleWidths.length]}`} />
      </div>
      {["Stage", "Status", "Repository", "Updated"].map((label) => (
        <div
          key={label}
          className={`sessions-ledger-cell sessions-ledger-cell-${label.toLowerCase()}`}
        >
          <span className="sessions-ledger-cell-label">{label}</span>
          <SkeletonBlock
            className={
              label === "Status" ? "h-6 w-24 max-w-full rounded-full" : "h-3 w-16 max-w-full"
            }
          />
        </div>
      ))}
      <SkeletonBlock className="h-7 w-7" />
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
      <section data-route-loading aria-busy="true" aria-label="Loading sessions" role="status">
        <PageHeader title="Sessions" />
        <div className="mb-6 border-y border-border py-2.5" aria-hidden="true">
          <div className="flex flex-wrap items-center gap-2 lg:gap-2.5">
            <SkeletonBlock className="h-8 w-full sm:max-w-[300px] lg:w-[300px]" />
            <FilterChipSkeleton className="w-[190px]" />
            <FilterChipSkeleton className="w-[136px]" />
            <FilterChipSkeleton className="w-[144px]" />
          </div>
          <div className="mt-2 min-h-4" />
        </div>
        <div aria-hidden="true" className="ui-sheet sessions-ledger overflow-hidden">
          <div className="sessions-ledger-header">
            {["Session", "Stage", "Status", "Repository", "Updated", ""].map((label) => (
              <div key={label}>{label}</div>
            ))}
          </div>
          <ul className="divide-y divide-border">
            {Array.from({ length: 3 }, (_, index) => (
              <SessionRowSkeleton key={index} index={index} />
            ))}
          </ul>
        </div>
      </section>
    </PageContainer>
  );
}

export function SessionDetailLoadingSkeleton() {
  return (
    <PageContainer className="pb-4">
      <section data-route-loading aria-busy="true" aria-label="Loading session" role="status">
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
