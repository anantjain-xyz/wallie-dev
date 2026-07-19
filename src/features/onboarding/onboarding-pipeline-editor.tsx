"use client";

import { useRef, useState, type DragEvent } from "react";

import { useOptionalLiveRegion } from "@/components/ui/live-region";
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
  const { announce } = useOptionalLiveRegion();
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
  const removeFocusRef = useRef<HTMLElement | null>(null);
  const validation: PipelineDraftValidationResult = hasAttemptedSave
    ? validatePipelineDraft({ name, stages })
    : { ok: true };
  const removeStage = removeIndex === null ? null : stages[removeIndex];
  const editable = canManage && !isSaving;

  if (!pipeline) {
    return (
      <div className="rounded-[6px] border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] text-danger">
        Workspace has no default pipeline.
      </div>
    );
  }

  function announceStagePosition(nextStages: DraftPipelineStage[], index: number) {
    const stage = nextStages[index];
    if (!stage) return;
    announce(
      `${stageDisplayName(stage, index)} moved to position ${index + 1} of ${nextStages.length}.`,
    );
  }

  function applyMove(index: number, direction: -1 | 1) {
    const next = moveDraftStage(stages, index, direction);
    if (next === stages) return;
    setStages(next);
    announceStagePosition(next, index + direction);
  }

  function handleDrop(targetIndex: number) {
    if (dragIndex === null) {
      setDragIndex(null);
      return;
    }
    const next = reorderDraftStage(stages, dragIndex, targetIndex);
    setDragIndex(null);
    if (next === stages) return;
    setStages(next);
    announceStagePosition(next, targetIndex);
  }

  function handleAddStage() {
    const next = appendDraftStage(stages);
    const added = next[next.length - 1]!;
    setStages(next);
    announce(
      `Added ${stageDisplayName(added, next.length - 1)} at position ${next.length} of ${next.length}.`,
    );
  }

  function handleRemoveAt(index: number) {
    const label = stageDisplayName(stages[index]!, index);
    setStages(removeDraftStage(stages, index));
    announce(`Removed ${label}.`);
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
            disabled={!editable}
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
        canManage={editable}
        compact
        onChange={setOperatingRules}
        value={operatingRules}
      />

      <ol className="space-y-3">
        {stages.map((stage, index) => (
          <StageRowEditor
            compact
            key={stage.key}
            canManage={editable}
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
            onDrop={handleDrop}
            onMoveDown={() => applyMove(index, 1)}
            onMoveUp={() => applyMove(index, -1)}
            onRemove={() => handleRemoveAt(index)}
            onRemoveRequest={() => {
              removeFocusRef.current = document.getElementById(`pipeline-stage-${index}-remove`);
              setRemoveIndex(index);
            }}
            stage={stage}
            totalStages={stages.length}
            workspaceMembers={workspaceMembers}
          />
        ))}
      </ol>

      <PipelineEditorControls
        canManage={canManage}
        isPending={isSaving}
        onAddStage={handleAddStage}
        onSave={() => void savePipeline()}
      />

      <RemoveStageDialog
        onConfirm={() => {
          if (removeIndex === null) return;
          const index = removeIndex;
          removeFocusRef.current =
            document.getElementById(`pipeline-stage-${Math.max(0, index - 1)}-name`) ??
            document.getElementById("pipeline-add-stage");
          setRemoveIndex(null);
          handleRemoveAt(index);
        }}
        onOpenChange={(open) => {
          if (!open) setRemoveIndex(null);
        }}
        open={removeIndex !== null && removeStage !== undefined}
        restoreFocusRef={removeFocusRef}
        stageLabel={
          removeStage && removeIndex !== null ? stageDisplayName(removeStage, removeIndex) : "stage"
        }
      />
    </div>
  );
}
