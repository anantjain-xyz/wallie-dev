"use client";

import { useState, type DragEvent } from "react";

import {
  appendDraftStage,
  fieldErrorsForStage,
  keepKnownApproverIds,
  moveDraftStage,
  OperatingRulesField,
  PipelineEditorControls,
  PipelineValidationSummary,
  PipelineVariableHelp,
  pipelineValidationTargetId,
  RemoveStageDialog,
  reorderDraftStage,
  removeDraftStage,
  StageRowEditor,
  stageDisplayName,
  stageToDraft,
  updateDraftStage,
  updateDraftStageName,
  updateDraftStageSlug,
  validatePipelineDraft,
  type DraftPipelineStage,
  type PipelineDraftValidationResult,
  type WorkspaceMemberSummary,
} from "@/features/pipeline/editor-primitives";
import type { SessionPipeline } from "@/features/sessions/types";

type OnboardingPipelineEditorProps = {
  canManage: boolean;
  onCompleted: (action: string, pipeline: SessionPipeline) => Promise<void>;
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
  const [operatingRules, setOperatingRules] = useState(pipeline?.operatingRulesMd ?? "");
  const [stages, setStages] = useState<DraftPipelineStage[]>(() =>
    keepKnownApproverIds(pipeline?.stages.map(stageToDraft) ?? [], workspaceMembers),
  );
  const [hasAttemptedSave, setHasAttemptedSave] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [removeIndex, setRemoveIndex] = useState<number | null>(null);
  const validation: PipelineDraftValidationResult = hasAttemptedSave
    ? validatePipelineDraft({ name, stages })
    : { ok: true };
  const removeStage = removeIndex === null ? null : stages[removeIndex];

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
    const nextValidation = validatePipelineDraft({ name, stages: stagesToSave });
    if (!nextValidation.ok) {
      setHasAttemptedSave(true);
      setStages(stagesToSave);
      const targetId = pipelineValidationTargetId(nextValidation.issues[0]!);
      if (targetId) {
        window.setTimeout(() => document.getElementById(targetId)?.focus(), 0);
      }
      return;
    }

    setHasAttemptedSave(false);
    setStages(stagesToSave);
    setIsSaving(true);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/pipeline`, {
        body: JSON.stringify({ name, operatingRulesMd: operatingRules, stages: stagesToSave }),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Failed to save pipeline. Your edits are preserved — try again.");
        return;
      }

      const body = (await response.json()) as { pipeline: SessionPipeline };
      await onCompleted("pipeline:save", body.pipeline);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? `${caught.message} Your edits are preserved — try again.`
          : "Failed to save pipeline. Your edits are preserved — try again.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <PipelineValidationSummary validation={validation} />
      {error ? (
        <div
          role="alert"
          className="rounded-[6px] border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] text-danger"
        >
          {error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-4">
        <div className="block space-y-1.5">
          <label className="text-[13px] font-medium text-foreground" htmlFor="pipeline-name">
            Pipeline name
          </label>
          <input
            aria-describedby={`pipeline-name-description${!validation.ok && validation.field === "pipeline-name" ? " pipeline-name-error" : ""}`}
            aria-invalid={!validation.ok && validation.field === "pipeline-name" ? true : undefined}
            id="pipeline-name"
            type="text"
            value={name}
            disabled={!canManage || isSaving}
            onChange={(event) => setName(event.target.value)}
            className={`ui-input min-w-[240px] ${!validation.ok && validation.field === "pipeline-name" ? "border-danger" : ""}`}
            maxLength={80}
          />
          <p className="type-annotation text-muted" id="pipeline-name-description">
            Identifies this pipeline throughout the workspace.
          </p>
          {!validation.ok && validation.field === "pipeline-name" ? (
            <p className="text-xs font-medium text-danger" id="pipeline-name-error">
              {validation.message}
            </p>
          ) : null}
        </div>
        <PipelineVariableHelp />
      </div>

      <OperatingRulesField
        canManage={canManage && !isSaving}
        compact
        onChange={setOperatingRules}
        value={operatingRules}
      />

      <ol className="space-y-3">
        {stages.map((stage, index) => (
          <StageRowEditor
            compact
            key={stage.key}
            canManage={canManage && !isSaving}
            dragIndex={dragIndex}
            errors={fieldErrorsForStage(validation, index)}
            index={index}
            isFirst={index === 0}
            isLast={index === stages.length - 1}
            onChange={(patch) => setStages((current) => updateDraftStage(current, index, patch))}
            onChangeName={(nextName) =>
              setStages((current) => updateDraftStageName(current, index, nextName))
            }
            onChangeSlug={(nextSlug) =>
              setStages((current) => updateDraftStageSlug(current, index, nextSlug))
            }
            onDragEnd={() => setDragIndex(null)}
            onDragOver={(event: DragEvent<HTMLLIElement>) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }}
            onDragStart={setDragIndex}
            onDrop={(targetIndex) => {
              setStages((current) => {
                if (dragIndex === null) return current;
                return reorderDraftStage(current, dragIndex, targetIndex);
              });
              setDragIndex(null);
            }}
            onMoveDown={() => setStages((current) => moveDraftStage(current, index, 1))}
            onMoveUp={() => setStages((current) => moveDraftStage(current, index, -1))}
            onRemove={() => setStages((current) => removeDraftStage(current, index))}
            onRemoveRequest={() => setRemoveIndex(index)}
            stage={stage}
            totalStages={stages.length}
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

      <RemoveStageDialog
        onConfirm={() => {
          if (removeIndex === null) return;
          setStages((current) => removeDraftStage(current, removeIndex));
          setRemoveIndex(null);
        }}
        onOpenChange={(open) => {
          if (!open) setRemoveIndex(null);
        }}
        open={removeIndex !== null && removeStage !== undefined}
        stageLabel={
          removeStage && removeIndex !== null ? stageDisplayName(removeStage, removeIndex) : "stage"
        }
      />
    </div>
  );
}
