"use client";

import { useEffect, useRef, useState, useTransition, type DragEvent } from "react";

import { Status } from "@/components/ui/status";
import { useOptionalLiveRegion } from "@/components/ui/live-region";
import {
  appendDraftStage,
  fieldErrorsForStage,
  keepKnownApproverIds,
  moveDraftStage,
  OperatingRulesField,
  PipelineEditorControls,
  PipelineStageOrderPreview,
  PipelineValidationSummary,
  PipelineVariableHelp,
  pipelineValidationTargetId,
  RemoveStageDialog,
  reorderDraftStage,
  removeDraftStage,
  serializePipelineDraft,
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
import { finishInteraction, startInteraction } from "@/lib/telemetry/interaction-rum";

type PipelineEditorProps = {
  canManage: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  pipeline: SessionPipeline | null;
  workspaceId: string;
  workspaceMembers: WorkspaceMemberSummary[];
};

function draftsFromPipeline(
  pipeline: SessionPipeline,
  workspaceMembers: WorkspaceMemberSummary[],
): DraftPipelineStage[] {
  return keepKnownApproverIds(pipeline.stages.map(stageToDraft), workspaceMembers);
}

export function PipelineEditor({
  canManage,
  onDirtyChange,
  pipeline,
  workspaceId,
  workspaceMembers,
}: PipelineEditorProps) {
  const { announce } = useOptionalLiveRegion();
  const [name, setName] = useState(pipeline?.name ?? "Default");
  const [operatingRules, setOperatingRules] = useState(pipeline?.operatingRulesMd ?? "");
  const [stages, setStages] = useState<DraftPipelineStage[]>(() =>
    pipeline ? draftsFromPipeline(pipeline, workspaceMembers) : [],
  );
  const [baseline, setBaseline] = useState(() =>
    serializePipelineDraft({
      name: pipeline?.name ?? "Default",
      operatingRules: pipeline?.operatingRulesMd ?? "",
      stages: pipeline ? draftsFromPipeline(pipeline, workspaceMembers) : [],
    }),
  );
  const [hasAttemptedSave, setHasAttemptedSave] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [removeIndex, setRemoveIndex] = useState<number | null>(null);
  const [isPending, startTransition] = useTransition();
  const saveInFlightRef = useRef(false);
  const removeFocusRef = useRef<HTMLElement | null>(null);

  const dirty = serializePipelineDraft({ name, operatingRules, stages }) !== baseline;
  const validation: PipelineDraftValidationResult = hasAttemptedSave
    ? validatePipelineDraft({ name, stages })
    : { ok: true };
  const removeStage = removeIndex === null ? null : stages[removeIndex];
  const editable = canManage && !isPending;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  if (!pipeline) {
    return (
      <p className="text-sm text-muted">
        No pipeline configured. The default pipeline should be seeded automatically when the
        workspace is created.
      </p>
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

  async function savePipeline(stagesToSave: DraftPipelineStage[]) {
    const response = await fetch(`/api/workspaces/${workspaceId}/pipeline`, {
      body: JSON.stringify({ name, operatingRulesMd: operatingRules, stages: stagesToSave }),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "Failed to save pipeline. Your edits are preserved — try again.");
      finishInteraction("save_settings", "error");
      return;
    }

    const body = (await response.json().catch(() => null)) as {
      pipeline?: SessionPipeline;
    } | null;
    const savedPipeline = body?.pipeline;
    const nextStages = savedPipeline
      ? draftsFromPipeline(savedPipeline, workspaceMembers)
      : stagesToSave.map((stage) => ({ ...stage, slugManual: true }));
    const nextName = savedPipeline?.name ?? name;
    const nextRules = savedPipeline?.operatingRulesMd ?? operatingRules;

    setName(nextName);
    setOperatingRules(nextRules);
    setStages(nextStages);
    setBaseline(
      serializePipelineDraft({
        name: nextName,
        operatingRules: nextRules,
        stages: nextStages,
      }),
    );
    setHasAttemptedSave(false);
    setError(null);
    setSavedAt(new Date());
    announce("Pipeline saved.");
    finishInteraction("save_settings", "success");
  }

  function handleSave() {
    if (saveInFlightRef.current) return;

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
    saveInFlightRef.current = true;
    startInteraction("save_settings", "/w/[workspaceSlug]/settings");

    startTransition(async () => {
      try {
        await savePipeline(stagesToSave);
      } catch (caught: unknown) {
        finishInteraction("save_settings", "error");
        setError(
          caught instanceof Error
            ? `${caught.message} Your edits are preserved — try again.`
            : "Failed to save pipeline. Your edits are preserved — try again.",
        );
      } finally {
        saveInFlightRef.current = false;
      }
    });
  }

  return (
    <div className="space-y-6">
      <PipelineValidationSummary validation={validation} />
      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-[6px] border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] text-danger"
        >
          <p>{error}</p>
          <button
            className="ui-button shrink-0"
            disabled={isPending}
            onClick={handleSave}
            type="button"
          >
            Retry save
          </button>
        </div>
      ) : null}
      {savedAt && !error && !dirty ? (
        <p className="text-xs text-muted" role="status">
          Saved at {savedAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
        </p>
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
        onChange={setOperatingRules}
        value={operatingRules}
      />

      <PipelineStageOrderPreview stages={stages} />

      <ol className="space-y-3">
        {stages.map((stage, index) => (
          <StageRowEditor
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
        isPending={isPending}
        onAddStage={handleAddStage}
        onSave={handleSave}
        saveDisabled={!dirty && !error}
        saveLabel="Save pipeline"
      />

      <RemoveStageDialog
        onConfirm={() => {
          if (removeIndex === null) return;
          const index = removeIndex;
          // Row will unmount; restore to a surviving control.
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

export function PipelineUnsavedBadge({ dirty }: { dirty: boolean }) {
  if (!dirty) return null;
  return <Status label="Unsaved changes" value="needs_attention" />;
}
