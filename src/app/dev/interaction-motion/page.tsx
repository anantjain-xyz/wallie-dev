import { Suspense } from "react";
import { notFound } from "next/navigation";
import { isProductionDeploy } from "@/env/deploy";
import { InteractionMotionPreview } from "./preview-client";

export default function InteractionMotionPage() {
  if (isProductionDeploy()) notFound();
  return (
    <Suspense>
      <InteractionMotionPreview initialNow={new Date().toISOString()} />
    </Suspense>
  );
}
