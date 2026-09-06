import { notFound } from "next/navigation";

import { isProductionDeploy } from "@/env/deploy";
import { verificationCheck, verificationData } from "@/features/onboarding/fixtures";
import { OnboardingPageClient } from "@/features/onboarding/onboarding-page-client";
import { WORKSPACE_ONBOARDING_STEPS } from "@/lib/onboarding/contracts";

export default async function OnboardingPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ completed?: string; state?: string }>;
}) {
  if (isProductionDeploy()) notFound();
  const { completed, state } = await searchParams;
  const data = verificationData();
  if (state === "success" || state === "completed" || state === "stale") {
    data.setupHealth.latestSandboxCapabilityCheck = verificationCheck();
  } else if (state === "running" || state === "error") {
    data.setupHealth.latestSandboxCapabilityCheck = verificationCheck(state);
  } else if (state === "blocked") {
    data.setupHealth.codexConnection.connected = false;
  } else if (state === "read-only") {
    data.canManage = false;
  }
  if (state === "completed" || completed === "true") {
    data.onboarding.status = "completed";
    data.onboarding.completedSteps = [...WORKSPACE_ONBOARDING_STEPS];
    data.onboarding.skippedSteps = [];
  }
  if (state === "stale") data.setupHealth.latestSandboxCapabilityCheck!.agentModel = "old-model";

  return <OnboardingPageClient initialData={data} />;
}
