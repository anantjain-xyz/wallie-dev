import { notFound } from "next/navigation";

import { PipelineEditorDevPreview } from "./preview-client";

export default function PipelineEditorDevPreviewPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <PipelineEditorDevPreview />;
}
