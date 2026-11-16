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
  deliveryPolicyResponseSchema,
  deliveryRequirementsSchema,
  type DeliveryPolicy,
  type DeliveryRequirements,
} from "@/lib/delivery-policy/contracts";
import {
  canRouteSettingsThroughFactoryDraft,
  type SettingsFactoryDefinitionState,
} from "@/lib/factory-definitions/settings-contracts";
import { projectSettingsDataWithFactoryDefinition } from "@/lib/factory-definitions/settings-projection";

type PolicyDraft = Omit<
  DeliveryRequirements,
  "requiredChecks" | "requiredEvidence" | "minimumApprovals" | "freshnessSeconds"
> & {
  requiredChecks: string;
  requiredEvidence: string;
  minimumApprovals: string;
  freshnessSeconds: string;
};

const newRequirements: DeliveryRequirements = {
  version: 1,
  deliveryMode: "code",
  requiredChecks: [],
  minimumApprovals: 0,
  requireCodeOwnerReview: false,
  requireResolvedThreads: true,
  requiredEvidence: [],
  freshnessSeconds: 3600,
  requireArtifactApprovalForDelivery: false,
};

function toDraft(requirements: DeliveryRequirements): PolicyDraft {
  return {
    ...requirements,
    requiredChecks: requirements.requiredChecks.join("\n"),
    requiredEvidence: requirements.requiredEvidence.join("\n"),
    minimumApprovals: String(requirements.minimumApprovals),
    freshnessSeconds: String(requirements.freshnessSeconds),
  };
}

function names(value: string): string[] {
  return value
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean);
}

function readPolicy(payload: unknown, workspaceId: string, pipelineId: string) {
  const parsed = deliveryPolicyResponseSchema.safeParse(payload);
  if (!parsed.success)
    throw new Error("The server returned an invalid delivery policy. Reload to try again.");
  const policy = parsed.data.policy;
  if (policy && (policy.workspaceId !== workspaceId || policy.pipelineId !== pipelineId)) {
    throw new Error("The returned policy does not belong to this pipeline. Reload to try again.");
  }
  return policy;
}

export function DeliveryPolicySection({
  canManage,
  factoryDefinition,
  pipelineId,
  workspaceId,
}: {
  canManage: boolean;
  factoryDefinition?: SettingsFactoryDefinitionState;
  pipelineId: string;
  workspaceId: string;
}) {
  // A pipeline change must discard its predecessor's request, revision and draft.
  return (
    <DeliveryPolicyControls
      canManage={canManage}
      factoryDefinition={factoryDefinition}
      key={`${workspaceId}:${pipelineId}`}
      pipelineId={pipelineId}
      workspaceId={workspaceId}
    />
  );
}

