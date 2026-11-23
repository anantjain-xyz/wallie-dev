import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";

import { PageContainer, PageHeader, PageSection } from "@/components/ui/page-shell";
import { SelectField } from "@/components/ui/select";
import { AutomationAdmissionPanel } from "@/features/factory-automations/automation-admission-panel";
import { AutomationDryRunPanel } from "@/features/factory-automations/automation-dry-run-panel";
import { AutomationEditor } from "@/features/factory-automations/automation-editor";
import { automationTriggerLabels } from "@/features/factory-automations/automation-labels";
import { AutomationOccurrenceHistory } from "@/features/factory-automations/automation-occurrence-history";
import { AutomationSchedulePreview } from "@/features/factory-automations/automation-schedule-preview";
import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { resolveGovernanceFactorySelection } from "@/features/factories/factory-selection";
import { FactorySelector } from "@/features/factories/factory-selector";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
import {
  factoryAutomationListQuerySchema,
  factoryAutomationPathSchema,
  factoryAutomationReadQuerySchema,
  type FactoryAutomationDefinition,
} from "@/lib/factory-automations/contracts";
import type { AutomationDryRunEvent } from "@/lib/factory-automations/dry-run-contracts";
import { automationHistoryCursorSchema } from "@/lib/factory-automations/operator-contracts";
import {
  listFactoryAutomationOccurrenceHistory,
  loadFactoryAutomationSetup,
} from "@/lib/factory-automations/operator-data";
import {
  listFactoryAutomations,
  readAutomationAdmissionControl,
  readFactoryAutomation,
} from "@/lib/factory-automations/service";
import {
  automationDryRunApiPath,
  factoryAutomationApiPath,
  workspaceAutomationPreviewPath,
  workspaceSettingsPath,
} from "@/lib/routes";

const selectionSchema = z
  .object({
    factory: factoryAutomationPathSchema.shape.factoryId.optional(),
    automation: factoryAutomationPathSchema.shape.automationId.optional(),
    revision: factoryAutomationReadQuerySchema.shape.revisionId,
    afterId: factoryAutomationListQuerySchema.shape.afterId,
    mode: z.literal("new").optional(),
    historyBefore: automationHistoryCursorSchema.shape.recordedAt.optional(),
    historyBeforeId: automationHistoryCursorSchema.shape.id.optional(),
  })
  .refine(
    ({ automation, revision, mode, historyBefore, historyBeforeId }) =>
      (!revision || !!automation) &&
      (!mode || !automation) &&
      (historyBefore && historyBeforeId ? !!automation : !historyBefore && !historyBeforeId),
  );

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

