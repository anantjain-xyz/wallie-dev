import { notFound } from "next/navigation";

import { renderMarkdown } from "@/components/shared/markdown-content.server";
import { ArtifactReaderFixture } from "@/features/sessions/detail/artifact-reader-fixture";
import {
  ARTIFACT_FIXTURE_FULL_MARKDOWN,
  ARTIFACT_FIXTURE_HOSTILE,
  ARTIFACT_FIXTURE_PLAIN_TEXT,
} from "@/features/sessions/detail/artifact-fixtures";

export default async function ArtifactReaderFixturePage({
  searchParams,
}: {
  searchParams: Promise<{ theme?: string; view?: string; viewport?: string }>;
}) {
  if (process.env.NODE_ENV !== "development") notFound();

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
      renderedHtmlByView={{
        hostile: renderMarkdown(ARTIFACT_FIXTURE_HOSTILE).bodyHtml,
        plain: renderMarkdown(ARTIFACT_FIXTURE_PLAIN_TEXT).bodyHtml,
        rendered: renderMarkdown(ARTIFACT_FIXTURE_FULL_MARKDOWN).bodyHtml,
      }}
    />
  );
}
