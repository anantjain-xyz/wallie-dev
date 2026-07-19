import { notFound } from "next/navigation";

import { PipelineBoardFixture } from "@/features/pipeline/pipeline-board-fixture";
import { PipelineLoadingSkeleton } from "@/features/pipeline/loading-skeleton";

export default async function PipelineBoardFixturePage({
  searchParams,
}: {
  searchParams: Promise<{ stages?: string; state?: string; theme?: string }>;
}) {
  if (process.env.NODE_ENV !== "development") notFound();

  const { stages, state, theme } = await searchParams;
  const stageCount = stages === "5" || stages === "7" ? Number(stages) : 3;

  if (state === "loading") {
    return <PipelineLoadingSkeleton stageCount={stageCount} />;
  }

  return (
    <PipelineBoardFixture
      initialTheme={theme === "dark" ? "dark" : "light"}
      key={`${theme ?? "light"}:${stageCount}`}
      stageCount={stageCount as 3 | 5 | 7}
    />
  );
}
