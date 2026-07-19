"use client";

import { useMemo, useRef, useState, useTransition } from "react";

import {
  appendDraftStage,
  keepKnownApproverIds,
  moveDraftStage,
  OperatingRulesField,
  PipelineEditorControls,
  PipelineValidationSummary,
  PipelineVariableHelp,
  pipelineValidationTargetId,
  removeDraftStage,
  StageRowEditor,
  stageToDraft,
  updateDraftStage,
  validatePipelineDraft,
  type DraftPipelineStage,
  type PipelineDraftValidationResult,
  type WorkspaceMemberSummary,
} from "@/features/pipeline/editor-primitives";
import type { SessionPipeline } from "@/features/sessions/types";
import { useRegisterSettingsDirtySource } from "@/features/settings/settings-dirty-registry";
import { finishInteraction, startInteraction } from "@/lib/telemetry/interaction-rum";

type PipelineEditorProps = {
  canManage: boolean;
  pipeline: SessionPipeline | null;
  workspaceId: string;
  workspaceMembers: WorkspaceMemberSummary[];
};

function pipelineDraftProjection(
  name: string,
  operatingRules: string,
  stages: DraftPipelineStage[],
) {
  return JSON.stringify({ name, operatingRules, stages });
}

export function PipelineEditor({
  canManage,
  pipeline,
  workspaceId,
  workspaceMembers,
}: PipelineEditorProps) {
  const [name, setName] = useState(pipeline?.name ?? "Default");
  const [operatingRules, setOperatingRules] = useState(pipeline?.operatingRulesMd ?? "");
  const [stages, setStages] = useState<DraftPipelineStage[]>(() =>
    keepKnownApproverIds(pipeline?.stages.map(stageToDraft) ?? [], workspaceMembers),
  );
  const [confirmedProjection, setConfirmedProjection] = useState(() =>
    pipelineDraftProjection(
      pipeline?.name ?? "Default",
      pipeline?.operatingRulesMd ?? "",
      keepKnownApproverIds(pipeline?.stages.map(stageToDraft) ?? [], workspaceMembers),
    ),
  );
  const [hasAttemptedSave, setHasAttemptedSave] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [isPending, startTransition] = useTransition();
  const saveInFlightRef = useRef(false);
  const validation: PipelineDraftValidationResult = hasAttemptedSave
    ? validatePipelineDraft({ name, stages })
    : { ok: true };

  const isDirty = useMemo(
    () => pipelineDraftProjection(name, operatingRules, stages) !== confirmedProjection,
    [confirmedProjection, name, operatingRules, stages],
  );
  useRegisterSettingsDirtySource("pipeline-editor", isDirty, canManage);

  if (!pipeline) {
    return (
      <p className="text-sm text-muted">
        No pipeline configured. The default pipeline should be seeded automatically when the
        workspace is created.
      </p>
    );
  }

  async function savePipeline() {
    const stagesToSave = keepKnownApproverIds(stages, workspaceMembers);
    setStages(stagesToSave);

    const response = await fetch(`/api/workspaces/${workspaceId}/pipeline`, {
      body: JSON.stringify({ name, operatingRulesMd: operatingRules, stages: stagesToSave }),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "Failed to save pipeline.");
      finishInteraction("save_settings", "error");
      return;
    }

    setHasAttemptedSave(false);
    setConfirmedProjection(pipelineDraftProjection(name, operatingRules, stagesToSave));
    setSavedAt(new Date());
    finishInteraction("save_settings", "success");
  }

  function handleSave() {
    if (saveInFlightRef.current) return;

    setError(null);
    const stagesToSave = keepKnownApproverIds(stages, workspaceMembers);
    const validation = validatePipelineDraft({ name, stages: stagesToSave });
    if (!validation.ok) {
      setHasAttemptedSave(true);
      const targetId = pipelineValidationTargetId(validation.issues[0]!);
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
        await savePipeline();
      } catch (caught: unknown) {
        finishInteraction("save_settings", "error");
        setError(caught instanceof Error ? caught.message : "Failed to save pipeline.");
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
          className="rounded-[6px] border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] text-danger"
        >
          {error}
        </div>
      ) : null}
      {savedAt && !error ? (
        <p className="text-xs text-muted">
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
            disabled={!canManage}
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
        canManage={canManage}
        onChange={setOperatingRules}
        value={operatingRules}
      />

      <ol className="space-y-3">
        {stages.map((stage, index) => (
          <StageRowEditor
            key={stage.id ?? `new-${index}`}
            canManage={canManage}
            errors={
              validation.ok
                ? undefined
                : {
                    name: validation.issues.find(
                      (issue) => issue.stageIndex === index && issue.field === "stage-name",
                    )?.message,
                    slug: validation.issues.find(
                      (issue) => issue.stageIndex === index && issue.field === "stage-slug",
                    )?.message,
                  }
            }
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
        isPending={isPending}
        onAddStage={() => setStages((current) => appendDraftStage(current))}
        onSave={handleSave}
      />
    </div>
  );
}
