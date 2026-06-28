import { SkeletonBlock } from "@/components/ui/skeleton";

const anchorGroupSizes = [5, 1, 3, 3];

const sectionSkeletons = [
  { rows: 2 },
  { rows: 3 },
  { rows: 3 },
  { rows: 2 },
  { rows: 4 },
  { rows: 3 },
  { rows: 4 },
  { rows: 2 },
  { rows: 3 },
  { rows: 2, withAvatar: true },
  { rows: 3 },
  { rows: 1, tone: "danger" },
] satisfies { rows: number; tone?: "danger"; withAvatar?: boolean }[];

function SettingsAnchorSkeleton() {
  return (
    <div className="hidden lg:block" aria-hidden="true">
      <div className="sticky top-6 flex flex-col gap-5">
        {anchorGroupSizes.map((anchorCount, groupIndex) => (
          <div key={groupIndex}>
            <SkeletonBlock className="mb-2 h-3 w-20" />
            <div className="flex flex-col gap-2">
              {Array.from({ length: anchorCount }, (_, anchorIndex) => (
                <SkeletonBlock
                  key={anchorIndex}
                  className={`h-7 ${anchorIndex === 0 ? "w-32" : "w-24"}`}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingsSectionSkeleton({
  rows,
  tone,
  withAvatar = false,
}: {
  rows: number;
  tone?: "danger";
  withAvatar?: boolean;
}) {
  return (
    <section className="scroll-mt-8" aria-hidden="true">
      <header className="settings-section-header mb-6">
        <div className="min-w-0 flex-1 space-y-2">
          <SkeletonBlock className="h-5 w-40 max-w-full" />
          <SkeletonBlock className="h-4 w-full max-w-lg" />
        </div>
        <SkeletonBlock className="h-7 w-24 shrink-0 rounded-full" />
      </header>

      <div
        className={`rounded-[10px] border bg-surface ${
          tone === "danger" ? "border-danger/20" : "border-border"
        }`}
      >
        <div className="flex flex-col gap-5 p-5 sm:p-6">
          {withAvatar ? (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <SkeletonBlock className="h-16 w-16 shrink-0 rounded-[10px]" />
              <div className="min-w-0 flex-1 space-y-2">
                <SkeletonBlock className="h-5 w-52 max-w-full" />
                <SkeletonBlock className="h-4 w-full max-w-md" />
              </div>
            </div>
          ) : null}

          <div className="space-y-3">
            {Array.from({ length: rows }, (_, rowIndex) => (
              <div
                key={rowIndex}
                className="flex flex-col gap-3 border-t border-border pt-4 first:border-t-0 first:pt-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 flex-1 space-y-2">
                  <SkeletonBlock className="h-4 w-48 max-w-full" />
                  <SkeletonBlock
                    className={`h-3.5 max-w-full ${rowIndex % 2 === 0 ? "w-full" : "w-2/3"}`}
                  />
                </div>
                <SkeletonBlock className="h-9 w-28 shrink-0" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export function SettingsLoadingSkeleton() {
  return (
    <div className="min-h-full">
      <section aria-busy="true" aria-label="Loading settings" role="status">
        <div className="mx-auto max-w-[1080px] px-4 pb-24 pt-8 sm:px-8 sm:pt-10">
          <header className="mb-8 sm:mb-10">
            <div className="min-w-0 space-y-3">
              <SkeletonBlock className="h-8 w-36" />
              <SkeletonBlock className="h-4 w-full max-w-2xl" />
            </div>
          </header>

          <div className="grid grid-cols-1 gap-12 lg:grid-cols-[180px_minmax(0,1fr)]">
            <SettingsAnchorSkeleton />

            <div className="min-w-0 space-y-16">
              {sectionSkeletons.map((section, index) => (
                <SettingsSectionSkeleton
                  key={index}
                  rows={section.rows}
                  tone={section.tone}
                  withAvatar={section.withAvatar}
                />
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
