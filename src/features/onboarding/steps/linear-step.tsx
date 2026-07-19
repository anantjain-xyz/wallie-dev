"use client";

import { OnboardingLinearStep } from "@/features/onboarding/onboarding-linear-step";

import type { OnboardingStepProps } from "./types";

export default function LinearStep({ data, onCompleteStep, onRefresh }: OnboardingStepProps) {
  return (
    <OnboardingLinearStep
      canManage={data.canManage}
      linearKeyConfigured={data.setupHealth.linearKey.configured}
      linearRouting={data.linearRouting}
      linearSecret={data.linearSecret}
      onCompleted={onCompleteStep}
      onRefresh={onRefresh}
      pipeline={data.pipeline}
      workspaceId={data.workspace.id}
    />
  );
}
