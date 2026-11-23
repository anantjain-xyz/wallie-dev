import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { PageContainer, PageHeader, PageSection } from "@/components/ui/page-shell";
import { SelectField } from "@/components/ui/select";
import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { resolveGovernanceFactorySelection } from "@/features/factories/factory-selection";
import { FactorySelector } from "@/features/factories/factory-selector";
import { AutomationDryRunPanel } from "@/features/factory-automations/automation-dry-run-panel";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
import {
  factoryAutomationListQuerySchema,
  factoryAutomationPathSchema,
  factoryAutomationReadQuerySchema,
  type FactoryAutomationDefinition,
} from "@/lib/factory-automations/contracts";
import type { AutomationDryRunEvent } from "@/lib/factory-automations/dry-run-contracts";
import { listFactoryAutomations, readFactoryAutomation } from "@/lib/factory-automations/service";
import {
  automationDryRunApiPath,
  workspaceAutomationPreviewPath,
  workspaceSettingsPath,
} from "@/lib/routes";

const selectionSchema = z
  .object({
    factory: factoryAutomationPathSchema.shape.factoryId.optional(),
    automation: factoryAutomationPathSchema.shape.automationId.optional(),
    revision: factoryAutomationReadQuerySchema.shape.revisionId,
    afterId: factoryAutomationListQuerySchema.shape.afterId,
  })
  .refine(({ automation, revision }) => !revision || !!automation);

function defaultEvent(definition: FactoryAutomationDefinition): AutomationDryRunEvent {
  const { trigger, filters } = definition;
  switch (trigger.kind) {
    case "schedule":
      return { kind: "schedule", scheduledFor: "" };
    case "pull-request":
      return {
        kind: "pull-request",
        repositoryId: trigger.repositoryId,
        action: "actions" in filters ? (filters.actions[0] ?? "opened") : "opened",
        baseBranch: "baseBranches" in filters ? (filters.baseBranches[0] ?? "") : "",
      };
    case "issue-state":
      return {
        kind: "issue-state",
        stateId: "stateIds" in filters ? (filters.stateIds[0] ?? "") : "",
        teamId: "teamIds" in filters ? (filters.teamIds[0] ?? null) : null,
        projectId: "projectIds" in filters ? (filters.projectIds[0] ?? null) : null,
      };
  }
}

export default async function AutomationPreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceSlug }, search] = await Promise.all([params, searchParams]);
  const query = selectionSchema.safeParse(search);
  if (!query.success) notFound();
  const [{ workspace, supabase }, factories] = await Promise.all([
    loadAuthenticatedWorkspaceContext(workspaceSlug),
    loadWorkspaceFactoryOptions(workspaceSlug),
  ]);
  const manageable = factories.filter(({ canManage, status }) => canManage && status === "active");
  const selection = resolveGovernanceFactorySelection(manageable, query.data.factory);
  if (selection.kind !== "factory") notFound();
  const factoryId = selection.factory.id;
  const scope = { workspaceId: workspace.id, factoryId };
  const list = await listFactoryAutomations(supabase, scope, query.data.afterId);
  if (!list) notFound();

  const automationId = query.data.automation ?? list.automations[0]?.automationId;
  const listed = list.automations.find((entry) => entry.automationId === automationId);
  const revisionId = query.data.revision;
  const automation =
    listed && (!revisionId || listed.revision.id === revisionId)
      ? listed
      : automationId
        ? await readFactoryAutomation(supabase, { ...scope, automationId }, { revisionId })
        : null;
  if (automationId && !automation) notFound();

  const currentRevisionId = automation?.revision.id;
  const available = automation && !listed ? [automation, ...list.automations] : list.automations;
  const pagePath = workspaceAutomationPreviewPath(workspaceSlug);
  const pageSelection = { factory: factoryId, afterId: query.data.afterId };

  return (
    <PageContainer className="max-w-4xl">
      <PageHeader
        title="Automation preview"
        eyebrowAsPlain
        eyebrow={
          <Link
            className="underline underline-offset-4"
            href={workspaceSettingsPath(workspaceSlug)}
          >
            Back to Settings
          </Link>
        }
        actionsRightOnDesktop
        actions={
          <FactorySelector
            factories={manageable}
            selectedValue={factoryId}
            resetParams={["automation", "revision", "afterId"]}
          />
        }
      />
      <div className="space-y-9">
        {automation ? (
          <>
            <PageSection title="Automation revision">
              <div className="ui-sheet min-w-0 space-y-4 p-4 sm:p-6">
                <form
                  action={pagePath}
                  method="get"
                  className="grid min-w-0 items-end gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <input type="hidden" name="factory" value={factoryId} />
                  {query.data.afterId ? (
                    <input type="hidden" name="afterId" value={query.data.afterId} />
                  ) : null}
                  <SelectField
                    label="Automation"
                    name="automation"
                    defaultValue={automation.automationId}
                    key={automation.automationId}
                    required
                    options={available.map(({ automationId, revision }) => ({
                      value: automationId,
                      label: revision.definition.name,
                    }))}
                    wrap
                  />
                  <button className="ui-button w-fit" type="submit">
                    Open automation
                  </button>
                </form>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium text-foreground">
                    Revision {automation.revision.revision}
                  </span>
                  <span className="text-muted">
                    {currentRevisionId === automation.publishedRevisionId
                      ? "Published"
                      : currentRevisionId === automation.draftRevisionId
                        ? "Draft"
                        : "Historical"}
                  </span>
                  {automation.archivedAt ? <span className="text-muted">Archived</span> : null}
                  {currentRevisionId !== automation.draftRevisionId ? (
                    <Link
                      className="ui-button"
                      href={workspaceAutomationPreviewPath(workspaceSlug, {
                        ...pageSelection,
                        automation: automation.automationId,
                      })}
                    >
                      View draft
                    </Link>
                  ) : null}
                  {automation.publishedRevisionId &&
                  currentRevisionId !== automation.publishedRevisionId ? (
                    <Link
                      className="ui-button"
                      href={workspaceAutomationPreviewPath(workspaceSlug, {
                        ...pageSelection,
                        automation: automation.automationId,
                        revision: automation.publishedRevisionId,
                      })}
                    >
                      View published revision
                    </Link>
                  ) : null}
                </div>
              </div>
            </PageSection>
            <AutomationDryRunPanel
              key={automation.revision.id}
              automationId={automation.automationId}
              defaults={defaultEvent(automation.revision.definition)}
              endpoint={automationDryRunApiPath(workspace.id, factoryId, automation.automationId)}
              revisionId={automation.revision.id}
            />
          </>
        ) : (
          <p className="ui-sheet p-5 text-sm text-muted">No saved automations on this page.</p>
        )}
        {query.data.afterId || list.nextCursor ? (
          <nav aria-label="Automation pages" className="flex flex-wrap gap-2">
            {query.data.afterId ? (
              <Link
                className="ui-button"
                href={workspaceAutomationPreviewPath(workspaceSlug, { factory: factoryId })}
              >
                First page
              </Link>
            ) : null}
            {list.nextCursor ? (
              <Link
                className="ui-button"
                href={workspaceAutomationPreviewPath(workspaceSlug, {
                  factory: factoryId,
                  afterId: list.nextCursor,
                })}
              >
                Next page
              </Link>
            ) : null}
          </nav>
        ) : null}
      </div>
    </PageContainer>
  );
}
