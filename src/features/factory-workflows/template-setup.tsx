"use client";

import type { WorkflowEditorCatalog } from "@/lib/factory-workflows/authoring-contracts";
import {
  materializeWorkflowTemplate,
  workflowCodeTemplateDefaultAttempts,
  type WorkflowTemplateRevision,
  type WorkflowTemplateRole,
} from "@/lib/factory-workflows/workflow-templates";

import { defaultDelegationPolicy, type WorkflowGraphDraft } from "./editor-graph";
import { WorkflowOptions } from "./editor-fields";
import type { TemplateRoles } from "./editor-recovery";

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
  roles,
  setRoles,
  settingsHref,
  loadMore,
  apply,
}: {
  template: WorkflowTemplateRevision;
  choices: WorkflowEditorCatalog;
  disabled: boolean;
  roles: TemplateRoles;
  setRoles: (roles: TemplateRoles) => void;
  settingsHref: string;
  loadMore: (catalog: "profiles" | "prompts") => void;
  apply: (graph: WorkflowGraphDraft) => void;
}) {
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
  const foreman = resolveRole(foremanProfiles.find((profile) => profile.id === roles.foreman));
  const implementation = resolveRole(
    eligibleProfiles.find((profile) => profile.id === roles.implementation),
  );
  const supporting = resolveRole(eligibleProfiles.find((profile) => profile.id === roles.support));
  const reviewer = choices.prompts.find((prompt) => prompt.id === roles.reviewer);
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

  const settings = (
    <a className="underline underline-offset-4" href={settingsHref}>
      Factory definition settings
    </a>
  );
  const roleOptions = [
    ...(needsForeman
      ? [
          {
            key: "foreman" as const,
            label: "Foreman profile",
            empty: "Choose an activated Codex profile",
            options: foremanProfiles,
          },
        ]
      : []),
    ...(needsReview
      ? [
          {
            key: "implementation" as const,
            label: "Implementation profile",
            empty: "Choose a required branch profile",
            options: eligibleProfiles,
          },
          {
            key: "support" as const,
            label: "Support profile",
            empty: "Choose an optional branch profile",
            options: eligibleProfiles,
          },
          {
            key: "reviewer" as const,
            label: "Reviewer prompt revision",
            empty: "Choose a reviewer prompt",
            options: choices.prompts,
          },
        ]
      : []),
  ];

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
      {blocked ? (
        <p className="text-sm text-muted">
          {blocked} Open {settings}.
        </p>
      ) : null}
      {!blocked ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            {roleOptions.map(({ key, label, empty, options }) => (
              <WorkflowOptions
                key={key}
                label={label}
                path={["template", key]}
                diagnostics={[]}
                options={options}
                empty={empty}
                disabled={disabled}
                value={roles[key]}
                change={(value) => setRoles({ ...roles, [key]: value })}
                reference={{
                  hasMore: !!choices.nextCursors[key === "reviewer" ? "prompts" : "profiles"],
                  detail: choices.profiles.find(({ id }) => id === roles[key])?.digest,
                }}
              />
            ))}
          </div>
          {eligibleProfiles.length === 0 || (needsForeman && foremanProfiles.length === 0) ? (
            <p className="text-sm text-muted">
              {choices.nextCursors.profiles ? "Load more profiles or activate" : "Activate"} a
              compatible role in {settings}.
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
