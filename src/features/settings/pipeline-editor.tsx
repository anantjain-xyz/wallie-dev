"use client";

import { useState, useTransition } from "react";

import type { PipelineStage, SessionPipeline } from "@/features/sessions/types";

type WorkspaceMemberSummary = {
  id: string;
  fullName: string | null;
  email: string | null;
  role: "owner" | "admin" | "member" | "agent";
};

type PipelineEditorProps = {
  canManage: boolean;
  pipeline: SessionPipeline | null;
  workspaceId: string;
  workspaceMembers: WorkspaceMemberSummary[];
};

// Editor model: id is null for newly added stages and gets assigned by the
// server on save. Position is implicit from array order — the server reorders.
type DraftStage = {
  approverMemberIds: string[];
  description: string;
  id: string | null;
  name: string;
  promptTemplateMd: string;
  slug: string;
};

const VARIABLE_HELP = [
  "{{session.title}}",
  "{{session.prompt}}",
  "{{attempt.number}}",
  "{{attempt.feedback}}",
  "{{artifact.previousStages.<slug>}}",
];

export function PipelineEditor({
  canManage,
  pipeline,
  workspaceId,
  workspaceMembers,
}: PipelineEditorProps) {
  const [name, setName] = useState(pipeline?.name ?? "Default");
  const [stages, setStages] = useState<DraftStage[]>(
    () => pipeline?.stages.map(stageToDraft) ?? [],
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

  function updateStage(index: number, patch: Partial<DraftStage>) {
    setStages((prev) => {
      const next = prev.slice();
      next[index] = { ...next[index]!, ...patch };
      return next;
    });
  }

  function moveStage(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= stages.length) return;
    setStages((prev) => {
      const next = prev.slice();
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved!);
      return next;
    });
  }

  function removeStage(index: number) {
    setStages((prev) => prev.filter((_, i) => i !== index));
  }

  function addStage() {
    setStages((prev) => [
      ...prev,
      {
        approverMemberIds: [],
        description: "",
        id: null,
        name: "New stage",
        promptTemplateMd: "",
        slug: nextUniqueSlug("new-stage", prev),
      },
    ]);
  }

  async function handleSave() {
    setError(null);
    if (stages.length === 0) {
      setError("Pipeline must have at least one stage.");
      return;
    }
    for (const stage of stages) {
      if (!stage.name.trim()) {
        setError("Every stage needs a name.");
        return;
      }
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(stage.slug)) {
        setError(`Stage slug "${stage.slug}" must be lowercase kebab-case.`);
        return;
      }
    }
    const slugs = new Set<string>();
    for (const stage of stages) {
      if (slugs.has(stage.slug)) {
        setError(`Duplicate stage slug: ${stage.slug}`);
        return;
      }
      slugs.add(stage.slug);
    }

    startTransition(async () => {
      const response = await fetch(`/api/workspaces/${workspaceId}/pipeline`, {
        body: JSON.stringify({ name, stages }),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Failed to save pipeline.");
        return;
      }
      setSavedAt(new Date());
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
            onChange={(e) => setName(e.target.value)}
            className="ui-input min-w-[240px]"
            maxLength={80}
          />
        </label>
        <details className="ml-auto rounded-[6px] border border-border bg-surface-strong px-3 py-2 text-[12px] text-muted">
          <summary className="cursor-pointer text-foreground">Template variables</summary>
          <ul className="mt-2 space-y-0.5 font-mono">
            {VARIABLE_HELP.map((v) => (
              <li key={v}>{v}</li>
            ))}
          </ul>
          <p className="mt-2 leading-5">
            Use Mustache-style syntax: <code>{"{{var}}"}</code> for substitution and{" "}
            <code>{"{{#if var}}…{{/if}}"}</code> for conditional blocks. Replace{" "}
            <code>&lt;slug&gt;</code> with an earlier stage&apos;s slug to reference its artifact.
          </p>
        </details>
      </div>

      <ol className="space-y-3">
        {stages.map((stage, index) => (
          <StageRow
            key={stage.id ?? `new-${index}`}
            canManage={canManage}
            index={index}
            isFirst={index === 0}
            isLast={index === stages.length - 1}
            onChange={(patch) => updateStage(index, patch)}
            onMoveDown={() => moveStage(index, 1)}
            onMoveUp={() => moveStage(index, -1)}
            onRemove={() => removeStage(index)}
            stage={stage}
            workspaceMembers={workspaceMembers}
          />
        ))}
      </ol>

      {canManage ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <button type="button" className="ui-button" onClick={addStage}>
            + Add stage
          </button>
          <button
            type="button"
            className="ui-button-primary"
            disabled={isPending}
            onClick={handleSave}
          >
            {isPending ? "Saving…" : "Save pipeline"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function StageRow({
  canManage,
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
  index: number;
  isFirst: boolean;
  isLast: boolean;
  onChange: (patch: Partial<DraftStage>) => void;
  onMoveDown: () => void;
  onMoveUp: () => void;
  onRemove: () => void;
  stage: DraftStage;
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
    <li className="relative rounded-[10px] border border-border bg-surface p-5">
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
              onChange={(e) => onChange({ name: e.target.value })}
              className="ui-input min-w-[200px] flex-1 font-medium"
              placeholder="Stage name"
              maxLength={80}
            />
            <input
              type="text"
              value={stage.slug}
              disabled={!canManage}
              onChange={(e) => onChange({ slug: e.target.value })}
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
          onChange={(e) => onChange({ description: e.target.value })}
          className="ui-input"
          placeholder="One-line description shown in the pipeline rail"
          maxLength={500}
        />

        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium text-foreground">Prompt template</span>
          <textarea
            value={stage.promptTemplateMd}
            disabled={!canManage}
            onChange={(e) => onChange({ promptTemplateMd: e.target.value })}
            className="ui-textarea min-h-[160px] font-mono text-[12px]"
            placeholder="The prompt to run for this stage. Use {{session.title}} etc."
            maxLength={20000}
          />
        </label>

        <div>
          <button
            type="button"
            className="text-[12px] font-medium text-muted transition-colors hover:text-foreground"
            onClick={() => setShowApprovers((v) => !v)}
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
                  return (
                    <li key={member.id} className="flex items-center gap-2 text-[12px]">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!canManage}
                        onChange={() => toggleApprover(member.id)}
                        id={`approver-${stage.id ?? "new"}-${index}-${member.id}`}
                      />
                      <label
                        htmlFor={`approver-${stage.id ?? "new"}-${index}-${member.id}`}
                        className="flex-1 cursor-pointer"
                      >
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

function stageToDraft(stage: PipelineStage): DraftStage {
  return {
    approverMemberIds: stage.approverMemberIds,
    description: stage.description,
    id: stage.id,
    name: stage.name,
    promptTemplateMd: stage.promptTemplateMd,
    slug: stage.slug,
  };
}

function nextUniqueSlug(base: string, stages: DraftStage[]): string {
  const existing = new Set(stages.map((s) => s.slug));
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}
