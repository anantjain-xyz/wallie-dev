"use client";

import { OnboardingLinearStep } from "@/features/onboarding/onboarding-linear-step";
import { ONBOARDING_FOCUS_TARGETS } from "@/features/onboarding/progress";

import type { OnboardingStepProps } from "./types";

export default function LinearStep({ data, onCompleteStep, onRefresh }: OnboardingStepProps) {
  return (
    <div id={ONBOARDING_FOCUS_TARGETS.linear} tabIndex={-1}>
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
    </div>
  );
}
