"use client";

import { useState } from "react";

import type { PipelineStage } from "@/features/sessions/types";

export type WorkspaceMemberSummary = {
  id: string;
  fullName: string | null;
  email: string | null;
  role: "owner" | "admin" | "member" | "agent";
};

export type DraftPipelineStage = {
  approverMemberIds: string[];
  description: string;
  id: string | null;
  name: string;
  promptTemplateMd: string;
  slug: string;
};

export type PipelineDraftValidationCode =
  | "duplicate-stage-slug"
  | "empty-stage-list"
  | "invalid-stage-slug"
  | "missing-pipeline-name"
  | "missing-stage-name";

export type PipelineDraftValidationResult =
  | { ok: true }
  | {
      code: PipelineDraftValidationCode;
      message: string;
      ok: false;
      stageIndex?: number;
    };

export const STAGE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const PIPELINE_VARIABLE_HELP = [
  "{{session.title}}",
  "{{session.prompt}}",
  "{{attempt.number}}",
  "{{attempt.feedback}}",
  "{{artifact.previousStages.<slug>}}",
] as const;

export function stageToDraft(stage: PipelineStage): DraftPipelineStage {
  return {
    approverMemberIds: stage.approverMemberIds,
    description: stage.description,
    id: stage.id,
    name: stage.name,
    promptTemplateMd: stage.promptTemplateMd,
    slug: stage.slug,
  };
}

export function keepKnownApproverIds(
  stages: DraftPipelineStage[],
  workspaceMembers: WorkspaceMemberSummary[],
): DraftPipelineStage[] {
  const knownMemberIds = new Set(workspaceMembers.map((member) => member.id));
  return stages.map((stage) => {
    const approverMemberIds = stage.approverMemberIds.filter((id) => knownMemberIds.has(id));
    if (approverMemberIds.length === stage.approverMemberIds.length) return stage;
    return { ...stage, approverMemberIds };
  });
}

export function nextUniqueSlug(base: string, stages: DraftPipelineStage[]): string {
  const existing = new Set(stages.map((stage) => stage.slug));
  if (!existing.has(base)) return base;
  let index = 2;
  while (existing.has(`${base}-${index}`)) index++;
  return `${base}-${index}`;
}

export function createDraftStage(stages: DraftPipelineStage[] = []): DraftPipelineStage {
  return {
    approverMemberIds: [],
    description: "",
    id: null,
    name: "New stage",
    promptTemplateMd: "",
    slug: nextUniqueSlug("new-stage", stages),
  };
}

export function appendDraftStage(stages: DraftPipelineStage[]): DraftPipelineStage[] {
  return [...stages, createDraftStage(stages)];
}

export function updateDraftStage(
  stages: DraftPipelineStage[],
  index: number,
  patch: Partial<DraftPipelineStage>,
): DraftPipelineStage[] {
  if (!stages[index]) return stages;
  const next = stages.slice();
  next[index] = { ...next[index], ...patch };
  return next;
}

export function moveDraftStage(
  stages: DraftPipelineStage[],
  index: number,
  direction: -1 | 1,
): DraftPipelineStage[] {
  const target = index + direction;
  if (target < 0 || target >= stages.length) return stages;
  const next = stages.slice();
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved!);
  return next;
}

export function removeDraftStage(
  stages: DraftPipelineStage[],
  index: number,
): DraftPipelineStage[] {
  return stages.filter((_, currentIndex) => currentIndex !== index);
}

export function validatePipelineDraft({
  name,
  stages,
}: {
  name: string;
  stages: DraftPipelineStage[];
}): PipelineDraftValidationResult {
  if (!name.trim()) {
    return {
      code: "missing-pipeline-name",
      message: "Pipeline name is required.",
      ok: false,
    };
  }

  if (stages.length === 0) {
    return {
      code: "empty-stage-list",
      message: "Pipeline must have at least one stage.",
      ok: false,
    };
  }

  for (const [index, stage] of stages.entries()) {
    if (!stage.name.trim()) {
      return {
        code: "missing-stage-name",
        message: "Every stage needs a name.",
        ok: false,
        stageIndex: index,
      };
    }

    if (!STAGE_SLUG_PATTERN.test(stage.slug)) {
      return {
        code: "invalid-stage-slug",
        message: `Stage slug "${stage.slug}" must be lowercase kebab-case.`,
        ok: false,
        stageIndex: index,
      };
    }
  }

  const slugs = new Set<string>();
  for (const [index, stage] of stages.entries()) {
    if (slugs.has(stage.slug)) {
      return {
        code: "duplicate-stage-slug",
        message: `Duplicate stage slug: ${stage.slug}`,
        ok: false,
        stageIndex: index,
      };
    }
    slugs.add(stage.slug);
  }

  return { ok: true };
}

export function isPipelineDraftValid(input: {
  name: string;
  stages: DraftPipelineStage[];
}): boolean {
  return validatePipelineDraft(input).ok;
}

export function PipelineVariableHelp() {
  return (
    <details className="ml-auto rounded-[6px] border border-border bg-surface-strong px-3 py-2 text-[12px] text-muted">
      <summary className="cursor-pointer text-foreground">Template variables</summary>
      <ul className="mt-2 space-y-0.5 font-mono">
        {PIPELINE_VARIABLE_HELP.map((variable) => (
          <li key={variable}>{variable}</li>
        ))}
      </ul>
      <p className="mt-2 leading-5">
        Use Mustache-style syntax: <code>{"{{var}}"}</code> for substitution and{" "}
        <code>{"{{#if var}}…{{/if}}"}</code> for conditional blocks. Replace{" "}
        <code>&lt;slug&gt;</code> with an earlier stage&apos;s slug to reference its artifact.
      </p>
    </details>
  );
}

