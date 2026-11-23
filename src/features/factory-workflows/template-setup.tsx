"use client";

import { useState } from "react";

import { SelectField } from "@/components/ui/select";
import type { WorkflowEditorCatalog } from "@/lib/factory-workflows/authoring-contracts";
import {
  materializeWorkflowTemplate,
  workflowCodeTemplateDefaultAttempts,
  type WorkflowTemplateRevision,
  type WorkflowTemplateRole,
} from "@/lib/factory-workflows/workflow-templates";

import { defaultDelegationPolicy, type WorkflowGraphDraft } from "./editor-graph";

type Profile = WorkflowEditorCatalog["profiles"][number];

function resolveRole(profile: Profile | undefined): WorkflowTemplateRole | undefined {
  if (!profile?.templateRole) return undefined;
  return {
    promptRevisionId: profile.templateRole.promptRevisionId,
    profile: { definitionRevisionId: profile.id, definitionDigest: profile.digest },
  };
}

export function TemplateSetup({
  template,
  choices,
  disabled,
  loadMore,
  apply,
}: {
  template: WorkflowTemplateRevision;
  choices: WorkflowEditorCatalog;
  disabled: boolean;
  loadMore: (catalog: "profiles" | "prompts") => void;
  apply: (graph: WorkflowGraphDraft) => void;
}) {
  const [foremanId, setForemanId] = useState("");
  const [implementationId, setImplementationId] = useState("");
  const [supportId, setSupportId] = useState("");
  const [reviewerId, setReviewerId] = useState("");
  const { id } = template;
  const needsForeman = id !== "scoped-fix";
  const needsReview = id !== "incident-analysis";
  const { templateSource, grant } = choices;
  const blocked =
    !templateSource || !grant
      ? "Activate a definition with a named agent, repository, and execution grant."
      : id === "product-delivery" && !templateSource.canDraftProductScope
        ? "Product delivery requires one specification stage and a delivery policy compatible with that stage."
        : needsReview && !templateSource.hasRequiredEvidence
          ? "Pin a delivery policy with required validation evidence before using this template."
          : null;
  const eligibleProfiles = choices.profiles.filter(({ templateRole }) => !!templateRole);
  const foremanProfiles = eligibleProfiles.filter(
    ({ templateRole }) => templateRole?.canRunForeman,
  );
  const foreman = resolveRole(foremanProfiles.find((profile) => profile.id === foremanId));
  const implementation = resolveRole(
    eligibleProfiles.find((profile) => profile.id === implementationId),
  );
  const supporting = resolveRole(eligibleProfiles.find((profile) => profile.id === supportId));
  const reviewer = choices.prompts.find((prompt) => prompt.id === reviewerId);
  const canApply =
    !blocked &&
    (!needsForeman || !!foreman) &&
    (!needsReview || (!!implementation && !!supporting && !!reviewer));

  function build() {
    if (!canApply || !templateSource || !grant) return;
    const base = {
      grant,
      budget:
        id === "incident-analysis"
          ? { ...defaultDelegationPolicy, maxChildren: 1, maxConcurrentChildren: 1 }
          : {
              ...defaultDelegationPolicy,
              maxAttempts: Math.max(
                defaultDelegationPolicy.maxAttempts,
                workflowCodeTemplateDefaultAttempts[id],
              ),
            },
      finalApprovers: {
        anyoneCanApprove: templateSource.anyoneCanApprove,
        memberIds: templateSource.approverMemberIds,
      },
    };
    if (id === "incident-analysis" && foreman) {
      apply(materializeWorkflowTemplate({ ...base, templateId: id, foreman }));
      return;
    }
    if (!implementation || !supporting || !reviewer) return;
    const code = {
      ...base,
      implementation,
      supporting,
      reviewer: { promptRevisionId: reviewer.id, ruleIds: ["scope", "validation"] },
    };
    if (id === "product-delivery" && foreman) {
      apply(materializeWorkflowTemplate({ ...code, templateId: id, foreman }));
    } else if (id === "scoped-fix") {
      apply(materializeWorkflowTemplate({ ...code, templateId: id }));
    }
  }

  const roleOptions = (profiles: Profile[]) =>
    profiles.map(({ id, label, templateRole }) => {
      const prompt = choices.prompts.find((choice) => choice.id === templateRole?.promptRevisionId);
      return { value: id, label: prompt ? `${prompt.label} · ${label}` : label };
    });
  const codeProfiles = roleOptions(eligibleProfiles);

  return (
    <section
      aria-labelledby="template-roles"
      className="grid gap-4 rounded-lg border border-border bg-sheet p-4"
    >
      <div>
        <h2 id="template-roles" className="font-medium">
          Configure template roles
        </h2>
        {templateSource ? (
          <p className="mt-1 text-sm text-muted">
            Preparation and approval policy · {templateSource.label}
          </p>
        ) : null}
      </div>
      {blocked ? <p className="text-sm text-muted">{blocked}</p> : null}
      {!blocked ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            {needsForeman ? (
              <SelectField
                label="Foreman profile"
                value={foremanId}
                onValueChange={setForemanId}
                fallbackLabel="Choose an activated Codex profile"
                options={roleOptions(foremanProfiles)}
                disabled={disabled}
                wrap
              />
            ) : null}
            {needsReview ? (
              <>
                <SelectField
                  label="Implementation profile"
                  value={implementationId}
                  onValueChange={setImplementationId}
                  fallbackLabel="Choose a required branch profile"
                  options={codeProfiles}
                  disabled={disabled}
                  wrap
                />
                <SelectField
                  label="Support profile"
                  value={supportId}
                  onValueChange={setSupportId}
                  fallbackLabel="Choose an optional branch profile"
                  options={codeProfiles}
                  disabled={disabled}
                  wrap
                />
                <SelectField
                  label="Reviewer prompt revision"
                  value={reviewerId}
                  onValueChange={setReviewerId}
                  fallbackLabel="Choose a reviewer prompt"
                  options={choices.prompts.map(({ id, label }) => ({ value: id, label }))}
                  disabled={disabled}
                  wrap
                />
              </>
            ) : null}
          </div>
          {eligibleProfiles.length === 0 || (needsForeman && foremanProfiles.length === 0) ? (
            <p className="text-sm text-muted">
              Load more profiles or activate a compatible role in this factory.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {choices.nextCursors.profiles ? (
              <button
                type="button"
                className="ui-button"
                disabled={disabled}
                onClick={() => loadMore("profiles")}
              >
                Load more execution profiles
              </button>
            ) : null}
            {needsReview && choices.nextCursors.prompts ? (
              <button
                type="button"
                className="ui-button"
                disabled={disabled}
                onClick={() => loadMore("prompts")}
              >
                Load more prompt revisions
              </button>
            ) : null}
            <button
              type="button"
              className="ui-button-primary"
              disabled={disabled || !canApply}
              onClick={build}
            >
              Apply template
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
