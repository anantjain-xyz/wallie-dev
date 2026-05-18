"use client";

import { useMemo, useState } from "react";

import type { PipelineStage } from "@/features/sessions/types";
import type { FlashMessage } from "@/features/settings/settings-types";
import { useApiAction } from "@/features/settings/use-api-action";
import {
  LINEAR_ROUTE_KEYS,
  LINEAR_ROUTE_LABELS,
  type LinearRouteKey,
  type LinearRoutingConfig,
} from "@/lib/linear-routing/contracts";

type LinearRoutingEditorProps = {
  canManage: boolean;
  routing: LinearRoutingConfig;
  setFlashMessage: (message: FlashMessage) => void;
  stages: PipelineStage[];
  workspaceId: string;
};

type LinearRoutingResponse = {
  routing: LinearRoutingConfig;
};

type LinearRoutingDraft = {
  landStageSlug: string;
  monitorStageSlug: string;
  reworkStageSlug: string;
  statusMappings: Record<LinearRouteKey, string>;
};

const LINEAR_ROUTE_ACTIONS: Record<Exclude<LinearRouteKey, "merging" | "rework">, string> = {
  backlog: "Ignore",
  canceled: "Cancel and archive session",
  done: "Archive session",
  in_progress: "Continue current stage",
  in_review: "Pause for review",
  todo: "Start current stage",
};

export function joinStatuses(values: readonly string[]): string {
  return values.join(", ");
}

export function splitStatuses(value: string): string[] {
  const statuses = value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return statuses;
}

export function validateLinearRoutingDraftStages(
  draft: Pick<LinearRoutingDraft, "landStageSlug" | "monitorStageSlug" | "reworkStageSlug">,
  stageOptions: readonly string[],
) {
  if (stageOptions.length === 0) {
    return "Load a default pipeline with at least one stage before saving Linear routing.";
  }

  const available = new Set(stageOptions);
  const requiredRoutes = [
    ["Rework stage", draft.reworkStageSlug],
    ["Land stage", draft.landStageSlug],
  ] as const;

  for (const [label, slug] of requiredRoutes) {
    if (!available.has(slug)) {
      return `${label} must match a current default pipeline stage.`;
    }
  }

  if (draft.monitorStageSlug && !available.has(draft.monitorStageSlug)) {
    return "Monitor stage must match a current default pipeline stage.";
  }

  return null;
}

function routingDraftFromConfig(routing: LinearRoutingConfig): LinearRoutingDraft {
  return {
    landStageSlug: routing.landStageSlug,
    monitorStageSlug: routing.monitorStageSlug ?? "",
    reworkStageSlug: routing.reworkStageSlug,
    statusMappings: Object.fromEntries(
      LINEAR_ROUTE_KEYS.map((key) => [key, joinStatuses(routing.statusMappings[key])]),
    ) as LinearRoutingDraft["statusMappings"],
  };
}

function buildRoutingPayload(draft: LinearRoutingDraft) {
  return {
    landStageSlug: draft.landStageSlug,
    monitorStageSlug: draft.monitorStageSlug.trim() || null,
    reworkStageSlug: draft.reworkStageSlug,
    statusMappings: Object.fromEntries(
      LINEAR_ROUTE_KEYS.map((key) => [key, splitStatuses(draft.statusMappings[key])]),
    ),
  };
}

function actionLabelForRoute(key: LinearRouteKey, draft: LinearRoutingDraft) {
  switch (key) {
    case "merging":
      return `Route to ${draft.landStageSlug} stage`;
    case "rework":
      return `Restart at ${draft.reworkStageSlug} stage`;
    default:
      return LINEAR_ROUTE_ACTIONS[key];
  }
}

export function LinearRoutingEditor({
  canManage,
  routing,
  setFlashMessage,
  stages,
  workspaceId,
}: LinearRoutingEditorProps) {
  return (
    <LinearRoutingControls
      canManage={canManage}
      routing={routing}
      setFlashMessage={setFlashMessage}
      stages={stages}
      workspaceId={workspaceId}
    />
  );
}