function DeliveryPolicyControls({
  canManage,
  factoryDefinition,
  pipelineId,
  workspaceId,
}: {
  canManage: boolean;
  factoryDefinition?: SettingsFactoryDefinitionState;
  pipelineId: string;
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

  const initialPolicy = hasServerFactoryState
    ? factoryState.deliveryPolicy && factoryState.deliveryPolicy.pipelineId === pipelineId
      ? factoryState.deliveryPolicy
      : null
    : null;

  const [loadRevision, setLoadRevision] = useState(0);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
    hasServerFactoryState ? "ready" : "loading",
  );
  const [policy, setPolicy] = useState<DeliveryPolicy | null>(initialPolicy);
  const [draft, setDraft] = useState(() => toDraft(initialPolicy?.requirements ?? newRequirements));
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const [conflict, setConflict] = useState(false);

  const baselineDraft = toDraft(policy?.requirements ?? newRequirements);
  const isDirty =
    draft.deliveryMode !== baselineDraft.deliveryMode ||
    draft.requiredChecks !== baselineDraft.requiredChecks ||
    draft.requiredEvidence !== baselineDraft.requiredEvidence ||
    draft.minimumApprovals !== baselineDraft.minimumApprovals ||
    draft.requireCodeOwnerReview !== baselineDraft.requireCodeOwnerReview ||
    draft.requireResolvedThreads !== baselineDraft.requireResolvedThreads ||
    draft.freshnessSeconds !== baselineDraft.freshnessSeconds ||
    draft.requireArtifactApprovalForDelivery !== baselineDraft.requireArtifactApprovalForDelivery;

  useEffect(() => {
    if (factoryRouted) {
      setFactorySectionDirty("delivery-policy", isDirty);
    }
  }, [factoryRouted, isDirty, setFactorySectionDirty]);

  const handleFactoryReload = useCallback(
    (payload: SettingsFactoryReloadPayload) => {
      const nextPolicy =
        payload.state.deliveryPolicy && payload.state.deliveryPolicy.pipelineId === pipelineId
          ? payload.state.deliveryPolicy
          : null;
      setPolicy(nextPolicy);
      setDraft(toDraft(nextPolicy?.requirements ?? newRequirements));
      setConflict(false);
      setLoadState("ready");
      setMessage(null);
    },
    [pipelineId],
  );

  useFactoryDefinitionReloadListener(workspaceId, hasServerFactoryState, handleFactoryReload);

  useEffect(() => {
    if (hasServerFactoryState) return;
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(
          `/api/workspaces/${workspaceId}/delivery-policy?pipelineId=${encodeURIComponent(pipelineId)}`,
          { cache: "no-store", signal: controller.signal },
        );
        const saved = readPolicy(await readResponseJson(response), workspaceId, pipelineId);
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
          text: error instanceof Error ? error.message : "Delivery policy could not be loaded.",
        });
      }
    }
    void load();
    return () => controller.abort();
  }, [hasServerFactoryState, loadRevision, pipelineId, workspaceId]);

  const save = useApiAction<{ policy: DeliveryPolicy }>({
    call: async () => {
      const parsed = deliveryRequirementsSchema.safeParse({
        ...draft,
        requiredChecks: names(draft.requiredChecks),
        requiredEvidence: names(draft.requiredEvidence),
        minimumApprovals: draft.minimumApprovals === "" ? null : Number(draft.minimumApprovals),
        freshnessSeconds: draft.freshnessSeconds === "" ? null : Number(draft.freshnessSeconds),
      });
      if (!parsed.success) {
        return Response.json(
          { error: parsed.error.issues[0]?.message ?? "Check policy fields." },
          { status: 400 },
        );
      }

      if (factoryRouted) {
        const result = await saveSettingsFactoryDraft(
          workspaceId,
          {
            kind: "delivery-policy",
            pipelineId,
            expectedPolicyRevision: factoryState.liveDeliveryPolicyRevision,
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
        return Response.json({ policy: result.data.deliveryPolicy });
      }

      const response = await fetch(`/api/workspaces/${workspaceId}/delivery-policy`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pipelineId,
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
    errorText: "Delivery policy could not be saved.",
    onSuccess: (payload) => {
      const saved = readPolicy(payload, workspaceId, pipelineId);
      if (!saved) throw new Error("The saved delivery policy was missing from the response.");
      setPolicy(saved);
      setDraft(toDraft(saved.requirements));
    },
    setFlashMessage: setMessage,
    successText: factoryRouted
      ? "Delivery policy saved to draft. Publish draft to apply to new sessions."
      : "Policy saved. Refresh earlier verifications.",
  });

  async function reload() {
    setMessage(null);
    if (hasServerFactoryState) {
      setLoadState("loading");
      try {
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
        const nextPolicy =
          result.data.state.deliveryPolicy &&
          result.data.state.deliveryPolicy.pipelineId === pipelineId
            ? result.data.state.deliveryPolicy
            : null;
        setPolicy(nextPolicy);
        setDraft(toDraft(nextPolicy?.requirements ?? newRequirements));
        setConflict(false);
        setLoadState("ready");
      } catch (error) {
        setLoadState("error");
        setMessage({
          kind: "error",
          text: error instanceof Error ? error.message : "Could not reload delivery policy.",
        });
      }
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
    factoryState.latestDraft?.definition.deliveryPolicyRevisionId !==
      factoryState.currentActivation?.definition.deliveryPolicyRevisionId;

  return (
    <section
      aria-labelledby={`${descriptionId}-title`}
      className="mt-8 space-y-5 border-t border-border pt-6"
    >
      <div className="max-w-2xl space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3 className="text-[15px] font-semibold text-foreground" id={`${descriptionId}-title`}>
            Delivery policy
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
          Define this pipeline’s requirements for verified PR readiness. Saving prepares the policy
          for verification; it does not mark existing sessions Ready. Merge stays manual.
        </p>
      </div>

      {loadState === "loading" ? (
        <p aria-busy="true" className="text-sm text-muted" role="status">
          Loading delivery policy…
        </p>
      ) : null}
      {loadState === "ready" ? (
        <form aria-describedby={descriptionId} className="space-y-5" onSubmit={submit}>
          {!canManage ? (
            <p className="text-[13px] text-muted">
              Only workspace owners and admins can change delivery policies.
            </p>
          ) : null}
          <fieldset className="space-y-5" disabled={!canManage || save.isBusy || effectiveConflict}>
            <legend className="sr-only">Delivery requirements</legend>
            <fieldset>
              <legend className="mb-2 text-[13px] font-medium text-foreground">
                Delivery mode
              </legend>
              <div className="flex flex-col gap-1 sm:flex-row sm:gap-6">
                {(["code", "analysis"] as const).map((mode) => (
                  <label
                    className="flex min-h-11 cursor-pointer items-center gap-2 text-sm"
                    key={mode}
                  >
                    <input
                      checked={draft.deliveryMode === mode}
                      className="h-4 w-4 accent-accent"
                      name={`${descriptionId}-mode`}
                      onChange={() => update("deliveryMode", mode)}
                      type="radio"
                      value={mode}
                    />
                    {mode === "code"
                      ? "Code delivery (canonical PR required)"
                      : "Analysis only (PR readiness not applicable)"}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-5 md:grid-cols-2">
              <label className="block space-y-1.5 text-[13px] font-medium text-foreground">
                <span>Required GitHub checks</span>
                <textarea
                  className="ui-textarea min-h-28 w-full"
                  onChange={(event) => update("requiredChecks", event.target.value)}
                  rows={3}
                  value={draft.requiredChecks}
                />
                <span className="block text-xs font-normal leading-5 text-muted">
                  One exact check name per line. Leave empty to require no named checks.
                </span>
              </label>
              <label className="block space-y-1.5 text-[13px] font-medium text-foreground">
                <span>Required validation evidence</span>
                <textarea
                  className="ui-textarea min-h-28 w-full"
                  onChange={(event) => update("requiredEvidence", event.target.value)}
                  rows={3}
                  value={draft.requiredEvidence}
                />
                <span className="block text-xs font-normal leading-5 text-muted">
                  One evidence requirement per line, such as unit-tests or browser-proof.
                </span>
              </label>
              <label className="block space-y-1.5 text-[13px] font-medium text-foreground">
                <span>Minimum GitHub approvals</span>
                <input
                  className="ui-input"
                  max={20}
                  min={0}
                  onChange={(event) => update("minimumApprovals", event.target.value)}
                  required
                  step={1}
                  type="number"
                  value={draft.minimumApprovals}
                />
              </label>
              <label className="block space-y-1.5 text-[13px] font-medium text-foreground">
                <span>Maximum evidence age (seconds)</span>
                <input
                  className="ui-input"
                  max={604800}
                  min={60}
                  onChange={(event) => update("freshnessSeconds", event.target.value)}
                  required
                  step={1}
                  type="number"
                  value={draft.freshnessSeconds}
                />
                <span className="block text-xs font-normal text-muted">
                  60 seconds to 7 days. Stale evidence must be refreshed.
                </span>
              </label>
            </div>
            <div className="space-y-1">
              {(
                [
                  ["requireCodeOwnerReview", "Require code owner review"],
                  ["requireResolvedThreads", "Require resolved blocking review threads"],
                  [
                    "requireArtifactApprovalForDelivery",
                    "Require artifact approval for final delivery",
                  ],
                ] as const
              ).map(([key, label]) => (
                <label
                  className="flex min-h-11 cursor-pointer items-center gap-3 text-[13px] font-medium text-foreground"
                  key={key}
                >
                  <input
                    checked={draft[key]}
                    className="h-4 w-4 shrink-0 accent-accent"
                    onChange={(event) => update(key, event.target.checked)}
                    type="checkbox"
                  />
                  {label}
                </label>
              ))}
              <p className="max-w-2xl text-xs leading-5 text-muted">
                Artifact approval is independent of PR readiness. Requiring it for final delivery
                does not make it a prerequisite for readiness.
              </p>
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
                        : "Create delivery policy"
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
