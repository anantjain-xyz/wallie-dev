import { Suspense } from "react";
import { notFound } from "next/navigation";
import { renderMarkdownToHtml } from "@/components/shared/markdown-content.server";
import { reviewFixtureSource } from "./review-fixtures";
import { isProductionDeploy } from "@/env/deploy";
import { InteractionMotionPreview } from "./preview-client";

export default async function InteractionMotionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (isProductionDeploy()) notFound();
  const params = await searchParams;
  const version = params.reviewVersion === "2" ? 2 : 1;
  const source = reviewFixtureSource(params.reviewText, version);
  const reviewArtifact = {
    source,
    html: renderMarkdownToHtml(source, true),
    version,
  };
  return (
    <Suspense>
      <InteractionMotionPreview
        initialNow={new Date().toISOString()}
        reviewArtifact={reviewArtifact}
      />
    </Suspense>
  );
}
