"use client";

import { useMemo, useState } from "react";

import type { PipelineStage } from "@/features/sessions/types";
import type { FlashMessage } from "@/features/settings/settings-types";
import { useApiAction } from "@/features/settings/use-api-action";
import {
  LINEAR_ROUTE_KEYS,
  LINEAR_ROUTE_LABELS,
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

function joinStatuses(values: readonly string[]): string {
  return values.join(", ");
}

function splitStatuses(value: string): string[] {
  const statuses = value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return statuses;
}

export function LinearRoutingEditor({
  canManage,
  routing,
  setFlashMessage,
  stages,
  workspaceId,
}: LinearRoutingEditorProps) {
  const [draft, setDraft] = useState(() => ({
    landStageSlug: routing.landStageSlug,
    monitorStageSlug: routing.monitorStageSlug ?? "",
    reworkStageSlug: routing.reworkStageSlug,
    statusMappings: Object.fromEntries(
      LINEAR_ROUTE_KEYS.map((key) => [key, joinStatuses(routing.statusMappings[key])]),
    ) as Record<(typeof LINEAR_ROUTE_KEYS)[number], string>,
  }));

  const stageOptions = useMemo(() => stages.map((stage) => stage.slug), [stages]);

  const saveRouting = useApiAction<LinearRoutingResponse>({
    call: () =>
      fetch(`/api/workspaces/${workspaceId}/linear-routing`, {
        body: JSON.stringify({
          landStageSlug: draft.landStageSlug,
          monitorStageSlug: draft.monitorStageSlug.trim() || null,
          reworkStageSlug: draft.reworkStageSlug,
          statusMappings: Object.fromEntries(
            LINEAR_ROUTE_KEYS.map((key) => [key, splitStatuses(draft.statusMappings[key])]),
          ),
        }),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      }),
    errorText: "Linear routing save failed.",
    onSuccess: (payload) => {
      setDraft({
        landStageSlug: payload.routing.landStageSlug,
        monitorStageSlug: payload.routing.monitorStageSlug ?? "",
        reworkStageSlug: payload.routing.reworkStageSlug,
        statusMappings: Object.fromEntries(
          LINEAR_ROUTE_KEYS.map((key) => [key, joinStatuses(payload.routing.statusMappings[key])]),
        ) as Record<(typeof LINEAR_ROUTE_KEYS)[number], string>,
      });
    },
    setFlashMessage,
    successText: "Linear routing saved.",
  });

  function updateStatus(key: (typeof LINEAR_ROUTE_KEYS)[number], value: string) {
    setDraft((current) => ({
      ...current,
      statusMappings: { ...current.statusMappings, [key]: value },
    }));
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2">
        {LINEAR_ROUTE_KEYS.map((key) => (
          <label className="block space-y-1.5" key={key}>
            <span className="text-[13px] font-medium text-foreground">
              {LINEAR_ROUTE_LABELS[key]}
            </span>
            <input
              className="ui-input"
              disabled={!canManage}
              onChange={(event) => updateStatus(key, event.target.value)}
              value={draft.statusMappings[key]}
            />
          </label>
        ))}
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
