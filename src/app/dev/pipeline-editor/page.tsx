import { notFound } from "next/navigation";

import { isProductionDeploy } from "@/env/deploy";

import { PipelineEditorDevPreview } from "./preview-client";

export default function PipelineEditorDevPreviewPage() {
  if (isProductionDeploy()) notFound();
  return <PipelineEditorDevPreview />;
}
