import { Suspense } from "react";
import { notFound } from "next/navigation";

import { isProductionDeploy } from "@/env/deploy";
import { onboardingData, verificationData } from "@/features/onboarding/fixtures";
import { OnboardingPageClient } from "@/features/onboarding/onboarding-page-client";
import { CopyStatesPreview } from "./preview-client";

/** Real recovery and onboarding surfaces, without auth or external writes. */
export default async function CopyStatesPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  if (isProductionDeploy()) notFound();
  const { state } = await searchParams;
  return (
    <Suspense>
      <CopyStatesPreview
        onboarding={
          <OnboardingPageClient
            initialData={state === "onboarding-verify" ? verificationData() : onboardingData()}
            initialNow="2026-11-08T12:00:00.000Z"
          />
        }
      />
    </Suspense>
  );
}
