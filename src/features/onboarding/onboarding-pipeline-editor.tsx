"use client";

import { useState } from "react";

import {
  appendDraftStage,
  keepKnownApproverIds,
  moveDraftStage,
  PipelineEditorControls,
  PipelineVariableHelp,
  removeDraftStage,
  StageRowEditor,
  stageToDraft,
  updateDraftStage,
  validatePipelineDraft,
  type DraftPipelineStage,
  type WorkspaceMemberSummary,
} from "@/features/pipeline/editor-primitives";
import type { SessionPipeline } from "@/features/sessions/types";

type OnboardingPipelineEditorProps = {
  canManage: boolean;
  onCompleted: (action: string) => Promise<void>;
  pipeline: SessionPipeline | null;
  workspaceId: string;
  workspaceMembers: WorkspaceMemberSummary[];
};

export function OnboardingPipelineEditor({
  canManage,
  onCompleted,
  pipeline,
  workspaceId,
  workspaceMembers,
}: OnboardingPipelineEditorProps) {
  const [name, setName] = useState(pipeline?.name ?? "Default");
  const [stages, setStages] = useState<DraftPipelineStage[]>(
    () => keepKnownApproverIds(pipeline?.stages.map(stageToDraft) ?? [], workspaceMembers),
  );
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  if (!pipeline) {
    return (
      <div className="rounded-[6px] border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] text-danger">
        Workspace has no default pipeline.
      </div>
    );
  }

  async function savePipeline() {
    setError(null);
    const stagesToSave = keepKnownApproverIds(stages, workspaceMembers);
    const validation = validatePipelineDraft({ name, stages: stagesToSave });
    if (!validation.ok) {
      setError(validation.message);
      return;
    }

    setStages(stagesToSave);
    setIsSaving(true);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/pipeline`, {
        body: JSON.stringify({ name, stages: stagesToSave }),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Failed to save pipeline.");
        return;
      }

      await onCompleted("pipeline:save");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to save pipeline.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      {error ? (
        <div
          role="alert"
          className="rounded-[6px] border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] text-danger"
        >
          {error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-4">
        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium text-foreground">Pipeline name</span>
          <input
            type="text"
            value={name}
            disabled={!canManage || isSaving}
            onChange={(event) => setName(event.target.value)}
            className="ui-input min-w-[240px]"
            maxLength={80}
          />
        </label>
        <PipelineVariableHelp />
      </div>

      <ol className="space-y-3">
        {stages.map((stage, index) => (
          <StageRowEditor
            compact
            key={stage.id ?? `new-${index}`}
            canManage={canManage && !isSaving}
            index={index}
            isFirst={index === 0}
            isLast={index === stages.length - 1}
            onChange={(patch) => setStages((current) => updateDraftStage(current, index, patch))}
            onMoveDown={() => setStages((current) => moveDraftStage(current, index, 1))}
            onMoveUp={() => setStages((current) => moveDraftStage(current, index, -1))}
            onRemove={() => setStages((current) => removeDraftStage(current, index))}
            stage={stage}
            workspaceMembers={workspaceMembers}
          />
        ))}
      </ol>

      <PipelineEditorControls
        canManage={canManage}
        isPending={isSaving}
        onAddStage={() => setStages((current) => appendDraftStage(current))}
        onSave={() => void savePipeline()}
      />
    </div>
  );
}
