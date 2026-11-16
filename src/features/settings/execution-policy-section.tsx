"use client";

import { useCallback, useEffect, useId, useState, type FormEvent } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { Status } from "@/components/ui/status";
import {
  reloadSettingsFactoryDefinition,
  saveSettingsFactoryDraft,
  useFactoryDefinitionReloadListener,
  useFactoryDefinitionStore,
  type SettingsFactoryReloadPayload,
} from "@/features/settings/factory-definition-store";
import {
  dispatchSettingsDataChanged,
  dispatchSettingsEvent,
  SETTINGS_PIPELINE_CHANGED,
} from "@/features/settings/settings-island-events";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { readResponseJson, useApiAction } from "@/features/settings/use-api-action";
import {
  executionPolicyResponseSchema,
  executionRequirementsSchema,
  type ExecutionPolicy,
  type ExecutionRequirements,
} from "@/lib/execution-policy/contracts";
import {
  canRouteSettingsThroughFactoryDraft,
  type SettingsFactoryDefinitionState,
} from "@/lib/factory-definitions/settings-contracts";
import { projectSettingsDataWithFactoryDefinition } from "@/lib/factory-definitions/settings-projection";

type PolicyDraft = {
  version: 1;
  maxRepairAttempts: string;
  maxExecutionMinutes: string;
  maxTotalTokens: string;
  maxCostUsd: string;
};

const newRequirements: ExecutionRequirements = {
  version: 1,
  maxRepairAttempts: 3,
  maxExecutionMs: 3_600_000,
  maxTotalTokens: null,
  maxCostUsd: null,
};

function toDraft(requirements: ExecutionRequirements): PolicyDraft {
  return {
    version: requirements.version,
    maxRepairAttempts: String(requirements.maxRepairAttempts),
    maxExecutionMinutes: String(requirements.maxExecutionMs / 60_000),
    maxTotalTokens: requirements.maxTotalTokens === null ? "" : String(requirements.maxTotalTokens),
    maxCostUsd: requirements.maxCostUsd === null ? "" : String(requirements.maxCostUsd),
  };
}

function readPolicy(payload: unknown, workspaceId: string) {
  const parsed = executionPolicyResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("The server returned an invalid execution policy. Reload to try again.");
  }
  const policy = parsed.data.policy;
  if (policy && policy.workspaceId !== workspaceId) {
    throw new Error("The returned policy does not belong to this workspace. Reload to try again.");
  }
  return policy;
}

export function ExecutionPolicySection({
  canManage,
  factoryDefinition,
  workspaceId,
}: {
  canManage: boolean;
  factoryDefinition?: SettingsFactoryDefinitionState;
  workspaceId: string;
}) {
  return (
    <ExecutionPolicyControls
      canManage={canManage}
      factoryDefinition={factoryDefinition}
      key={workspaceId}
      workspaceId={workspaceId}
    />
  );
}

