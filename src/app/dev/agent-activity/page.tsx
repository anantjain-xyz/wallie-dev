import { notFound } from "next/navigation";

import { isProductionDeploy } from "@/env/deploy";

import { AgentActivityPreview } from "./preview-client";

export default function AgentActivityPreviewPage() {
  if (isProductionDeploy()) notFound();
  return <AgentActivityPreview initialNow={new Date().toISOString()} />;
}
