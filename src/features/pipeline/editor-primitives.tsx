"use client";

import { useId } from "react";

import { MultiSelectField } from "@/components/ui/multi-select-field";
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

export type PipelineDraftValidationIssue = {
  code: PipelineDraftValidationCode;
  field: "pipeline-name" | "stage-list" | "stage-name" | "stage-slug";
  message: string;
  stageIndex?: number;
};

export type PipelineDraftValidationResult =
  | { ok: true }
  | {
      code: PipelineDraftValidationCode;
      field: PipelineDraftValidationIssue["field"];
      issues: PipelineDraftValidationIssue[];
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
  const issues: PipelineDraftValidationIssue[] = [];

  if (!name.trim()) {
    issues.push({
      code: "missing-pipeline-name",
      field: "pipeline-name",
      message: "Pipeline name is required.",
    });
  }

  if (stages.length === 0) {
    issues.push({
      code: "empty-stage-list",
      field: "stage-list",
      message: "Add at least one stage before saving the pipeline.",
    });
  }

  for (const [index, stage] of stages.entries()) {
    if (!stage.name.trim()) {
      issues.push({
        code: "missing-stage-name",
        field: "stage-name",
        message: `Stage ${index + 1} needs a name.`,
        stageIndex: index,
      });
    }

    if (!STAGE_SLUG_PATTERN.test(stage.slug)) {
      issues.push({
        code: "invalid-stage-slug",
        field: "stage-slug",
        message: `Stage ${index + 1} slug must use lowercase letters, numbers, and single hyphens.`,
        stageIndex: index,
      });
    }
  }

  const slugs = new Set<string>();
  for (const [index, stage] of stages.entries()) {
    if (slugs.has(stage.slug)) {
      issues.push({
        code: "duplicate-stage-slug",
        field: "stage-slug",
        message: `Stage ${index + 1} slug must be unique; "${stage.slug}" is already used.`,
        stageIndex: index,
      });
    }
    slugs.add(stage.slug);
  }

  const firstIssue = issues[0];
  if (firstIssue) return { ...firstIssue, issues, ok: false };

  return { ok: true };
}

export function isPipelineDraftValid(input: {
  name: string;
  stages: DraftPipelineStage[];
}): boolean {
  return validatePipelineDraft(input).ok;
}

export type StageFieldErrors = Partial<
  Record<"approvers" | "description" | "name" | "prompt" | "slug", string>
>;

export function pipelineValidationTargetId(issue: PipelineDraftValidationIssue): string | null {
  if (issue.field === "pipeline-name") return "pipeline-name";
  if (issue.field === "stage-list") return "pipeline-add-stage";
  if (issue.stageIndex === undefined) return null;
  return `pipeline-stage-${issue.stageIndex}-${issue.field === "stage-name" ? "name" : "slug"}`;
}

