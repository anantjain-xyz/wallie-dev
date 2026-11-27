import { Suspense } from "react";
import { notFound } from "next/navigation";

import { isProductionDeploy } from "@/env/deploy";
import { AppShell } from "@/components/app-shell/app-shell";
import { StageStartupPreview } from "./preview-client";

export default function StageStartupPage() {
  if (isProductionDeploy()) notFound();
  return (
    <AppShell
      workspace={{ id: "stage-proof", name: "Wallie", slug: "proof" }}
      onboarding={null}
      pathnameOverride="/w/proof/sessions/1"
      viewerId="proof-viewer"
      viewerEmail="preview@example.com"
      viewerAvatarUrl={null}
      workspaceAvatarUrl={null}
    >
      <Suspense>
        <StageStartupPreview />
      </Suspense>
    </AppShell>
  );
}
