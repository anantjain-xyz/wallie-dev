import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, type ComponentProps, type ReactNode } from "react";
import { z } from "zod";

import {
  workspaceLocationForRoute,
  workspaceScopeOptions,
} from "@/components/app-shell/workspace-location";
import { WorkspaceScopeHandoff } from "@/components/app-shell/workspace-scope-context";
import { WorkspaceScopeRequired } from "@/components/app-shell/workspace-scope-required";
import { loadWorkspaceRouteScope } from "@/components/app-shell/workspace-scope.server";
import { BackLink } from "@/components/ui/back-link";
import { PageContainer, PageHeader, PageSection } from "@/components/ui/page-shell";
import { AutomationAdmissionPanel } from "@/features/factory-automations/automation-admission-panel";
import {
  AutomationDraftNavigation,
  AutomationFactoryPicker,
  AutomationRulePicker,
} from "@/features/factory-automations/automation-draft-navigation";
import { AutomationDryRunPanel } from "@/features/factory-automations/automation-dry-run-panel";
import { AutomationEditor } from "@/features/factory-automations/automation-editor";
import { automationTriggerLabels } from "@/features/factory-automations/automation-labels";
import { AutomationLinearCatalog } from "@/features/factory-automations/automation-linear-catalog";
import { AutomationOccurrenceHistory } from "@/features/factory-automations/automation-occurrence-history";
import { AutomationRevisionSummary } from "@/features/factory-automations/automation-revision-summary";
import {
  AutomationSchedulePreview,
  type AutomationScheduleEvidence,
} from "@/features/factory-automations/automation-schedule-preview";
import {
  isWorkspaceOperator,
  loadAuthenticatedWorkspaceContext,
} from "@/features/workspaces/authenticated-context";
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
  loadAutomationRepositories,
  loadAutomationRevisionNames,
  loadFactoryAutomationSetup,
} from "@/lib/factory-automations/operator-data";
import { previewFactoryAutomationSchedule } from "@/lib/factory-automations/schedule-service";
import {
  listFactoryAutomations,
  readAutomationAdmissionControl,
  readFactoryAutomation,
} from "@/lib/factory-automations/service";
import {
  automationDryRunApiPath,
  factoryAutomationApiPath,
  workspaceAutomationPreviewPath,
  workspaceFactoryDefinitionPath,
  workspaceSettingsPath,
} from "@/lib/routes";

const FACTORY_SWITCH_RESET_PARAMS = [
  "automation",
  "revision",
  "mode",
  "historyBefore",
  "historyBeforeId",
];

