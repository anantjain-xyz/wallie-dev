"use client";

import { useMemo, useState } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { SelectField } from "@/components/ui/select";
import type { PipelineStage } from "@/features/sessions/types";
import { useRegisterSettingsDirtySource } from "@/features/settings/settings-dirty-registry";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import {
  LINEAR_ROUTE_KEYS,
  LINEAR_ROUTE_LABELS,
  type LinearRouteKey,
  type LinearRoutingConfig,
} from "@/lib/linear-routing/contracts";

type LinearRoutingEditorProps = {
  canManage: boolean;
  onSaved?: (routing: LinearRoutingConfig) => Promise<void> | void;
  routing: LinearRoutingConfig;
  stages: PipelineStage[];
  workspaceId: string;
};

type LinearRoutingResponse = {
  routing: LinearRoutingConfig;
};

type LinearRoutingDraft = {
  landStageSlug: string;
  reworkStageSlug: string;
  statusMappings: Record<LinearRouteKey, string>;
};

const LINEAR_ROUTE_ACTIONS: Record<
  Exclude<LinearRouteKey, "done" | "merging" | "rework">,
  string
> = {
  backlog: "Ignore",
  canceled: "Cancel and archive session",
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
  draft: Pick<LinearRoutingDraft, "landStageSlug" | "reworkStageSlug">,
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

  return null;
}

function routingDraftFromConfig(routing: LinearRoutingConfig): LinearRoutingDraft {
  return {
    landStageSlug: routing.landStageSlug,
    reworkStageSlug: routing.reworkStageSlug,
    statusMappings: Object.fromEntries(
      LINEAR_ROUTE_KEYS.map((key) => [key, joinStatuses(routing.statusMappings[key])]),
    ) as LinearRoutingDraft["statusMappings"],
  };
}

function buildRoutingPayload(draft: LinearRoutingDraft) {
  return {
    landStageSlug: draft.landStageSlug,
    reworkStageSlug: draft.reworkStageSlug,
    statusMappings: Object.fromEntries(
      LINEAR_ROUTE_KEYS.map((key) => [key, splitStatuses(draft.statusMappings[key])]),
    ),
  };
}

function isRoutingDraftDirty(draft: LinearRoutingDraft, routing: LinearRoutingConfig) {
  const baseline = routingDraftFromConfig(routing);
  if (
    draft.landStageSlug !== baseline.landStageSlug ||
    draft.reworkStageSlug !== baseline.reworkStageSlug
  ) {
    return true;
  }
  return LINEAR_ROUTE_KEYS.some(
    (key) => draft.statusMappings[key] !== baseline.statusMappings[key],
  );
}

function actionLabelForRoute(key: LinearRouteKey, draft: LinearRoutingDraft) {
  switch (key) {
    case "merging":
    case "done":
      return `Route to ${draft.landStageSlug} stage`;
    case "rework":
      return `Restart at ${draft.reworkStageSlug} stage`;
    default:
      return LINEAR_ROUTE_ACTIONS[key];
  }
}

export function LinearRoutingEditor({
  canManage,
  onSaved,
  routing,
  stages,
  workspaceId,
}: LinearRoutingEditorProps) {
  return (
    <LinearRoutingControls
      canManage={canManage}
      onSaved={onSaved}
      routing={routing}
      stages={stages}
      workspaceId={workspaceId}
    />
  );
}

export function LinearRoutingControls({
  canManage,
  onSaved,
  routing,
  stages,
  workspaceId,
}: LinearRoutingEditorProps) {
  const [draft, setDraft] = useState(() => routingDraftFromConfig(routing));
  const [feedbackMessage, setFeedbackMessage] = useState<FlashMessage | null>(null);

  useRegisterSettingsDirtySource("linear-routing", isRoutingDraftDirty(draft, routing), canManage);

  const stageOptions = useMemo(() => stages.map((stage) => stage.slug), [stages]);
  const stageSelectOptions = useMemo(
    () => stageOptions.map((option) => ({ label: option, value: option })),
    [stageOptions],
  );

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
    setFlashMessage: setFeedbackMessage,
    successText: "Linear routing saved.",
  });

  function updateDraft(updater: (current: LinearRoutingDraft) => LinearRoutingDraft) {
    setFeedbackMessage(null);
    setDraft(updater);
  }

  function updateStatus(key: LinearRouteKey, value: string) {
    updateDraft((current) => ({
      ...current,
      statusMappings: { ...current.statusMappings, [key]: value },
    }));
  }

  function handleSaveRouting() {
    setFeedbackMessage(null);
    void saveRouting.run();
  }

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="max-w-2xl space-y-1">
          <h3 className="text-[14px] font-semibold text-foreground">Status mappings</h3>
          <p className="text-[13px] leading-5 text-muted">
            Map the Linear status names your team uses to the Wallie behavior each status should
            trigger.
          </p>
        </div>

        <div className="space-y-2">
          <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,0.75fr)] gap-x-16 type-annotation font-semibold uppercase text-muted md:grid">
            <span>Linear status names</span>
            <span>Wallie action</span>
          </div>

          <div className="divide-y divide-border border-y border-border">
            {LINEAR_ROUTE_KEYS.map((key) => (
              <div
                className="grid gap-3 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,0.75fr)] md:items-center md:gap-x-16"
                key={key}
              >
                <label className="block min-w-0 space-y-1.5">
                  <span className="block text-xs font-semibold uppercase text-muted md:hidden">
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

                <div className="min-w-0 md:relative">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase text-muted md:hidden">
                    <span>Wallie action</span>
                    <span aria-hidden="true" className="text-[13px] font-medium normal-case">
                      →
                    </span>
                  </div>
                  <span
                    aria-hidden="true"
                    className="hidden text-[15px] font-medium text-muted md:absolute md:-left-10 md:top-1/2 md:block md:-translate-y-1/2"
                  >
                    →
                  </span>
                  <p className="text-sm font-medium text-foreground">
                    {actionLabelForRoute(key, draft)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="space-y-4 border-t border-border pt-6">
        <div className="max-w-2xl space-y-1">
          <h3 className="text-[14px] font-semibold text-foreground">Stage routing</h3>
          <p className="text-[13px] leading-5 text-muted">
            Choose the pipeline stages Wallie should use when Linear moves a session into rework or
            land.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <SelectField
            disabled={!canManage}
            label="Rework stage"
            onValueChange={(value) =>
              updateDraft((current) => ({ ...current, reworkStageSlug: value }))
            }
            options={stageSelectOptions}
            value={draft.reworkStageSlug}
          />
          <SelectField
            disabled={!canManage}
            label="Land stage"
            onValueChange={(value) =>
              updateDraft((current) => ({ ...current, landStageSlug: value }))
            }
            options={stageSelectOptions}
            value={draft.landStageSlug}
          />
        </div>
      </section>

      {canManage ? (
        <div className="flex flex-col items-end gap-2 border-t border-border pt-4">
          <button
            className="ui-button-primary"
            disabled={saveRouting.isBusy || stages.length === 0}
            onClick={handleSaveRouting}
            type="button"
          >
            <ActionButtonLabel
              idle="Save routing"
              pending={saveRouting.isBusy}
              pendingLabel="Saving…"
            />
          </button>
          <InlineActionMessage className="w-full" message={feedbackMessage} />
        </div>
      ) : null}
    </div>
  );
}
