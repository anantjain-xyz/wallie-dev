import { useState, type FormEvent } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { EditableCombobox } from "@/components/ui/editable-combobox";
import { MetadataItem, MetadataList, PageSection } from "@/components/ui/page-shell";
import { AGENT_PROVIDER_LABELS } from "@/components/shared/agent-provider-options";
import type { FactoryEditorDocument } from "@/lib/factory-definitions/editor-contracts";
import {
  routingDecisionReasonLabels,
  routingPreviewRequestSchema,
  routingPreviewResponseSchema,
  type RoutingDecisionEvaluation,
} from "@/lib/model-routing/decision-contracts";

import {
  factoryEditorPost,
  FactoryEditorRequestError,
  fetchFactoryEditor,
} from "./editor-requests";

type PreviewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "result"; decision: RoutingDecisionEvaluation | null };

const selectedLabels = {
  primary: "Primary configuration selected",
  rule_fallback: "Rule fallback selected",
  unmatched_fallback: "Unmatched-task fallback selected",
};

const staleMessage =
  "The draft or active definition changed. Reload the definition and preview again.";

function PreviewDecision({ decision }: { decision: RoutingDecisionEvaluation | null }) {
  if (!decision) {
    return (
      <div className="space-y-1">
        <h3 className="text-sm font-medium">No routing policy</h3>
        <p className="type-secondary text-muted">
          Add a routing policy to the working definition and save it.
        </p>
      </div>
    );
  }
  const configuration = decision.configuration;
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">
        {decision.disposition === "selected" ? selectedLabels[decision.source] : "Escalated"}
      </h3>
      <p className="type-secondary text-muted">{routingDecisionReasonLabels[decision.reason]}</p>
      {decision.initialReason ? (
        <p className="type-secondary text-muted">
          Fallback reason · {routingDecisionReasonLabels[decision.initialReason]}
        </p>
      ) : null}
      <MetadataList className="grid gap-x-4 sm:grid-cols-2">
        {decision.taskClassSlug ? (
          <MetadataItem label="Task class slug" value={decision.taskClassSlug} />
        ) : null}
        {decision.ruleId ? (
          <MetadataItem label="Routing rule ID" value={decision.ruleId} monospace />
        ) : null}
        {configuration ? (
          <>
            <MetadataItem label="Model" value={configuration.modelKey} />
            <MetadataItem label="Harness" value={AGENT_PROVIDER_LABELS[configuration.harness]} />
            <MetadataItem
              label="Worker runtime"
              value={configuration.workerRuntime === "node" ? "Node.js" : "Cloudflare Workers"}
            />
          </>
        ) : null}
      </MetadataList>
    </div>
  );
}

export function FactoryRoutingPreview({
  activationNumber,
  api,
  disabled,
  disabledReason,
  draft,
}: {
  activationNumber: number;
  api: string;
  disabled: boolean;
  disabledReason: string | null;
  draft: FactoryEditorDocument | null;
}) {
  const [taskClassSlug, setTaskClassSlug] = useState(draft?.source.stages[0]?.slug ?? "");
  const [state, setState] = useState<PreviewState>({ kind: "idle" });
  const suggestions = new Set([
    ...(draft?.source.modelRouting?.taskClasses.map(({ slug }) => slug) ?? []),
    ...(draft?.source.stages.map(({ slug }) => slug) ?? []),
  ]);
  const query = taskClassSlug.trim().toLowerCase();
  const filter = suggestions.has(query) ? "" : query;
  const options = [...suggestions]
    .filter((slug) => slug.includes(filter))
    .map((slug) => ({ label: slug, value: slug }));
  const pending = state.kind === "loading";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || disabled || pending) return;
    const request = routingPreviewRequestSchema.safeParse({
      expectedActivationNumber: activationNumber,
      draftId: draft.id,
      taskClassSlug: taskClassSlug.trim(),
    });
    if (!request.success) {
      setState({
        kind: "error",
        message: "Enter a task class slug using lowercase letters, numbers, and hyphens.",
      });
      return;
    }

    setState({ kind: "loading" });
    try {
      const response = await fetchFactoryEditor(
        api + "/routing-preview",
        routingPreviewResponseSchema,
        factoryEditorPost(request.data),
      );
      if (
        response.draftId !== draft.id ||
        response.draftDigest !== draft.digest ||
        (response.decision && response.decision.taskClassSlug !== request.data.taskClassSlug)
      ) {
        setState({ kind: "error", message: staleMessage });
        return;
      }
      setState({ kind: "result", decision: response.decision });
    } catch (error) {
      const message =
        error instanceof FactoryEditorRequestError
          ? error.status === 409
            ? staleMessage
            : error.status === 403
              ? "Workspace admin access is required to preview routing."
              : error.message
          : "Could not preview routing. Try again.";
      setState({ kind: "error", message });
    }
  }

  return (
    <div aria-label="Routing preview" role="region">
      <PageSection anchorId="routing-preview" title="Routing preview">
        {!draft ? (
          <p className="type-secondary text-muted">Save a draft to preview routing.</p>
        ) : (
          <div className="min-w-0 space-y-4 rounded-md border border-border bg-surface p-4">
            <form
              className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"
              onSubmit={(event) => void submit(event)}
            >
              <label className="block min-w-0 space-y-1.5">
                <span className="text-[13px] font-medium">Task class slug</span>
                <EditableCombobox
                  disabled={disabled || pending}
                  listboxLabel="Task class suggestions"
                  maxLength={routingPreviewRequestSchema.shape.taskClassSlug.maxLength ?? undefined}
                  onValueChange={(value) => {
                    if (value === taskClassSlug) return;
                    setTaskClassSlug(value);
                    setState({ kind: "idle" });
                  }}
                  options={options}
                  required
                  selectedValue={taskClassSlug}
                  value={taskClassSlug}
                />
              </label>
              <button
                className="ui-button justify-self-start"
                disabled={disabled || pending}
                type="submit"
              >
                <ActionButtonLabel
                  idle="Preview routing"
                  pending={pending}
                  pendingLabel="Previewing routing…"
                />
              </button>
            </form>
            {disabledReason ? <p className="type-secondary text-muted">{disabledReason}</p> : null}
            {state.kind === "error" && !disabled ? (
              <p className="text-sm text-danger" role="alert">
                {state.message}
              </p>
            ) : null}
            <div role="status">
              {state.kind === "result" && !disabled ? (
                <PreviewDecision decision={state.decision} />
              ) : null}
            </div>
          </div>
        )}
      </PageSection>
    </div>
  );
}
