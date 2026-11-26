"use client";

import { MetadataItem, MetadataList, PageSection } from "@/components/ui/page-shell";
import { ResourceIdDetails } from "@/features/settings/connector-settings/catalog";
import type { FactoryAutomationDefinition } from "@/lib/factory-automations/contracts";

import { automationPullRequestActionOptions, automationTriggerLabels } from "./automation-labels";
import { linearKinds, useAutomationLinearCatalog } from "./automation-linear-catalog";
import { linearLabel, linearValueLabel } from "./automation-resource-fields";

export function AutomationRevisionSummary({
  trigger,
  filters,
  target,
  grantVersion,
  names,
  revision,
}: Pick<FactoryAutomationDefinition, "trigger" | "filters" | "target"> & {
  grantVersion: number;
  names: { agent: string | null; workflow: string | null; repository: string | null };
  revision: number;
}) {
  const linear = useAutomationLinearCatalog();
  return (
    <PageSection
      title={`Revision ${revision} configuration`}
      tagline="Read-only settings for this exact revision."
    >
      <div className="ui-sheet min-w-0 space-y-4 p-4 sm:p-6">
        <MetadataList className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <MetadataItem label="Trigger" value={automationTriggerLabels[trigger.kind]} />
          {trigger.kind === "schedule" ? (
            <>
              <MetadataItem label="Cron expression" value={trigger.cron} monospace />
              <MetadataItem label="Time zone" value={trigger.timeZone} />
              <MetadataItem label="Filters" value="None" />
            </>
          ) : null}
          {trigger.kind === "pull-request" && "actions" in filters ? (
            <>
              <MetadataItem
                label="Repository"
                value={
                  <>
                    {names.repository ?? "Saved repository name unavailable"}
                    <ResourceIdDetails ids={[trigger.repositoryId]} label="Technical ID" />
                  </>
                }
              />
              <MetadataItem
                label="Pull request actions"
                value={
                  filters.actions
                    .map(
                      (action) =>
                        automationPullRequestActionOptions.find(({ value }) => value === action)
                          ?.label ?? action,
                    )
                    .join(", ") || "Any action"
                }
              />
              <MetadataItem
                label="Base branches"
                value={
                  <span className="break-words">
                    {filters.baseBranches.join(", ") || "Any branch"}
                  </span>
                }
              />
            </>
          ) : null}
          {trigger.kind === "issue-state" && "stateIds" in filters
            ? linearKinds.map((kind) => {
                const ids = filters[`${kind}Ids`];
                return (
                  <MetadataItem
                    key={kind}
                    label={`${linearLabel[kind]}s`}
                    value={
                      <>
                        <span className="break-words">
                          {ids.map((id) => linearValueLabel(linear, kind, id)).join(", ") ||
                            `Any ${kind}`}
                        </span>
                        <ResourceIdDetails ids={ids} label="Technical ID" />
                      </>
                    }
                  />
                );
              })
            : null}
        </MetadataList>
        <MetadataList className="grid gap-x-6 gap-y-3 border-t border-border pt-4 sm:grid-cols-2">
          <MetadataItem label="Assigned agent" value={names.agent ?? "Agent name unavailable"} />
          {target.kind === "workflow" ? (
            <MetadataItem
              label="Assigned workflow"
              value={names.workflow ?? "Workflow name unavailable"}
            />
          ) : null}
          <MetadataItem
            label="Target kind"
            value={target.kind === "agent" ? "Agent" : "Workflow"}
          />
          <MetadataItem label="Execution grant" value={`Version ${grantVersion}`} />
        </MetadataList>
        <ResourceIdDetails
          label="Exact target reference"
          ids={
            target.kind === "workflow"
              ? [
                  target.definitionRevisionId,
                  target.agentId,
                  target.workflowId,
                  target.workflowActivationId,
                ]
              : [target.definitionRevisionId, target.agentId]
          }
        />
      </div>
    </PageSection>
  );
}
