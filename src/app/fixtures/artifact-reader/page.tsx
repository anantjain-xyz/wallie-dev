import { notFound } from "next/navigation";

import { isProductionDeploy } from "@/env/deploy";
import { ArtifactReaderFixture } from "@/features/sessions/detail/artifact-reader-fixture";

export default async function ArtifactReaderFixturePage({
  searchParams,
}: {
  searchParams: Promise<{ theme?: string; view?: string; viewport?: string }>;
}) {
  if (isProductionDeploy()) notFound();

  const { theme, view, viewport } = await searchParams;
  const initialView =
    view === "raw" ||
    view === "versions" ||
    view === "empty" ||
    view === "failed" ||
    view === "hostile" ||
    view === "plain"
      ? view
      : "rendered";

  return (
    <ArtifactReaderFixture
      displayMode={viewport === "mobile" ? "mobile" : "desktop"}
      initialTheme={theme === "dark" ? "dark" : "light"}
      initialView={initialView}
      key={`${theme ?? "light"}:${viewport ?? "desktop"}:${initialView}`}
    />
  );
}
