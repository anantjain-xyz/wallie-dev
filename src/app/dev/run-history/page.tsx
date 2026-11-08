import { notFound } from "next/navigation";
import { isProductionDeploy } from "@/env/deploy";
import { RunHistoryPreview } from "./preview-client";

export default function RunHistoryPage() {
  if (isProductionDeploy()) notFound();
  return <RunHistoryPreview />;
}
