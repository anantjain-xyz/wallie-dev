import { notFound } from "next/navigation";

import { AgentActivityPreview } from "./preview-client";

export default function AgentActivityPreviewPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <AgentActivityPreview initialNow={new Date().toISOString()} />;
}
