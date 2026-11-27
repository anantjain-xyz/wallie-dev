import { notFound } from "next/navigation";

import { verificationCheck, verificationData } from "@/features/onboarding/fixtures";
import { OnboardingPageClient } from "@/features/onboarding/onboarding-page-client";

export default async function OnboardingPreview({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const { state } = await searchParams;
  if (state !== "ready" && state !== "stale" && state !== "member") notFound();

  const data = verificationData();
  data.onboarding.status = "completed";
  data.onboarding.completedAt = "2026-09-06T19:15:00.000Z";
  data.setupHealth.latestSandboxCapabilityCheck = verificationCheck();
  if (state !== "ready") {
    data.setupHealth.latestSandboxCapabilityCheck.agentModel = "gpt-previous-model";
  }
  if (state === "member") {
    data.canManage = false;
    data.currentMember.role = "member";
    data.setupHealth.codexConnection.connected = false;
    data.setupHealth.codexConnection.status = "missing";
  }

  return <OnboardingPageClient initialData={data} initialNow="2026-09-06T19:20:00.000Z" />;
}
