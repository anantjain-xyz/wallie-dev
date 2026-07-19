"use client";

import {
  useId,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import { MultiSelectField } from "@/components/ui/multi-select-field";
import { Status } from "@/components/ui/status";
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
  /** Stable client key for unsaved rows so slug follow-through does not remount the row. */
  key: string;
  name: string;
  promptTemplateMd: string;
  /** When true, Name changes no longer auto-update Slug. */
  slugManual: boolean;
  slug: string;
};

export type PipelineDraftValidationCode =
  | "duplicate-stage-slug"
  | "empty-stage-list"
  | "invalid-stage-ordering"
  | "invalid-stage-slug"
  | "missing-pipeline-name"
  | "missing-stage-approver"
  | "missing-stage-name"
  | "missing-stage-prompt";

export type PipelineDraftValidationIssue = {
  code: PipelineDraftValidationCode;
  field:
    | "pipeline-name"
    | "stage-approvers"
    | "stage-list"
    | "stage-name"
    | "stage-prompt"
    | "stage-slug";
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
/** Matches `stageInputSchema.slug.max(64)` on the pipeline API. */
export const STAGE_SLUG_MAX_LENGTH = 64;

export const PIPELINE_VARIABLE_HELP = [
  "{{session.title}}",
  "{{session.prompt}}",
  "{{attempt.number}}",
  "{{attempt.feedback}}",
  "{{artifact.previousStages.<slug>}}",
] as const;

export function slugifyStageName(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return truncateSlugBase(slug || "stage", STAGE_SLUG_MAX_LENGTH);
}

/** Trim a slug candidate to `maxLen` without leaving a trailing hyphen. */
export function truncateSlugBase(base: string, maxLen: number): string {
  if (maxLen < 1) return "s";
  if (base.length <= maxLen) return base;
  const truncated = base.slice(0, maxLen).replace(/-+$/, "");
  return truncated || "stage".slice(0, maxLen);
}

export function stageToDraft(stage: PipelineStage): DraftPipelineStage {
  return {
    approverMemberIds: stage.approverMemberIds,
    description: stage.description,
    id: stage.id,
    key: stage.id,
    name: stage.name,
    promptTemplateMd: stage.promptTemplateMd,
    slug: stage.slug,
    slugManual: true,
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
  const primary = truncateSlugBase(base, STAGE_SLUG_MAX_LENGTH);
  if (!existing.has(primary)) return primary;
  let index = 2;
  while (true) {
    const suffix = `-${index}`;
    const candidate = `${truncateSlugBase(base, STAGE_SLUG_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!existing.has(candidate)) return candidate;
    index++;
  }
}

export function createDraftStage(stages: DraftPipelineStage[] = []): DraftPipelineStage {
  const name = "New stage";
  return {
    approverMemberIds: [],
    description: "",
    id: null,
    key: `new-${crypto.randomUUID()}`,
    name,
    promptTemplateMd: "",
    slug: nextUniqueSlug(slugifyStageName(name), stages),
    slugManual: false,
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

/** Apply a name change; for unlocked new stages, keep slug following name until manual edit. */
export function updateDraftStageName(
  stages: DraftPipelineStage[],
  index: number,
  name: string,
): DraftPipelineStage[] {
  const stage = stages[index];
  if (!stage) return stages;
  if (stage.id !== null || stage.slugManual) {
    return updateDraftStage(stages, index, { name });
  }
  const others = stages.filter((_, currentIndex) => currentIndex !== index);
  return updateDraftStage(stages, index, {
    name,
    slug: nextUniqueSlug(slugifyStageName(name), others),
  });
}

export function updateDraftStageSlug(
  stages: DraftPipelineStage[],
  index: number,
  slug: string,
): DraftPipelineStage[] {
  const stage = stages[index];
  if (!stage || stage.id !== null) return stages;
  return updateDraftStage(stages, index, { slug, slugManual: true });
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

export function reorderDraftStage(
  stages: DraftPipelineStage[],
  fromIndex: number,
  toIndex: number,
): DraftPipelineStage[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= stages.length ||
    toIndex >= stages.length
  ) {
    return stages;
  }
  const next = stages.slice();
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved!);
  return next;
}

export function removeDraftStage(
  stages: DraftPipelineStage[],
  index: number,
): DraftPipelineStage[] {
  return stages.filter((_, currentIndex) => currentIndex !== index);
}

/**
 * Element id to focus after a stage row is removed (post-removal indices).
 * Empty pipeline → Add stage; otherwise the row that occupies the removed slot
 * (or the new last row when the last stage was removed).
 */
export function focusElementIdAfterStageRemoval(stageCount: number, removedIndex: number): string {
  const remaining = stageCount - 1;
  if (remaining <= 0) return "pipeline-add-stage";
  return `pipeline-stage-${Math.min(removedIndex, remaining - 1)}-name`;
}

/**
 * Resolve a still-mounted focus target before React unmounts the removed row.
 * Prefer the next surviving row (it will shift into the removed index); else the
 * previous row; else Add stage. Never return the row about to unmount.
 */
export function resolveFocusAfterStageRemoval(
  stageCount: number,
  removedIndex: number,
): HTMLElement | null {
  if (stageCount <= 1) {
    return document.getElementById("pipeline-add-stage");
  }
  const survivorDomIndex = removedIndex < stageCount - 1 ? removedIndex + 1 : removedIndex - 1;
  return (
    document.getElementById(`pipeline-stage-${survivorDomIndex}-name`) ??
    document.getElementById("pipeline-add-stage")
  );
}

export function stageDisplayName(stage: DraftPipelineStage, index: number): string {
  const trimmed = stage.name.trim();
  return trimmed || `Stage ${index + 1}`;
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

  const seenIds = new Set<string>();
  for (const [index, stage] of stages.entries()) {
    const label = stageDisplayName(stage, index);

    if (stage.id) {
      if (seenIds.has(stage.id)) {
        issues.push({
          code: "invalid-stage-ordering",
          field: "stage-list",
          message: `${label} appears more than once in the pipeline order.`,
          stageIndex: index,
        });
      }
      seenIds.add(stage.id);
    }

    if (!stage.name.trim()) {
      issues.push({
        code: "missing-stage-name",
        field: "stage-name",
        message: `${label} needs a name.`,
        stageIndex: index,
      });
    }

    if (!STAGE_SLUG_PATTERN.test(stage.slug) || stage.slug.length > STAGE_SLUG_MAX_LENGTH) {
      issues.push({
        code: "invalid-stage-slug",
        field: "stage-slug",
        message:
          stage.slug.length > STAGE_SLUG_MAX_LENGTH
            ? `${label} slug must be at most ${STAGE_SLUG_MAX_LENGTH} characters.`
            : `${label} slug must use lowercase letters, numbers, and single hyphens.`,
        stageIndex: index,
      });
    }

    if (!stage.promptTemplateMd.trim()) {
      issues.push({
        code: "missing-stage-prompt",
        field: "stage-prompt",
        message: `${label} needs a prompt template.`,
        stageIndex: index,
      });
    }

    if (stage.approverMemberIds.length === 0) {
      issues.push({
        code: "missing-stage-approver",
        field: "stage-approvers",
        message: `${label} needs at least one approver.`,
        stageIndex: index,
      });
    }
  }

  const slugs = new Set<string>();
  for (const [index, stage] of stages.entries()) {
    if (slugs.has(stage.slug)) {
      const label = stageDisplayName(stage, index);
      issues.push({
        code: "duplicate-stage-slug",
        field: "stage-slug",
        message: `${label} slug must be unique; "${stage.slug}" is already used.`,
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
  if (issue.field === "stage-list") {
    return issue.stageIndex === undefined
      ? "pipeline-add-stage"
      : `pipeline-stage-${issue.stageIndex}`;
  }
  if (issue.stageIndex === undefined) return null;
  const fieldSuffix =
    issue.field === "stage-name"
      ? "name"
      : issue.field === "stage-slug"
        ? "slug"
        : issue.field === "stage-prompt"
          ? "prompt"
          : issue.field === "stage-approvers"
            ? "approvers"
            : "name";
  return `pipeline-stage-${issue.stageIndex}-${fieldSuffix}`;
}

export function fieldErrorsForStage(
  validation: PipelineDraftValidationResult,
  index: number,
): StageFieldErrors | undefined {
  if (validation.ok) return undefined;
  const forStage = validation.issues.filter((issue) => issue.stageIndex === index);
  if (forStage.length === 0) return undefined;
  return {
    approvers: forStage.find((issue) => issue.field === "stage-approvers")?.message,
    name: forStage.find((issue) => issue.field === "stage-name")?.message,
    prompt: forStage.find((issue) => issue.field === "stage-prompt")?.message,
    slug: forStage.find((issue) => issue.field === "stage-slug")?.message,
  };
}

export function serializePipelineDraft(input: {
  name: string;
  operatingRules: string;
  stages: DraftPipelineStage[];
}): string {
  return JSON.stringify({
    name: input.name,
    operatingRules: input.operatingRules,
    stages: input.stages.map((stage) => ({
      approverMemberIds: stage.approverMemberIds,
      description: stage.description,
      id: stage.id,
      name: stage.name,
      promptTemplateMd: stage.promptTemplateMd,
      slug: stage.slug,
    })),
  });
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

export function PipelineStageOrderPreview({ stages }: { stages: DraftPipelineStage[] }) {
  if (stages.length === 0) {
    return (
      <p className="text-sm text-muted">
        Add stages to preview pipeline order and status treatment.
      </p>
    );
  }

  return (
    <nav
      aria-label="Pipeline order preview"
      className="rounded-[6px] border border-border bg-sheet p-3"
    >
      <p className="mb-2 text-[13px] font-medium text-foreground">Order preview</p>
      <ol className="flex flex-wrap gap-2">
        {stages.map((stage, index) => {
          const label = stageDisplayName(stage, index);
          const previewStatus =
            stages.length === 1
              ? { label: "Current", value: "awaiting_review" as const }
              : index === 0
                ? { label: "Complete", value: "complete" as const }
                : index === 1
                  ? { label: "Current", value: "awaiting_review" as const }
                  : { label: "Upcoming", value: "upcoming" as const };
          return (
            <li key={`${stage.id ?? "new"}-${index}`}>
              <span className="inline-flex items-center gap-2 rounded-[6px] border border-border bg-background px-2.5 py-1.5 text-xs">
                <span className="font-medium text-foreground">
                  {index + 1}. {label}
                </span>
                <Status
                  compact
                  description={`Preview status for ${label} in position ${index + 1} of ${stages.length}.`}
                  label={previewStatus.label}
                  value={previewStatus.value}
                />
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function StageRowEditor({
  canManage,
  compact = false,
  dragIndex,
  errors = {},
  index,
  isFirst,
  isLast,
  onChangeName,
  onChangeSlug,
  onChange,
  onDragEnd,
  onDragOver,
  onDragStart,
  onDrop,
  onMoveDown,
  onMoveUp,
  onRemove,
  onRemoveRequest,
  stage,
  totalStages,
  workspaceMembers,
}: {
  canManage: boolean;
  compact?: boolean;
  dragIndex: number | null;
  errors?: StageFieldErrors;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  onChange: (patch: Partial<DraftPipelineStage>) => void;
  onChangeName: (name: string) => void;
  onChangeSlug: (slug: string) => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent<HTMLLIElement>) => void;
  onDragStart: (index: number) => void;
  onDrop: (index: number) => void;
  onMoveDown: () => void;
  onMoveUp: () => void;
  onRemove: () => void;
  onRemoveRequest: () => void;
  stage: DraftPipelineStage;
  totalStages: number;
  workspaceMembers: WorkspaceMemberSummary[];
}) {
  const fieldPrefix = `pipeline-stage-${index}`;
  const displayName = stageDisplayName(stage, index);
  const positionLabel = `position ${index + 1} of ${totalStages}`;
  const slugReadOnly = stage.id !== null;
  const isDragging = dragIndex === index;
  const approverPreview =
    stage.approverMemberIds.length === 0
      ? "Select at least one approver"
      : `${stage.approverMemberIds.length} member${stage.approverMemberIds.length === 1 ? "" : "s"}`;
  const approverOptions = workspaceMembers.map((member) => ({
    description: member.role,
    label: member.fullName ?? member.email ?? member.id,
    value: member.id,
  }));

  function handleDragHandleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      onMoveUp();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      onMoveDown();
    }
  }

  return (
    <li
      className={`rounded-[6px] border border-border bg-sheet ${compact ? "p-4" : "p-5"} ${isDragging ? "opacity-60" : ""}`}
      onDragOver={onDragOver}
      onDrop={(event) => {
        event.preventDefault();
        onDrop(index);
      }}
    >
      <fieldset className="min-w-0 space-y-4" id={fieldPrefix}>
        <legend className="sr-only">
          {displayName}, {positionLabel}
        </legend>
        <div className="flex items-start gap-3">
          {canManage ? (
            <button
              aria-describedby={`${fieldPrefix}-drag-help`}
              aria-label={`Drag to reorder ${displayName}, currently ${positionLabel}. Use arrow keys to move.`}
              className="ui-icon-button mt-7 cursor-grab active:cursor-grabbing"
              draggable
              onDragEnd={onDragEnd}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", String(index));
                onDragStart(index);
              }}
              onKeyDown={handleDragHandleKeyDown}
              type="button"
            >
              ⋮⋮
            </button>
          ) : null}
          <div
            aria-hidden="true"
            className="mt-7 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-control-muted type-annotation font-semibold text-muted"
          >
            {index + 1}
          </div>
          <div className="min-w-0 flex-1 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-[minmax(200px,1fr)_minmax(160px,0.45fr)]">
                <PipelineTextField
                  description="Shown anywhere this stage appears in the pipeline."
                  disabled={!canManage}
                  error={errors.name}
                  id={`${fieldPrefix}-name`}
                  label="Name"
                  maxLength={80}
                  onChange={onChangeName}
                  placeholder="Plan"
                  value={stage.name}
                />
                <PipelineTextField
                  className="font-mono text-xs"
                  description={
                    slugReadOnly
                      ? "Locked after save so historical artifacts keep a stable identity. Focus to copy for prompt references."
                      : "Follows Name until you edit it. Use lowercase letters, numbers, and single hyphens."
                  }
                  disabled={!canManage}
                  error={errors.slug}
                  id={`${fieldPrefix}-slug`}
                  label="Slug"
                  maxLength={STAGE_SLUG_MAX_LENGTH}
                  onChange={onChangeSlug}
                  placeholder="plan"
                  readOnly={slugReadOnly}
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
                    aria-label={`Move ${displayName} up to position ${index} of ${totalStages}`}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="ui-icon-button"
                    onClick={onMoveDown}
                    disabled={isLast}
                    aria-label={`Move ${displayName} down to position ${index + 2} of ${totalStages}`}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="ui-icon-button text-danger"
                    id={`${fieldPrefix}-remove`}
                    onClick={() => {
                      if (stage.id) onRemoveRequest();
                      else onRemove();
                    }}
                    aria-label={`Remove ${displayName} from ${positionLabel}`}
                  >
                    ×
                  </button>
                </div>
              ) : null}
            </div>
            <p className="sr-only" id={`${fieldPrefix}-drag-help`}>
              Drag handle or use Move up and Move down to change stage order. Screen readers hear
              the new position after each move.
            </p>

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
              description="Choose who can approve this stage before the session advances."
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
        </div>
      </fieldset>
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
  readOnly = false,
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
  readOnly?: boolean;
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
        aria-readonly={readOnly ? true : undefined}
        className={`ui-input ${className ?? ""} ${error ? "border-danger" : ""} ${readOnly ? "bg-control-muted" : ""}`}
        disabled={disabled}
        id={id}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        readOnly={readOnly}
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

export function RemoveStageDialog({
  onConfirm,
  onOpenChange,
  open,
  restoreFocusRef,
  stageLabel,
}: {
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  stageLabel: string;
}) {
  return (
    <DestructiveConfirmationDialog
      actionLabel={`Remove ${stageLabel}`}
      description={
        <>
          Remove <strong>{stageLabel}</strong> from this pipeline? Existing artifacts stay
          unchanged. Sessions currently on this stage will block the save; other in-progress
          sessions may skip it when they advance.
        </>
      }
      onConfirm={onConfirm}
      onOpenChange={onOpenChange}
      open={open}
      pending={false}
      pendingLabel="Removing…"
      restoreFocusRef={restoreFocusRef}
      title={`Remove ${stageLabel}?`}
    />
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
      <button
        id="pipeline-add-stage"
        type="button"
        className="ui-button"
        disabled={isPending}
        onClick={onAddStage}
      >
        {addLabel}
      </button>
      <button
        type="button"
        className="ui-button-primary"
        disabled={isPending || saveDisabled}
        onClick={onSave}
      >
        <ActionButtonLabel idle={saveLabel} pending={isPending} pendingLabel={savingLabel} />
      </button>
    </div>
  );
}
