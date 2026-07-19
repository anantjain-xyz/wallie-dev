"use client";

import { OnboardingPipelineEditor } from "@/features/onboarding/onboarding-pipeline-editor";
import { ONBOARDING_FOCUS_TARGETS } from "@/features/onboarding/progress";

import type { OnboardingStepProps } from "./types";

export default function PipelineStep({ data, onPipelineCompleted }: OnboardingStepProps) {
  return (
    <div id={ONBOARDING_FOCUS_TARGETS.pipeline} tabIndex={-1}>
      <OnboardingPipelineEditor
        canManage={data.canManage}
        onCompleted={onPipelineCompleted}
        pipeline={data.pipeline}
        workspaceId={data.workspace.id}
        workspaceMembers={data.workspaceMembers}
      />
    </div>
  );
}
