"use client";

import { OnboardingPipelineEditor } from "@/features/onboarding/onboarding-pipeline-editor";

import type { OnboardingStepProps } from "./types";

export default function PipelineStep({
  data,
  isSaving,
  onDraftStateChange,
  onPipelineCompleted,
}: OnboardingStepProps) {
  return (
    <OnboardingPipelineEditor
      canManage={data.canManage}
      navigationPending={isSaving}
      onCompleted={onPipelineCompleted}
      onDraftStateChange={onDraftStateChange}
      pipeline={data.pipeline}
      workspaceId={data.workspace.id}
      workspaceMembers={data.workspaceMembers}
    />
  );
}
