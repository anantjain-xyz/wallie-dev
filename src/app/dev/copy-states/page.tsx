import { Suspense } from "react";
import { notFound } from "next/navigation";

import { isProductionDeploy } from "@/env/deploy";
import {
  onboardingData,
  verificationCheck,
  verificationData,
} from "@/features/onboarding/fixtures";
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
  const initialData =
    state === "onboarding-verify" || state === "onboarding-blocked"
      ? verificationData()
      : onboardingData();
  if (state === "onboarding-blocked") {
    initialData.setupHealth.latestSandboxCapabilityCheck = verificationCheck("error");
  }
  return (
    <Suspense>
      <CopyStatesPreview
        onboarding={
          <OnboardingPageClient initialData={initialData} initialNow="2026-11-08T12:00:00.000Z" />
        }
      />
    </Suspense>
  );
}