const selectionSchema = z
  .object({
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

function defaultEvent(
  definition: FactoryAutomationDefinition,
  scheduledFor = "",
): AutomationDryRunEvent {
  const { trigger, filters } = definition;
  switch (trigger.kind) {
    case "schedule":
      return { kind: "schedule", scheduledFor };
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

function UnavailableSelection({ href }: { href: string }) {
  return (
    <PageContainer className="max-w-5xl">
      <PageHeader title="Automations" />
      <PageSection title="Selection unavailable">
        <div className="ui-sheet space-y-3 p-4 sm:p-6">
          <p className="text-sm text-muted">
            This selection is unavailable. Choose a factory or rule you can manage.
          </p>
          <BackLink className="ui-button" href={href}>
            Back to automations
          </BackLink>
        </div>
      </PageSection>
    </PageContainer>
  );
}

async function AdmissionWithSchedule({
  schedule,
  ...props
}: ComponentProps<typeof AutomationAdmissionPanel> & {
  schedule: Promise<AutomationScheduleEvidence> | null;
}) {
  const preview = await schedule;
  return (
    <AutomationAdmissionPanel {...props} catchUp={preview?.available ? preview.catchUp : null} />
  );
}

async function ScheduleAndSample({
  schedule,
  definition,
  ...props
}: Omit<ComponentProps<typeof AutomationDryRunPanel>, "defaults"> & {
  schedule: Promise<AutomationScheduleEvidence> | null;
  definition: FactoryAutomationDefinition;
}) {
  const preview = await schedule;
  return (
    <>
      {definition.trigger.kind === "schedule" ? (
        <AutomationSchedulePreview preview={preview} timeZone={definition.trigger.timeZone} />
      ) : null}
      <AutomationDryRunPanel {...props} defaults={defaultEvent(definition, preview?.next[0])} />
    </>
  );
}

export default async function AutomationSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceSlug }, search] = await Promise.all([params, searchParams]);
  const snapshot = await loadWorkspaceRouteScope({
    picker: "guarded",
    resetParams: FACTORY_SWITCH_RESET_PARAMS,
    route: "automations",
    search,
    workspaceSlug,
  });
  const factories = workspaceScopeOptions(
    workspaceLocationForRoute("automations", workspaceSlug),
    snapshot.factories,
  );
  if (!factories.length) notFound();
  if (snapshot.scope.kind !== "factory") {
    return (
      <WorkspaceScopeRequired
        route="automations"
        snapshot={snapshot}
        title="Automations"
        workspaceSlug={workspaceSlug}
      />
    );
  }

  const { workspaceId } = snapshot;
  const factoryId = snapshot.scope.factory.id;
  const picker = (
    <AutomationFactoryPicker
      factories={factories}
      factoryId={factoryId}
      resetParams={snapshot.resetParams}
    />
  );
  function inFactory(children: ReactNode) {
    return (
      <>
        <WorkspaceScopeHandoff snapshot={snapshot} />
        {children}
      </>
    );
  }
  function unavailableSelection() {
    return inFactory(
      <AutomationDraftNavigation>
        {picker}
        <UnavailableSelection href={workspaceAutomationPreviewPath(workspaceSlug)} />
      </AutomationDraftNavigation>,
    );
  }

  const parsed = selectionSchema.safeParse(search);
  if (!parsed.success) return unavailableSelection();
  const query = parsed.data;
  const { supabase, currentMember } = await loadAuthenticatedWorkspaceContext(workspaceSlug);
  const canDiscover = isWorkspaceOperator(currentMember);
  const scope = { workspaceId, factoryId };
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
  if (automationId && !automation) return unavailableSelection();

  const pageSelection = { factory: factoryId, afterId: query.afterId };
  const definition = automation?.revision.definition;
  const ruleScope = automation ? { ...scope, automationId: automation.automationId } : null;
  const editMode =
    query.mode === "new" ||
    (!query.revision &&
      Boolean(
        automation &&
        !automation.archivedAt &&
        automation.revision.id === automation.draftRevisionId,
      ));
  const activeRevision = Boolean(automation?.publishedRevisionId && !automation.archivedAt);
  const cursor =
    query.historyBefore && query.historyBeforeId
      ? { recordedAt: query.historyBefore, id: query.historyBeforeId }
      : undefined;
  function loadSchedule(snapshot: typeof automation) {
    const trigger = snapshot?.revision.definition.trigger;
    return ruleScope && snapshot && trigger?.kind === "schedule"
      ? previewFactoryAutomationSchedule(supabase, {
          ...ruleScope,
          revisionId: snapshot.revision.id,
          ...trigger,
        }).catch(() => null)
      : null;
  }
  const selectedSchedule = loadSchedule(automation);
  const [setup, history, control, published, revisionNames] = await Promise.all([
    editMode
      ? loadFactoryAutomationSetup(supabase, scope)
          .then((options) => ({ options, failed: false }))
          .catch(() => ({ options: null, failed: true }))
      : null,
    ruleScope
      ? listFactoryAutomationOccurrenceHistory(supabase, ruleScope, cursor).catch(() => null)
      : null,
    ruleScope ? readAutomationAdmissionControl(supabase, ruleScope).catch(() => null) : null,
    ruleScope && activeRevision && automation?.publishedRevisionId
      ? automation.publishedRevisionId === automation.revision.id
        ? automation
        : readFactoryAutomation(supabase, ruleScope, {
            revisionId: automation.publishedRevisionId,
          }).catch(() => null)
      : null,
    definition && (!editMode || definition.trigger.kind === "pull-request")
      ? loadAutomationRevisionNames(supabase, scope, definition)
      : null,
  ]);
  const liveTrigger = published?.revision.definition.trigger;
  const liveSchedule =
    control?.paused && liveTrigger?.kind === "schedule"
      ? published?.revision.id === automation?.revision.id
        ? selectedSchedule
        : loadSchedule(published)
      : null;
  const repositories =
    setup?.options?.repositories ??
    (definition?.trigger.kind === "pull-request"
      ? await loadAutomationRepositories(supabase, scope).catch(() => [])
      : []);
  const linearFilters = definition && "stateIds" in definition.filters ? definition.filters : null;
  const available = automation && !listed ? [automation, ...list.automations] : list.automations;
  const next = history?.nextCursor;
  const historySelection = {
    ...pageSelection,
    automation: automation?.automationId,
    revision: query.revision,
  };
  const newHref = workspaceAutomationPreviewPath(workspaceSlug, { ...pageSelection, mode: "new" });

  return inFactory(
    <AutomationDraftNavigation
      key={JSON.stringify([workspaceId, factoryId, query, automation?.automationId, editMode])}
    >
      {picker}
      <PageContainer className="max-w-5xl">
        <PageHeader
          title="Automations"
          actionsRightOnDesktop
          actions={
            query.mode !== "new" ? (
              <Link href={newHref} className="ui-button ui-button-primary shrink-0">
                New rule
              </Link>
            ) : null
          }
        />
        <div className="space-y-8">
          <PageSection title="Rules">
            <div className="ui-sheet min-w-0 space-y-4 p-4 sm:p-6">
              {available.length ? (
                <AutomationRulePicker
                  afterId={query.afterId}
                  factoryId={factoryId}
                  workspaceSlug={workspaceSlug}
                  selectedId={automation?.automationId}
                  options={available.map(({ automationId, revision, archivedAt }) => ({
                    value: automationId,
                    label: `${revision.definition.name}${archivedAt ? " (archived)" : ""}`,
                  }))}
                />
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
                    {!automation.archivedAt && !editMode ? (
                      <Link
                        className="ui-button"
                        href={workspaceAutomationPreviewPath(workspaceSlug, {
                          ...pageSelection,
                          automation: automation.automationId,
                        })}
                      >
                        Edit draft
                      </Link>
                    ) : null}
                    {automation.publishedRevisionId &&
                    (automation.revision.id !== automation.publishedRevisionId || editMode) ? (
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
                  <Suspense
                    fallback={
                      <p className="text-sm text-muted" role="status">
                        Loading live admission…
                      </p>
                    }
                  >
                    <AdmissionWithSchedule
                      key={automation.automationId}
                      activeRevision={activeRevision}
                      publishedRevision={published?.revision.revision}
                      initial={control}
                      schedule={liveSchedule}
                      scheduleTimeZone={
                        liveTrigger?.kind === "schedule" ? liveTrigger.timeZone : undefined
                      }
                      endpoint={`${factoryAutomationApiPath(workspaceId, factoryId, automation.automationId)}/admission-control`}
                    />
                  </Suspense>
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
              {list.nextCursor || query.afterId ? (
                <p className="text-xs text-muted">The rule picker searches the current page.</p>
              ) : null}
            </div>
          </PageSection>
          <AutomationLinearCatalog
            key={`${workspaceId}:${factoryId}:${canDiscover}`}
            canDiscover={canDiscover}
            endpoint={`/api/workspaces/${workspaceId}/factories/${factoryId}/connectors`}
            integrationsHref={workspaceSettingsPath(workspaceSlug, {
              category: "integrations",
              factory: factoryId,
            })}
            revisionUsesLinear={linearFilters !== null}
            savedIds={{
              state: linearFilters?.stateIds ?? [],
              team: linearFilters?.teamIds ?? [],
              project: linearFilters?.projectIds ?? [],
            }}
          >
            {editMode ? (
              <AutomationEditor
                key={automation?.automationId ?? factoryId}
                workspaceId={workspaceId}
                workspaceSlug={workspaceSlug}
                factoryId={factoryId}
                afterId={query.afterId}
                revisionSelected={query.revision !== undefined}
                initial={automation ?? undefined}
                setup={setup?.options ?? null}
                setupFailed={setup?.failed ?? false}
                setupHref={
                  canDiscover
                    ? workspaceFactoryDefinitionPath(workspaceSlug, { factory: factoryId })
                    : undefined
                }
                savedRepositoryName={revisionNames?.repository}
              />
            ) : null}
            {automation && definition ? (
              <>
                {!editMode && revisionNames ? (
                  <AutomationRevisionSummary
                    trigger={definition.trigger}
                    filters={definition.filters}
                    target={definition.target}
                    grantVersion={definition.executionGrant.version}
                    names={revisionNames}
                    revision={automation.revision.revision}
                  />
                ) : null}
                <Suspense
                  fallback={
                    <p className="text-sm text-muted" role="status">
                      Loading revision preview…
                    </p>
                  }
                >
                  <ScheduleAndSample
                    key={automation.revision.id}
                    automationId={automation.automationId}
                    definition={definition}
                    schedule={selectedSchedule}
                    endpoint={automationDryRunApiPath(
                      workspaceId,
                      factoryId,
                      automation.automationId,
                    )}
                    revisionId={automation.revision.id}
                    repositories={repositories}
                    savedRepositoryName={revisionNames?.repository}
                  />
                </Suspense>
                <AutomationOccurrenceHistory
                  history={history}
                  workspaceSlug={workspaceSlug}
                  revisionHref={(revision) =>
                    workspaceAutomationPreviewPath(workspaceSlug, {
                      ...pageSelection,
                      automation: automation.automationId,
                      revision,
                    })
                  }
                  firstHref={
                    cursor
                      ? workspaceAutomationPreviewPath(workspaceSlug, historySelection)
                      : undefined
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
          </AutomationLinearCatalog>
        </div>
      </PageContainer>
    </AutomationDraftNavigation>,
  );
}
