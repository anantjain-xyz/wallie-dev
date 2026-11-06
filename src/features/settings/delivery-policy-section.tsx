"use client";

import { useEffect, useId, useState, type FormEvent } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { readResponseJson, useApiAction } from "@/features/settings/use-api-action";
import {
  deliveryPolicyResponseSchema,
  deliveryRequirementsSchema,
  type DeliveryPolicy,
  type DeliveryRequirements,
} from "@/lib/delivery-policy/contracts";

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
  pipelineId,
  workspaceId,
}: {
  canManage: boolean;
  pipelineId: string;
  workspaceId: string;
}) {
  // A pipeline change must discard its predecessor's request, revision and draft.
  return (
    <DeliveryPolicyControls
      canManage={canManage}
      key={`${workspaceId}:${pipelineId}`}
      pipelineId={pipelineId}
      workspaceId={workspaceId}
    />
  );
}

function DeliveryPolicyControls({
  canManage,
  pipelineId,
  workspaceId,
}: {
  canManage: boolean;
  pipelineId: string;
  workspaceId: string;
}) {
  const descriptionId = useId();
  const [loadRevision, setLoadRevision] = useState(0);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [policy, setPolicy] = useState<DeliveryPolicy | null>(null);
  const [draft, setDraft] = useState(() => toDraft(newRequirements));
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
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
  }, [loadRevision, pipelineId, workspaceId]);

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
            error:
              "This policy changed while you were editing. Reload the saved policy before trying again.",
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
    successText:
      "Delivery policy revision saved. Earlier verification decisions must be refreshed.",
  });

  function reload() {
    setLoadState("loading");
    setMessage(null);
    setLoadRevision((revision) => revision + 1);
  }

  function update<K extends keyof PolicyDraft>(key: K, value: PolicyDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setMessage(null);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || conflict || loadState !== "ready") return;
    setMessage(null);
    void save.run();
  }

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
          <fieldset className="space-y-5" disabled={!canManage || save.isBusy || conflict}>
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
                disabled={save.isBusy || conflict}
                type="submit"
              >
                <ActionButtonLabel
                  idle={policy ? "Save new revision" : "Create delivery policy"}
                  pending={save.isBusy}
                  pendingLabel="Saving…"
                />
              </button>
            ) : null}
            <button
              className="ui-button-secondary"
              disabled={save.isBusy}
              onClick={reload}
              type="button"
            >
              Reload saved policy
            </button>
          </div>
        </form>
      ) : null}
      {loadState === "error" ? (
        <button className="ui-button-secondary" onClick={reload} type="button">
          Retry loading policy
        </button>
      ) : null}
      <InlineActionMessage message={message} />
    </section>
  );
}
