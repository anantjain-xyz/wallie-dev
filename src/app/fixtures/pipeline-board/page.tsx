import { notFound } from "next/navigation";

import { PipelineBoardFixture } from "@/features/pipeline/pipeline-board-fixture";

export default async function PipelineBoardFixturePage({
  searchParams,
}: {
  searchParams: Promise<{ stages?: string; theme?: string }>;
}) {
  if (process.env.NODE_ENV !== "development") notFound();

  const { stages, theme } = await searchParams;
  const stageCount = stages === "5" || stages === "7" ? Number(stages) : 3;

  return (
    <PipelineBoardFixture
      initialTheme={theme === "dark" ? "dark" : "light"}
      key={`${theme ?? "light"}:${stageCount}`}
      stageCount={stageCount as 3 | 5 | 7}
    />
  );
}