export function StageRowEditor({
  canManage,
  compact = false,
  index,
  isFirst,
  isLast,
  onChange,
  onMoveDown,
  onMoveUp,
  onRemove,
  stage,
  workspaceMembers,
}: {
  canManage: boolean;
  compact?: boolean;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  onChange: (patch: Partial<DraftPipelineStage>) => void;
  onMoveDown: () => void;
  onMoveUp: () => void;
  onRemove: () => void;
  stage: DraftPipelineStage;
  workspaceMembers: WorkspaceMemberSummary[];
}) {
  const [showApprovers, setShowApprovers] = useState(false);
  const approverPreview =
    stage.approverMemberIds.length === 0
      ? "Owners and admins (default)"
      : `${stage.approverMemberIds.length} member${stage.approverMemberIds.length === 1 ? "" : "s"}`;

  function toggleApprover(memberId: string) {
    onChange({
      approverMemberIds: stage.approverMemberIds.includes(memberId)
        ? stage.approverMemberIds.filter((id) => id !== memberId)
        : [...stage.approverMemberIds, memberId],
    });
  }

  return (
    <li
      className={`relative rounded-[10px] border border-border bg-surface ${compact ? "p-4" : "p-5"}`}
    >
      <div className="absolute left-3 top-5 flex h-6 w-6 items-center justify-center rounded-full bg-surface-muted text-[11px] font-semibold text-muted">
        {index + 1}
      </div>
      <div className="space-y-4 pl-9">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <input
              type="text"
              value={stage.name}
              disabled={!canManage}
              onChange={(event) => onChange({ name: event.target.value })}
              className="ui-input min-w-[200px] flex-1 font-medium"
              placeholder="Stage name"
              maxLength={80}
            />
            <input
              type="text"
              value={stage.slug}
              disabled={!canManage}
              onChange={(event) => onChange({ slug: event.target.value })}
              className="ui-input w-[160px] font-mono text-[12px]"
              placeholder="kebab-slug"
              maxLength={64}
            />
          </div>
          {canManage ? (
            <div className="flex shrink-0 gap-1">
              <button
                type="button"
                className="ui-icon-button"
                onClick={onMoveUp}
                disabled={isFirst}
                aria-label="Move stage up"
              >
                ↑
              </button>
              <button
                type="button"
                className="ui-icon-button"
                onClick={onMoveDown}
                disabled={isLast}
                aria-label="Move stage down"
              >
                ↓
              </button>
              <button
                type="button"
                className="ui-icon-button text-danger"
                onClick={onRemove}
                aria-label="Remove stage"
              >
                ×
              </button>
            </div>
          ) : null}
        </div>

        <input
          type="text"
          value={stage.description}
          disabled={!canManage}
          onChange={(event) => onChange({ description: event.target.value })}
          className="ui-input"
          placeholder="One-line description shown in the pipeline rail"
          maxLength={500}
        />

        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium text-foreground">Prompt template</span>
          <textarea
            value={stage.promptTemplateMd}
            disabled={!canManage}
            onChange={(event) => onChange({ promptTemplateMd: event.target.value })}
            className={`ui-textarea font-mono text-[12px] ${compact ? "min-h-[120px]" : "min-h-[160px]"}`}
            placeholder="The prompt to run for this stage. Use {{session.title}} etc."
            maxLength={20000}
          />
        </label>

        <div>
          <button
            type="button"
            className="text-[12px] font-medium text-muted transition-colors hover:text-foreground"
            onClick={() => setShowApprovers((value) => !value)}
          >
            Approvers: {approverPreview} {showApprovers ? "▾" : "▸"}
          </button>
          {showApprovers ? (
            <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-[6px] border border-border bg-background p-2">
              {workspaceMembers.length === 0 ? (
                <li className="text-[12px] text-muted">No human members yet.</li>
              ) : (
                workspaceMembers.map((member) => {
                  const checked = stage.approverMemberIds.includes(member.id);
                  const id = `approver-${stage.id ?? "new"}-${index}-${member.id}`;
                  return (
                    <li key={member.id} className="flex items-center gap-2 text-[12px]">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!canManage}
                        onChange={() => toggleApprover(member.id)}
                        id={id}
                      />
                      <label htmlFor={id} className="flex-1 cursor-pointer">
                        <span className="font-medium text-foreground">
                          {member.fullName ?? member.email ?? member.id}
                        </span>{" "}
                        <span className="text-muted">({member.role})</span>
                      </label>
                    </li>
                  );
                })
              )}
            </ul>
          ) : null}
          <p className="mt-1 text-[11px] text-muted">
            Leave empty to default to workspace owners and admins.
          </p>
        </div>
      </div>
    </li>
  );
}

export function PipelineEditorControls({
  addLabel = "+ Add stage",
  canManage,
  isPending,
  onAddStage,
  onSave,
  saveDisabled = false,
  saveLabel = "Save pipeline",
  savingLabel = "Saving…",
}: {
  addLabel?: string;
  canManage: boolean;
  isPending: boolean;
  onAddStage: () => void;
  onSave: () => void;
  saveDisabled?: boolean;
  saveLabel?: string;
  savingLabel?: string;
}) {
  if (!canManage) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
      <button type="button" className="ui-button" onClick={onAddStage}>
        {addLabel}
      </button>
      <button
        type="button"
        className="ui-button-primary"
        disabled={isPending || saveDisabled}
        onClick={onSave}
      >
        {isPending ? savingLabel : saveLabel}
      </button>
    </div>
  );
}