function ExecutionPolicyControls({
  canManage,
  factoryDefinition,
  workspaceId,
}: {
  canManage: boolean;
  factoryDefinition?: SettingsFactoryDefinitionState;
  workspaceId: string;
}) {
  const descriptionId = useId();
  const {
    conflict: factoryConflict,
    setDirty: setFactorySectionDirty,
    state: factoryState,
  } = useFactoryDefinitionStore(workspaceId, factoryDefinition);
  const hasServerFactoryState = Boolean(factoryDefinition);
  const factoryRouted = hasServerFactoryState && canRouteSettingsThroughFactoryDraft(factoryState);
  const initialPolicy = hasServerFactoryState ? factoryState.executionPolicy : null;

  const [loadRevision, setLoadRevision] = useState(0);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
    hasServerFactoryState ? "ready" : "loading",
  );
  const [policy, setPolicy] = useState<ExecutionPolicy | null>(initialPolicy);
  const [draft, setDraft] = useState(() => toDraft(initialPolicy?.requirements ?? newRequirements));
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const [conflict, setConflict] = useState(false);

  const baselineDraft = toDraft(policy?.requirements ?? newRequirements);
  const isDirty =
    draft.maxRepairAttempts !== baselineDraft.maxRepairAttempts ||
    draft.maxExecutionMinutes !== baselineDraft.maxExecutionMinutes ||
    draft.maxTotalTokens !== baselineDraft.maxTotalTokens ||
    draft.maxCostUsd !== baselineDraft.maxCostUsd;

  useEffect(() => {
    if (factoryRouted) {
      setFactorySectionDirty("execution-policy", isDirty);
    }
  }, [factoryRouted, isDirty, setFactorySectionDirty]);

  const handleFactoryReload = useCallback((payload: SettingsFactoryReloadPayload) => {
    const nextPolicy = payload.state.executionPolicy;
    setPolicy(nextPolicy);
    setDraft(toDraft(nextPolicy?.requirements ?? newRequirements));
    setConflict(false);
    setLoadState("ready");
    setMessage(null);
  }, []);

  useFactoryDefinitionReloadListener(workspaceId, hasServerFactoryState, handleFactoryReload);

  useEffect(() => {
    if (hasServerFactoryState) return;
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/workspaces/${workspaceId}/execution-policy`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const saved = readPolicy(await readResponseJson(response), workspaceId);
        if (controller.signal.aborted) return;
        setPolicy(saved);
        setDraft(toDraft(saved?.requirements ?? newRequirements));
        setConflict(false);
        setLoadState("ready");
      } catch (error) {
        if (controller.signal.aborted) return;
        setLoadState("error");
        setMessage({
          kind: "error",
          text: error instanceof Error ? error.message : "Execution policy could not be loaded.",
        });
      }
    }
    void load();
    return () => controller.abort();
  }, [hasServerFactoryState, loadRevision, workspaceId]);

  const save = useApiAction<{ policy: ExecutionPolicy }>({
    call: async () => {
      const parsed = executionRequirementsSchema.safeParse({
        version: draft.version,
        maxRepairAttempts: draft.maxRepairAttempts === "" ? null : Number(draft.maxRepairAttempts),
        maxExecutionMs:
          draft.maxExecutionMinutes === ""
            ? null
            : Math.round(Number(draft.maxExecutionMinutes) * 60_000),
        maxTotalTokens: draft.maxTotalTokens === "" ? null : Number(draft.maxTotalTokens),
        maxCostUsd: draft.maxCostUsd === "" ? null : Number(draft.maxCostUsd),
      });
      if (!parsed.success) {
        return Response.json(
          { error: parsed.error.issues[0]?.message ?? "Check execution policy fields." },
          { status: 400 },
        );
      }

      if (factoryRouted) {
        const result = await saveSettingsFactoryDraft(
          workspaceId,
          {
            kind: "execution-policy",
            expectedPolicyRevision: factoryState.liveExecutionPolicyRevision,
            requirements: parsed.data,
          },
          factoryState,
        );
        if (!result.ok) {
          if (result.status === 409) {
            setConflict(true);
            return Response.json({ error: result.error }, { status: 409 });
          }
          return Response.json(
            { error: result.diagnostics?.[0]?.message ?? result.error },
            { status: result.status },
          );
        }
        return Response.json({ policy: result.data.executionPolicy });
      }

      const response = await fetch(`/api/workspaces/${workspaceId}/execution-policy`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: policy?.revision ?? 0,
          requirements: parsed.data,
        }),
      });
      if (response.status === 409) {
        setConflict(true);
        return Response.json(
          {
            error: "Policy changed. Reload before retrying.",
          },
          { status: 409 },
        );
      }
      return response;
    },
    errorText: "Execution policy could not be saved.",
    onSuccess: (payload) => {
      const saved = readPolicy(payload, workspaceId);
      if (!saved) throw new Error("The saved execution policy was missing from the response.");
      setPolicy(saved);
      setDraft(toDraft(saved.requirements));
    },
    setFlashMessage: setMessage,
    successText: factoryRouted
      ? "Execution policy saved to draft. Publish draft to apply to new sessions."
      : "Execution policy revision saved. New sessions will use this revision.",
  });

  async function reload() {
    setMessage(null);
    if (hasServerFactoryState) {
      setLoadState("loading");
      const result = await reloadSettingsFactoryDefinition(workspaceId, factoryState);
      if (!result.ok) {
        setLoadState("error");
        setMessage({ kind: "error", text: result.error });
        return;
      }
      if (result.data.pipeline) {
        dispatchSettingsEvent(SETTINGS_PIPELINE_CHANGED, result.data.pipeline);
      }
      dispatchSettingsDataChanged(workspaceId, (current) => ({
        ...projectSettingsDataWithFactoryDefinition(current, result.data.state),
        ...(result.data.pipeline ? { pipeline: result.data.pipeline } : {}),
      }));
      const nextPolicy = result.data.state.executionPolicy;
      setPolicy(nextPolicy);
      setDraft(toDraft(nextPolicy?.requirements ?? newRequirements));
      setConflict(false);
      setLoadState("ready");
      return;
    }

    setLoadState("loading");
    setLoadRevision((revision) => revision + 1);
  }

  function update<K extends keyof PolicyDraft>(key: K, value: PolicyDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setMessage(null);
  }

  const effectiveConflict = conflict || (factoryRouted && Boolean(factoryConflict));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || effectiveConflict || loadState !== "ready") return;
    setMessage(null);
    void save.run();
  }

  const draftMatchesPolicy =
    factoryRouted &&
    Boolean(factoryState.latestDraft) &&
    factoryState.latestDraft?.definition.executionPolicyRevisionId !==
      factoryState.currentActivation?.definition.executionPolicyRevisionId;

  return (
    <section
      aria-labelledby={`${descriptionId}-title`}
      className="mt-8 space-y-5 border-t border-border pt-6"
    >
      <div className="max-w-2xl space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3 className="text-[15px] font-semibold text-foreground" id={`${descriptionId}-title`}>
            Execution policy
          </h3>
          <span className="text-xs text-muted">
            {policy ? `Revision ${policy.revision}` : loadState === "ready" ? "Not configured" : ""}
          </span>
          {factoryRouted && loadState === "ready" ? (
            isDirty ? (
              <Status compact label="Unsaved" value="needs_attention" />
            ) : effectiveConflict ? (
              <Status compact label="Conflict" value="blocked" />
            ) : draftMatchesPolicy ? (
              <Status compact label="Draft" value="in_progress" />
            ) : factoryState.currentActivation ? (
              <Status compact label="Published" value="healthy" />
            ) : null
          ) : null}
        </div>
        <p className="text-[13px] leading-5 text-muted" id={descriptionId}>
          Each saved revision pins to new sessions only; existing sessions keep their pinned
          revision. Repair-attempt and elapsed-time limits are always enforceable. Token and spend
          limits are reactive where provider telemetry permits; unavailable finalized measurements
          block later execution rather than counting them as zero.
        </p>
      </div>

      {loadState === "loading" ? (
        <p aria-busy="true" className="text-sm text-muted" role="status">
          Loading execution policy…
        </p>
      ) : null}
      {loadState === "ready" ? (
        <form aria-describedby={descriptionId} className="space-y-5" onSubmit={submit}>
          {!canManage ? (
            <p className="text-[13px] text-muted">
              Only workspace owners and admins can change execution policies.
            </p>
          ) : null}
          <fieldset className="space-y-5" disabled={!canManage || save.isBusy || effectiveConflict}>
            <legend className="sr-only">Execution limits</legend>
            <div className="grid gap-5 md:grid-cols-2">
              <label className="block space-y-1.5 text-[13px] font-medium text-foreground">
                <span>Maximum repair attempts</span>
                <input
                  className="ui-input"
                  max={100}
                  min={0}
                  onChange={(event) => update("maxRepairAttempts", event.target.value)}
                  required
                  step={1}
                  type="number"
                  value={draft.maxRepairAttempts}
                />
                <span className="block text-xs font-normal leading-5 text-muted">
                  Zero permits initial and normal stage executions, but no repair attempts.
                </span>
              </label>
              <label className="block space-y-1.5 text-[13px] font-medium text-foreground">
                <span>Maximum agent execution time (minutes)</span>
                <input
                  className="ui-input"
                  max={1440}
                  min={1 / 60}
                  onChange={(event) => update("maxExecutionMinutes", event.target.value)}
                  required
                  step="any"
                  type="number"
                  value={draft.maxExecutionMinutes}
                />
                <span className="block text-xs font-normal leading-5 text-muted">
                  One second to 24 hours, summed across actual agent runs and excluding review idle
                  time.
                </span>
              </label>
              <label className="block space-y-1.5 text-[13px] font-medium text-foreground">
                <span>Maximum total tokens (optional)</span>
                <input
                  className="ui-input"
                  max={1_000_000_000_000}
                  min={1}
                  onChange={(event) => update("maxTotalTokens", event.target.value)}
                  placeholder="No token limit"
                  step={1}
                  type="number"
                  value={draft.maxTotalTokens}
                />
                <span className="block text-xs font-normal leading-5 text-muted">
                  Leave blank for no token cap. Enforcement depends on provider telemetry.
                </span>
              </label>
              <label className="block space-y-1.5 text-[13px] font-medium text-foreground">
                <span>Maximum cost in USD (optional)</span>
                <input
                  className="ui-input"
                  max={1_000_000}
                  min={0.000001}
                  onChange={(event) => update("maxCostUsd", event.target.value)}
                  placeholder="No spend limit"
                  step="any"
                  type="number"
                  value={draft.maxCostUsd}
                />
                <span className="block text-xs font-normal leading-5 text-muted">
                  Leave blank for no cost cap. Missing finalized cost never counts as zero.
                </span>
              </label>
            </div>
          </fieldset>
          <div className="flex flex-wrap gap-3">
            {canManage ? (
              <button
                className="ui-button-primary"
                disabled={save.isBusy || effectiveConflict}
                type="submit"
              >
                <ActionButtonLabel
                  idle={
                    factoryRouted
                      ? "Save policy draft"
                      : policy
                        ? "Save new revision"
                        : "Create execution policy"
                  }
                  pending={save.isBusy}
                  pendingLabel="Saving…"
                />
              </button>
            ) : null}
            <button
              className="ui-button-secondary"
              disabled={save.isBusy}
              onClick={() => void reload()}
              type="button"
            >
              {factoryRouted ? "Reload saved definition" : "Reload saved policy"}
            </button>
          </div>
        </form>
      ) : null}
      {loadState === "error" ? (
        <button className="ui-button-secondary" onClick={() => void reload()} type="button">
          Retry loading policy
        </button>
      ) : null}
      <InlineActionMessage message={message} />
    </section>
  );
}
