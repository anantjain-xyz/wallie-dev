"use client";

import { useState, useTransition } from "react";

import {
  appendDraftStage,
  keepKnownApproverIds,
  moveDraftStage,
  OperatingRulesField,
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

type PipelineEditorProps = {
  canManage: boolean;
  pipeline: SessionPipeline | null;
  workspaceId: string;
  workspaceMembers: WorkspaceMemberSummary[];
};

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
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [isPending, startTransition] = useTransition();

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
      return;
    }

    setSavedAt(new Date());
  }

  function handleSave() {
    setError(null);
    const stagesToSave = keepKnownApproverIds(stages, workspaceMembers);
    const validation = validatePipelineDraft({ name, stages: stagesToSave });
    if (!validation.ok) {
      setError(validation.message);
      return;
    }

    setStages(stagesToSave);

    startTransition(async () => {
      await savePipeline().catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : "Failed to save pipeline.");
      });
    });
  }

  return (
    <div className="space-y-6">
      {error ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-[6px] border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] text-danger"
        >
          {error}
        </div>
      ) : null}
      {savedAt && !error ? (
        <p className="text-[12px] text-muted">
          Saved at {savedAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-4">
        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium text-foreground">Pipeline name</span>
          <input
            type="text"
            value={name}
            disabled={!canManage}
            onChange={(event) => setName(event.target.value)}
            className="ui-input min-w-[240px]"
            maxLength={80}
          />
        </label>
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
