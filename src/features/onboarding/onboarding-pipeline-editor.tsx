"use client";

import { useEffect, useRef, useState } from "react";

import { useOptionalLiveRegion } from "@/components/ui/live-region";
import type { OnboardingStepDraftState } from "@/features/onboarding/steps/types";
import {
  appendDraftStage,
  fieldErrorsForStage,
  keepKnownApproverIds,
  moveDraftStage,
  OperatingRulesField,
  PipelineEditorControls,
  PipelineValidationSummary,
  pipelineValidationTargetId,
  RemoveStageDialog,
  removeDraftStage,
  resolveFocusAfterStageRemoval,
  serializePipelineDraft,
  StageRowEditor,
  stageDisplayName,
  stageToDraft,
  updateDraftStage,
  updateDraftStageName,
  validatePipelineDraft,
  type DraftPipelineStage,
  type PipelineDraftValidationResult,
  type WorkspaceMemberSummary,
} from "@/features/pipeline/editor-primitives";
import type { SessionPipeline } from "@/features/sessions/types";

type OnboardingPipelineEditorProps = {
  canManage: boolean;
  navigationPending?: boolean;
  onCompleted: (action: string, pipeline: SessionPipeline) => Promise<void>;
  onDraftStateChange?: (state: OnboardingStepDraftState) => void;
  pipeline: SessionPipeline | null;
  workspaceId: string;
  workspaceMembers: WorkspaceMemberSummary[];
};

export function OnboardingPipelineEditor({
  canManage,
  navigationPending,
  onCompleted,
  onDraftStateChange,
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
  const [removeIndex, setRemoveIndex] = useState<number | null>(null);
  const removeFocusRef = useRef<HTMLElement | null>(null);
  const validation: PipelineDraftValidationResult = hasAttemptedSave
    ? validatePipelineDraft({ name, stages })
    : { ok: true };
  const removeStage = removeIndex === null ? null : stages[removeIndex];
  const editable = canManage && !isSaving && !navigationPending;
  const dirty = Boolean(
    pipeline &&
    serializePipelineDraft({ name, operatingRules, stages }) !==
      serializePipelineDraft({
        name: pipeline.name,
        operatingRules: pipeline.operatingRulesMd ?? "",
        stages: keepKnownApproverIds(pipeline.stages.map(stageToDraft), workspaceMembers),
      }),
  );
  const unidentifiedMembers = workspaceMembers.filter(
    (member) => !member.fullName?.trim() && !member.email?.trim(),
  );

  useEffect(() => {
    onDraftStateChange?.({ dirty, pending: isSaving });
  }, [dirty, isSaving, onDraftStateChange]);

  if (!pipeline) {
    return (
      <div
        className="space-y-1 rounded-[6px] border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] text-danger"
        role="alert"
      >
        <p className="font-medium">This workspace has no default pipeline.</p>
        <p>
          You can review other steps, but verification needs a default pipeline. Ask your workspace
          owner to contact Wallie support to restore it.
        </p>
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

  function handleAddStage() {
    const next = appendDraftStage(stages);
    const added = next[next.length - 1]!;
    setStages(next);
    announce(
      `Added ${stageDisplayName(added, next.length - 1)} at position ${next.length} of ${next.length}.`,
    );
  }

  function handleRemoveAt(index: number) {
    const stage = stages[index]!;
    const label = stageDisplayName(stage, index);
    setStages(removeDraftStage(stages, index));
    announce(stage.id ? `${label} will be archived when saved.` : `Discarded unsaved ${label}.`);
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
        setError(body?.error ?? "Couldn’t save pipeline. Edits kept.");
        return;
      }

      const body = (await response.json()) as { pipeline: SessionPipeline };
      // Normalize drafts from the saved response before advancing onboarding so a
      // failed step persist still keeps server stage IDs (slug lock + rewrite safety).
      const saved = body.pipeline;
      setName(saved.name);
      setOperatingRules(saved.operatingRulesMd ?? "");
      setStages(keepKnownApproverIds(saved.stages.map(stageToDraft), workspaceMembers));
      await onCompleted("pipeline:save", saved);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? `${caught.message} Edits kept. Retry.`
          : "Couldn’t save pipeline. Edits kept.",
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
      </div>

      <OperatingRulesField
        canManage={editable}
        compact
        onChange={setOperatingRules}
        value={operatingRules}
      />

      {unidentifiedMembers.length ? (
        <p className="text-xs leading-5 text-muted">
          Some members can’t be identified. Existing approver assignments are kept as “Member
          details unavailable”. Ask those members to complete their profile before assigning them to
          new stages.
        </p>
      ) : null}
      <ol className="space-y-3">
        {stages.map((stage, index) => (
          <StageRowEditor
            compact
            key={stage.key}
            canManage={editable}
            errors={fieldErrorsForStage(validation, index)}
            index={index}
            isFirst={index === 0}
            isLast={index === stages.length - 1}
            onChange={(patch) => setStages((current) => updateDraftStage(current, index, patch))}
            onChangeName={(nextName) =>
              setStages((current) => updateDraftStageName(current, index, nextName))
            }
            onMoveDown={() => applyMove(index, 1)}
            onMoveUp={() => applyMove(index, -1)}
            onRemove={() => handleRemoveAt(index)}
            onRemoveRequest={() => {
              removeFocusRef.current = document.getElementById(`pipeline-stage-${index}-remove`);
              setRemoveIndex(index);
            }}
            priorStages={stages.slice(0, index).map((prior) => ({ slug: prior.slug }))}
            stage={stage}
            totalStages={stages.length}
            workspaceMembers={workspaceMembers.flatMap((member) => {
              const name = member.fullName?.trim();
              const email = member.email?.trim();
              if (!name && !email && !stage.approverMemberIds.includes(member.id)) return [];
              return [
                {
                  ...member,
                  fullName:
                    name && email && name !== email
                      ? `${name} · ${email}`
                      : name || email || "Member details unavailable",
                },
              ];
            })}
          />
        ))}
      </ol>

      <PipelineEditorControls
        canManage={canManage}
        isPending={isSaving || Boolean(navigationPending)}
        onAddStage={handleAddStage}
        onSave={() => void savePipeline()}
      />
      {dirty && !isSaving ? (
        <p className="text-xs text-muted" role="status">
          Unsaved changes
        </p>
      ) : null}

      <RemoveStageDialog
        onConfirm={() => {
          if (removeIndex === null) return;
          const index = removeIndex;
          removeFocusRef.current = resolveFocusAfterStageRemoval(stages.length, index);
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