export default async function AutomationSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceSlug }, search] = await Promise.all([params, searchParams]);
  const parsed = selectionSchema.safeParse(search);
  if (!parsed.success) notFound();
  const query = parsed.data;
  const [{ workspace, supabase }, factories] = await Promise.all([
    loadAuthenticatedWorkspaceContext(workspaceSlug),
    loadWorkspaceFactoryOptions(workspaceSlug),
  ]);
  const manageable = factories.filter(({ canManage, status }) => canManage && status === "active");
  const selection = resolveGovernanceFactorySelection(manageable, query.factory);
  if (selection.kind !== "factory") notFound();
  const factoryId = selection.factory.id;
  const scope = { workspaceId: workspace.id, factoryId };
  const list = await listFactoryAutomations(supabase, scope, query.afterId);
  if (!list) notFound();

  const automationId =
    query.mode === "new" ? undefined : (query.automation ?? list.automations[0]?.automationId);
  const listed = list.automations.find((entry) => entry.automationId === automationId);
  const automation =
    listed && (!query.revision || listed.revision.id === query.revision)
      ? listed
      : automationId
        ? await readFactoryAutomation(
            supabase,
            { ...scope, automationId },
            { revisionId: query.revision },
          )
        : null;
  if (automationId && !automation) notFound();

  const pagePath = workspaceAutomationPreviewPath(workspaceSlug);
  const pageSelection = { factory: factoryId, afterId: query.afterId };
  const ruleScope = automation ? { ...scope, automationId: automation.automationId } : null;
  const editMode =
    query.mode === "new" ||
    Boolean(
      automation && !automation.archivedAt && automation.revision.id === automation.draftRevisionId,
    );
  const activeRevision = Boolean(automation?.publishedRevisionId && !automation.archivedAt);
  const cursor =
    query.historyBefore && query.historyBeforeId
      ? { recordedAt: query.historyBefore, id: query.historyBeforeId }
      : undefined;
  const [setup, history, control] = await Promise.all([
    editMode
      ? loadFactoryAutomationSetup(supabase, scope)
          .then((options) => ({ options, failed: false }))
          .catch(() => ({ options: null, failed: true }))
      : null,
    ruleScope
      ? listFactoryAutomationOccurrenceHistory(supabase, ruleScope, cursor).catch(() => null)
      : null,
    ruleScope ? readAutomationAdmissionControl(supabase, ruleScope).catch(() => null) : null,
  ]);
  const available = automation && !listed ? [automation, ...list.automations] : list.automations;
  const next = history?.nextCursor;
  const historySelection = {
    ...pageSelection,
    automation: automation?.automationId,
    revision: query.revision,
  };
  const newHref = workspaceAutomationPreviewPath(workspaceSlug, { ...pageSelection, mode: "new" });

  return (
    <PageContainer className="max-w-5xl">
      <PageHeader
        title="Automations"
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
          <div className="flex flex-wrap items-end gap-2">
            <FactorySelector
              factories={manageable}
              selectedValue={factoryId}
              resetParams={[
                "automation",
                "revision",
                "afterId",
                "mode",
                "historyBefore",
                "historyBeforeId",
              ]}
            />
            {query.mode !== "new" ? (
              <Link href={newHref} className="ui-button ui-button-primary shrink-0">
                New rule
              </Link>
            ) : null}
          </div>
        }
      />
      <div className="space-y-8">
        <PageSection title="Rules">
          <div className="ui-sheet min-w-0 space-y-4 p-4 sm:p-6">
            {available.length ? (
              <form
                action={pagePath}
                method="get"
                className="grid min-w-0 items-end gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"
              >
                <input type="hidden" name="factory" value={factoryId} />
                {query.afterId ? (
                  <input type="hidden" name="afterId" value={query.afterId} />
                ) : null}
                <SelectField
                  label="Automation"
                  name="automation"
                  defaultValue={automation?.automationId}
                  key={automation?.automationId}
                  required
                  wrap
                  options={available.map(({ automationId, revision, archivedAt }) => ({
                    value: automationId,
                    label: `${revision.definition.name}${archivedAt ? " (archived)" : ""}`,
                  }))}
                />
                <button className="ui-button w-fit" type="submit">
                  Open automation
                </button>
              </form>
            ) : (
              <p className="text-sm text-muted">No saved automations on this page.</p>
            )}
            {automation ? (
              <>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
                  <h3 className="text-base font-semibold break-words">
                    {automation.revision.definition.name}
                  </h3>
                  <span className="text-muted">
                    {automationTriggerLabels[automation.revision.definition.trigger.kind]}
                  </span>
                  <span className="font-medium">Revision {automation.revision.revision}</span>
                  <span className="text-muted">
                    {automation.revision.id === automation.publishedRevisionId
                      ? "Published"
                      : automation.revision.id === automation.draftRevisionId
                        ? "Draft"
                        : "Historical"}
                  </span>
                  {automation.archivedAt ? <span className="text-muted">Archived</span> : null}
                  {automation.revision.id !== automation.draftRevisionId ? (
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
                  automation.revision.id !== automation.publishedRevisionId ? (
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
                <AutomationAdmissionPanel
                  key={automation.automationId}
                  activeRevision={activeRevision}
                  initial={control}
                  endpoint={`${factoryAutomationApiPath(workspace.id, factoryId, automation.automationId)}/admission-control`}
                />
              </>
            ) : null}
            {query.afterId || list.nextCursor ? (
              <nav aria-label="Automation pages" className="flex flex-wrap gap-2">
                {query.afterId ? (
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
        </PageSection>
        {editMode ? (
          <AutomationEditor
            key={automation?.automationId ?? factoryId}
            workspaceId={workspace.id}
            workspaceSlug={workspaceSlug}
            factoryId={factoryId}
            afterId={query.afterId}
            revisionSelected={query.revision !== undefined}
            initial={automation ?? undefined}
            setup={setup?.options ?? null}
            setupFailed={setup?.failed ?? false}
          />
        ) : null}
        {automation ? (
          <>
            {automation.revision.definition.trigger.kind === "schedule" ? (
              <Suspense
                fallback={
                  <p className="text-sm text-muted" role="status">
                    Loading schedule…
                  </p>
                }
              >
                <AutomationSchedulePreview
                  client={supabase}
                  input={{
                    ...scope,
                    automationId: automation.automationId,
                    revisionId: automation.revision.id,
                    ...automation.revision.definition.trigger,
                  }}
                />
              </Suspense>
            ) : null}
            <AutomationDryRunPanel
              key={automation.revision.id}
              automationId={automation.automationId}
              defaults={defaultEvent(automation.revision.definition)}
              endpoint={automationDryRunApiPath(workspace.id, factoryId, automation.automationId)}
              revisionId={automation.revision.id}
            />
            <AutomationOccurrenceHistory
              history={history}
              workspaceSlug={workspaceSlug}
              firstHref={
                cursor ? workspaceAutomationPreviewPath(workspaceSlug, historySelection) : undefined
              }
              nextHref={
                next
                  ? workspaceAutomationPreviewPath(workspaceSlug, {
                      ...historySelection,
                      historyBefore: next.recordedAt,
                      historyBeforeId: next.id,
                    })
                  : undefined
              }
            />
          </>
        ) : null}
      </div>
    </PageContainer>
  );
}
