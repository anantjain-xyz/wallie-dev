"use client";

import { OnboardingPipelineEditor } from "@/features/onboarding/onboarding-pipeline-editor";

import type { OnboardingStepProps } from "./types";

export default function PipelineStep({ data, onPipelineCompleted }: OnboardingStepProps) {
  return (
    <OnboardingPipelineEditor
      canManage={data.canManage}
      onCompleted={onPipelineCompleted}
      pipeline={data.pipeline}
      workspaceId={data.workspace.id}
      workspaceMembers={data.workspaceMembers}
    />
  );
}