export function LinearRoutingControls({
  canManage,
  onSaved,
  routing,
  setFlashMessage,
  stages,
  workspaceId,
}: LinearRoutingEditorProps & {
  onSaved?: (routing: LinearRoutingConfig) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState(() => routingDraftFromConfig(routing));

  const stageOptions = useMemo(() => stages.map((stage) => stage.slug), [stages]);

  const saveRouting = useApiAction<LinearRoutingResponse>({
    call: () => {
      const stageError = validateLinearRoutingDraftStages(draft, stageOptions);
      if (stageError) {
        return Response.json({ error: stageError }, { status: 400 });
      }

      return fetch(`/api/workspaces/${workspaceId}/linear-routing`, {
        body: JSON.stringify(buildRoutingPayload(draft)),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      });
    },
    errorText: "Linear routing save failed.",
    onSuccess: async (payload) => {
      setDraft(routingDraftFromConfig(payload.routing));
      await onSaved?.(payload.routing);
    },
    setFlashMessage,
    successText: "Linear routing saved.",
  });

  function updateStatus(key: LinearRouteKey, value: string) {
    setDraft((current) => ({
      ...current,
      statusMappings: { ...current.statusMappings, [key]: value },
    }));
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="hidden grid-cols-[minmax(0,1fr)_2.5rem_minmax(0,0.75fr)] items-center gap-3 px-1 text-[11px] font-semibold uppercase text-muted md:grid">
          <span>Linear status names</span>
          <span className="sr-only">maps to</span>
          <span>Wallie action</span>
        </div>

        <div className="divide-y divide-border border-y border-border">
          {LINEAR_ROUTE_KEYS.map((key) => (
            <div
              className="grid gap-2 py-3 md:grid-cols-[minmax(0,1fr)_2.5rem_minmax(0,0.75fr)] md:items-center"
              key={key}
            >
              <label className="block min-w-0 space-y-1.5">
                <span className="block text-[12px] font-semibold uppercase text-muted md:hidden">
                  Linear status names
                </span>
                <span className="block text-[13px] font-medium text-foreground">
                  {LINEAR_ROUTE_LABELS[key]}
                </span>
                <input
                  aria-label={`${LINEAR_ROUTE_LABELS[key]} Linear status names`}
                  className="ui-input"
                  disabled={!canManage}
                  onChange={(event) => updateStatus(key, event.target.value)}
                  value={draft.statusMappings[key]}
                />
              </label>

              <div
                aria-hidden="true"
                className="flex h-6 items-center text-[12px] font-semibold text-muted md:justify-center"
              >
                -&gt;
              </div>

              <div className="min-w-0">
                <span className="block text-[12px] font-semibold uppercase text-muted md:hidden">
                  Wallie action
                </span>
                <p className="text-sm font-medium text-foreground">
                  {actionLabelForRoute(key, draft)}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <StageSelect
          disabled={!canManage}
          label="Rework stage"
          onChange={(value) => setDraft((current) => ({ ...current, reworkStageSlug: value }))}
          options={stageOptions}
          value={draft.reworkStageSlug}
        />
        <StageSelect
          disabled={!canManage}
          label="Land stage"
          onChange={(value) => setDraft((current) => ({ ...current, landStageSlug: value }))}
          options={stageOptions}
          value={draft.landStageSlug}
        />
        <StageSelect
          allowEmpty
          disabled={!canManage}
          label="Monitor stage"
          onChange={(value) => setDraft((current) => ({ ...current, monitorStageSlug: value }))}
          options={stageOptions}
          value={draft.monitorStageSlug}
        />
      </div>

      {canManage ? (
        <div className="flex justify-end border-t border-border pt-4">
          <button
            className="ui-button-primary"
            disabled={saveRouting.isBusy || stages.length === 0}
            onClick={() => void saveRouting.run()}
            type="button"
          >
            {saveRouting.isBusy ? "Saving…" : "Save routing"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function StageSelect({
  allowEmpty,
  disabled,
  label,
  onChange,
  options,
  value,
}: {
  allowEmpty?: boolean;
  disabled: boolean;
  label: string;
  onChange: (value: string) => void;
  options: string[];
  value: string;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[13px] font-medium text-foreground">{label}</span>
      <select
        className="ui-input"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {allowEmpty ? <option value="">None</option> : null}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}
