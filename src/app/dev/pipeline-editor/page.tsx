import { notFound } from "next/navigation";

import { isProductionDeploy } from "@/env/deploy";

import { PipelineEditorDevPreview } from "./preview-client";

export default function PipelineEditorDevPreviewPage() {
  // Preview-reachable: NODE_ENV is always "production" on Vercel.
  if (isProductionDeploy()) notFound();
  return <PipelineEditorDevPreview />;
}
