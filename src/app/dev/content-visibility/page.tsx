import { notFound } from "next/navigation";

import { isProductionDeploy } from "@/env/deploy";
import { cn } from "@/lib/utils";

const BENCHMARK_ROW_COUNT = 120;

export default async function ContentVisibilityBenchmarkPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  if (isProductionDeploy()) notFound();

  const { mode } = await searchParams;
  const isBaseline = mode === "baseline";

  return (
    <main
      id="main-content"
      className={cn(
        "mx-auto max-w-[1080px] px-4 py-8 sm:px-8",
        isBaseline && "content-visibility-benchmark-disabled",
      )}
      data-benchmark-mode={isBaseline ? "baseline" : "contained"}
    >
      <h1 className="type-page-title">Content visibility benchmark</h1>
      <p className="mt-2 type-body text-muted">
        Fixed 120-row rendering fixture for browser performance traces.
      </p>

      <ul className="ui-sheet mt-8 divide-y divide-border overflow-hidden">
        {Array.from({ length: BENCHMARK_ROW_COUNT }, (_, index) => (
          <li
            className="session-list-row flex flex-col gap-3 px-4 py-4 sm:px-5 md:flex-row md:items-center"
            key={index}
          >
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <span className="font-mono type-annotation text-muted">#{index + 1}</span>
                <span className="truncate text-sm font-medium text-foreground">
                  Seeded performance session {index + 1}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 type-annotation text-muted">
                <span>Build</span>
                <span>·</span>
                <span>Awaiting review</span>
                <span>·</span>
                <span>updated 2 minutes ago</span>
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              <span className="rounded-full border border-border px-2 py-1 type-annotation">
                Linear
              </span>
              <span className="rounded-full border border-border px-2 py-1 type-annotation">
                PR #325
              </span>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