export function PipelineValidationSummary({
  validation,
}: {
  validation: PipelineDraftValidationResult;
}) {
  const headingId = useId();
  if (validation.ok) return null;

  return (
    <div
      aria-labelledby={headingId}
      className="rounded-[6px] border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] text-danger"
      role="alert"
    >
      <p className="font-semibold" id={headingId}>
        Fix {validation.issues.length === 1 ? "this field" : "these fields"} before saving
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {validation.issues.map((issue, issueIndex) => {
          const targetId = pipelineValidationTargetId(issue);
          return (
            <li key={`${issue.code}-${issue.stageIndex ?? "pipeline"}-${issueIndex}`}>
              {targetId ? (
                <a
                  className="underline underline-offset-2"
                  href={`#${targetId}`}
                  onClick={(event) => {
                    event.preventDefault();
                    document.getElementById(targetId)?.focus();
                  }}
                >
                  {issue.message}
                </a>
              ) : (
                issue.message
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function PipelineVariableHelp() {
  return (
    <details className="ml-auto rounded-[6px] border border-border bg-control-hover px-3 py-2 text-xs text-muted">
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

export function OperatingRulesField({
  canManage,
  compact = false,
  onChange,
  value,
}: {
  canManage: boolean;
  compact?: boolean;
  onChange: (value: string) => void;
  value: string;
}) {
  const fieldId = useId();
  const descriptionId = `${fieldId}-description`;
  return (
    <div className="block space-y-1.5">
      <label className="text-[13px] font-medium text-foreground" htmlFor={fieldId}>
        Operating rules
      </label>
      <textarea
        aria-describedby={descriptionId}
        id={fieldId}
        value={value}
        disabled={!canManage}
        onChange={(event) => onChange(event.target.value)}
        className={`ui-textarea font-mono text-xs ${compact ? "min-h-[120px]" : "min-h-[160px]"}`}
        placeholder="Shared rules prepended to every stage prompt. Use {{session.title}} etc."
        maxLength={20000}
      />
      <p className="type-annotation text-muted" id={descriptionId}>
        Prepended to every stage prompt in this pipeline — cross-cutting rules like autonomy, git
        safety, cleanup, and honest reporting.
      </p>
    </div>
  );
}

export function StageRowEditor({
  canManage,
  compact = false,
  errors = {},
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
  errors?: StageFieldErrors;
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
  const fieldPrefix = `pipeline-stage-${index}`;
  const approverPreview =
    stage.approverMemberIds.length === 0
      ? "Owners and admins (default)"
      : `${stage.approverMemberIds.length} member${stage.approverMemberIds.length === 1 ? "" : "s"}`;
  const approverOptions = workspaceMembers.map((member) => ({
    description: member.role,
    label: member.fullName ?? member.email ?? member.id,
    value: member.id,
  }));

  return (
    <li
      className={`relative rounded-[6px] border border-border bg-sheet ${compact ? "p-4" : "p-5"}`}
    >
      <div className="absolute left-3 top-5 flex h-6 w-6 items-center justify-center rounded-full bg-control-muted type-annotation font-semibold text-muted">
        {index + 1}
      </div>
      <div className="space-y-4 pl-9">
        <div className="flex items-start justify-between gap-3">
          <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-[minmax(200px,1fr)_minmax(160px,0.45fr)]">
            <PipelineTextField
              description="Shown anywhere this stage appears in the pipeline."
              disabled={!canManage}
              error={errors.name}
              id={`${fieldPrefix}-name`}
              label="Stage name"
              maxLength={80}
              onChange={(value) => onChange({ name: value })}
              placeholder="Plan"
              value={stage.name}
            />
            <PipelineTextField
              className="font-mono text-xs"
              description="Use lowercase letters, numbers, and single hyphens."
              disabled={!canManage}
              error={errors.slug}
              id={`${fieldPrefix}-slug`}
              label="Slug"
              maxLength={64}
              onChange={(value) => onChange({ slug: value })}
              placeholder="plan"
              value={stage.slug}
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

        <PipelineTextField
          description="A short explanation shown in the pipeline rail."
          disabled={!canManage}
          error={errors.description}
          id={`${fieldPrefix}-description`}
          label="Description"
          maxLength={500}
          onChange={(value) => onChange({ description: value })}
          placeholder="Define the work before implementation begins"
          value={stage.description}
        />

        <div className="block space-y-1.5">
          <label
            className="text-[13px] font-medium text-foreground"
            htmlFor={`${fieldPrefix}-prompt`}
          >
            Prompt template
          </label>
          <textarea
            aria-describedby={`${fieldPrefix}-prompt-description${errors.prompt ? ` ${fieldPrefix}-prompt-error` : ""}`}
            aria-invalid={errors.prompt ? true : undefined}
            id={`${fieldPrefix}-prompt`}
            value={stage.promptTemplateMd}
            disabled={!canManage}
            onChange={(event) => onChange({ promptTemplateMd: event.target.value })}
            className={`ui-textarea font-mono text-xs ${compact ? "min-h-[120px]" : "min-h-[160px]"} ${errors.prompt ? "border-danger" : ""}`}
            placeholder="The prompt to run for this stage. Use {{session.title}} etc."
            maxLength={20000}
          />
          <p className="type-annotation text-muted" id={`${fieldPrefix}-prompt-description`}>
            Tell the agent what to produce; template variables are available above.
          </p>
          {errors.prompt ? (
            <p className="text-xs font-medium text-danger" id={`${fieldPrefix}-prompt-error`}>
              {errors.prompt}
            </p>
          ) : null}
        </div>

        <MultiSelectField
          description="Leave empty to let workspace owners and admins approve this stage."
          disabled={!canManage}
          emptyMessage="No human members are available."
          error={errors.approvers}
          id={`${fieldPrefix}-approvers`}
          label="Approvers"
          onValuesChange={(approverMemberIds) => onChange({ approverMemberIds })}
          options={approverOptions}
          summary={approverPreview}
          values={stage.approverMemberIds}
        />
      </div>
    </li>
  );
}

function PipelineTextField({
  className,
  description,
  disabled,
  error,
  id,
  label,
  maxLength,
  onChange,
  placeholder,
  value,
}: {
  className?: string;
  description: string;
  disabled: boolean;
  error?: string;
  id: string;
  label: string;
  maxLength: number;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}) {
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  return (
    <div className="min-w-0 space-y-1.5">
      <label className="text-[13px] font-medium text-foreground" htmlFor={id}>
        {label}
      </label>
      <input
        aria-describedby={`${descriptionId}${error ? ` ${errorId}` : ""}`}
        aria-invalid={error ? true : undefined}
        className={`ui-input ${className ?? ""} ${error ? "border-danger" : ""}`}
        disabled={disabled}
        id={id}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type="text"
        value={value}
      />
      <p className="type-annotation text-muted" id={descriptionId}>
        {description}
      </p>
      {error ? (
        <p className="text-xs font-medium text-danger" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
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
      <button id="pipeline-add-stage" type="button" className="ui-button" onClick={onAddStage}>
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
