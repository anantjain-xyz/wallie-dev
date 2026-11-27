"use client";

import { useEffect, useState } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { OnboardingPipelineEditor } from "@/features/onboarding/onboarding-pipeline-editor";
import { stageToDraft, validatePipelineDraft } from "@/features/pipeline/editor-primitives";

import type { OnboardingStepProps } from "./types";

export default function PipelineStep({
  data,
  isSaving,
  onDraftStateChange,
  onKeepPipeline,
  onPipelineCompleted,
}: OnboardingStepProps) {
  const [customizing, setCustomizing] = useState(false);
  const { onboarding, pipeline } = data;
  const useSavedPlanBuild =
    data.canManage &&
    onKeepPipeline &&
    !customizing &&
    onboarding.status !== "completed" &&
    !onboarding.completedSteps.includes("pipeline") &&
    pipeline?.isDefault &&
    pipeline.stages.length === 2 &&
    pipeline.stages[0]?.slug === "plan" &&
    pipeline.stages[0]?.name === "Plan" &&
    pipeline.stages[1]?.slug === "build" &&
    pipeline.stages[1]?.name === "Build" &&
    validatePipelineDraft({ name: pipeline.name, stages: pipeline.stages.map(stageToDraft) }).ok;

  useEffect(() => {
    if (customizing) document.getElementById("pipeline-name")?.focus();
  }, [customizing]);

  if (useSavedPlanBuild) {
    return (
      <div className="space-y-3">
        <p className="text-[13px] leading-5 text-muted">
          Keep the default Plan → Build order. Your saved prompts and approvers stay as they are.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            className="ui-button-primary min-h-11"
            disabled={isSaving}
            onClick={onKeepPipeline}
            type="button"
          >
            <ActionButtonLabel idle="Use Plan → Build" pending={isSaving} pendingLabel="Saving…" />
          </button>
          <button
            className="ui-button min-h-11"
            disabled={isSaving}
            onClick={() => setCustomizing(true)}
            type="button"
          >
            Customize stages
          </button>
        </div>
      </div>
    );
  }

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
