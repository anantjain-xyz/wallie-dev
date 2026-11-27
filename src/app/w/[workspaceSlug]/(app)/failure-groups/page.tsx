import Link from "next/link";

import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { FactorySelector } from "@/features/factories/factory-selector";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import type { FactorySelectionOption } from "@/features/factories/factory-selection";
import { FailureGroupFilters } from "@/features/factory-failures/failure-group-filters";
import { loadFailureGroupScope } from "@/features/factory-failures/failure-group-scope";
import {
  FailureGroupCounts,
  FailureGroupLimits,
  FailureGroupStatus,
  failureGroupTask,
  failureGroupTitle,
} from "@/features/factory-failures/failure-group-summary";
import {
  failureCohortIdSchema,
  parseFailureCohortQuery,
} from "@/lib/factory-failures/cohort-contracts";
import {
  listFailureCohorts,
  listFailureRevisionPage,
  loadFailureActivation,
  loadFailureAgentNames,
  loadFailureRevisionOptions,
} from "@/lib/factory-failures/cohorts";
import {
  workspaceFailureGroupPath,
  workspaceFailureGroupsPath,
  workspaceImprovementsPath,
  workspaceRunsPath,
  workspaceSessionsPath,
} from "@/lib/routes";

const FAILURE_GROUPS_FACTORY_RESET_PARAMS = ["revision"] as const;

function UnavailableFactory({
  factories,
  workspaceSlug,
}: {
  factories: FactorySelectionOption[];
  workspaceSlug: string;
}) {
  if (!factories.length)
    return <FactoryUnavailable title="Failure groups" workspaceSlug={workspaceSlug} />;
  return (
    <PageContainer>
      <PageHeader
        title="Failure groups"
        actionsRightOnDesktop
        actions={
          <FactorySelector
            factories={factories}
            resetParams={FAILURE_GROUPS_FACTORY_RESET_PARAMS}
            selectedValue="unavailable"
          />
        }
      />
      <section className="ui-sheet space-y-3 p-5">
        <h2 className="type-label">Factory unavailable</h2>
        <p className="type-secondary text-muted">
          Choose an accessible factory from the Factory picker to browse its failure groups.
        </p>
        <Link className="ui-button" href={workspaceSessionsPath(workspaceSlug, { factory: "all" })}>
          View accessible sessions
        </Link>
      </section>
    </PageContainer>
  );
}

export default async function FailureGroupsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceSlug }, search] = await Promise.all([params, searchParams]);
  const malformedRevision = Boolean(
    search.revision && !failureCohortIdSchema.safeParse(search.revision).success,
  );
  const query = parseFailureCohortQuery(
    malformedRevision ? { ...search, revision: undefined, after: undefined } : search,
  );
  const [scope, factories] = await Promise.all([
    loadFailureGroupScope(workspaceSlug, search.factory),
    loadWorkspaceFactoryOptions(workspaceSlug),
  ]);
  if (!scope) return <UnavailableFactory factories={factories} workspaceSlug={workspaceSlug} />;
  const factorySelector = (
    <FactorySelector
      factories={factories}
      resetParams={FAILURE_GROUPS_FACTORY_RESET_PARAMS}
      selectedValue={scope.factoryId}
    />
  );
  const base = workspaceFailureGroupsPath(workspaceSlug);
  const reset = workspaceFailureGroupsPath(workspaceSlug, { factory: scope.factoryId });
  if (!query.success) {
    return (
      <PageContainer>
        <PageHeader actions={factorySelector} actionsRightOnDesktop title="Failure groups" />
        <div className="ui-sheet space-y-3 p-5">
          <p className="type-body">Check the failure group filters and try again.</p>
          <Link className="ui-button" href={reset}>
            Reset filters
          </Link>
        </div>
      </PageContainer>
    );
  }
  const { after, ...filters } = query.data;
  const preserved = { ...filters, factory: scope.factoryId, order: "failures" };
  const filtered = Boolean(filters.symptom || filters.revision || filters.disposition);
  const [page, active] = await Promise.all([
    listFailureCohorts(scope.supabase, scope, query.data),
    loadFailureActivation(scope.supabase, scope),
  ]);
  if (!page) return <UnavailableFactory factories={factories} workspaceSlug={workspaceSlug} />;
  const [revisions, pinned, agentNames] = await Promise.all([
    listFailureRevisionPage(scope.supabase, scope, active),
    loadFailureRevisionOptions(
      scope.supabase,
      scope,
      [active, filters.revision].filter((id): id is string => Boolean(id)),
      active,
    ),
    loadFailureAgentNames(
      scope.supabase,
      scope,
      page.cohorts.map((cohort) => cohort.agent_id),
    ),
  ]);
  const missingRevision = Boolean(filters.revision && !pinned.has(filters.revision));
  if (filters.revision && missingRevision) {
    pinned.set(filters.revision, {
      id: filters.revision,
      label: "Revision unavailable",
      detail: "",
    });
  }
  const revisionProblem = missingRevision ? "missing" : malformedRevision ? "malformed" : undefined;
  const empty = !after && !filtered && !revisionProblem && !page.cohorts.length;

  return (
    <PageContainer>
      <PageHeader
        actions={
          <>
            {factorySelector}
            <Link
              className="ui-button"
              href={workspaceImprovementsPath(workspaceSlug, { factory: scope.factoryId })}
            >
              Improvements
            </Link>
          </>
        }
        actionsRightOnDesktop
        title="Failure groups"
        description={
          scope.factory.status === "archived"
            ? "This factory is archived. You can browse evidence, but reviews are closed."
            : undefined
        }
      />
      <section aria-label="Failure groups" className="ui-sheet">
        {!empty ? (
          <FailureGroupFilters
            applied={{
              symptom: filters.symptom ?? "",
              revision: filters.revision ?? "",
              disposition: filters.disposition ?? "",
            }}
            clearHref={reset}
            factoryId={scope.factoryId}
            key={scope.factoryId}
            path={base}
            pinned={[...pinned.values()]}
            revisionProblem={revisionProblem}
            revisions={revisions ?? { options: [], next: null }}
          />
        ) : null}
        {page.cohorts.length ? (
          <ul className="divide-y divide-border">
            {page.cohorts.map((cohort) => (
              <li
                className="grid min-w-0 gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(17rem,auto)] sm:items-center sm:p-5"
                key={cohort.id}
              >
                <div className="min-w-0 space-y-2">
                  <Link
                    className="break-words font-semibold underline-offset-4 hover:underline"
                    href={workspaceFailureGroupPath(workspaceSlug, cohort.id, preserved)}
                    prefetch={false}
                  >
                    {failureGroupTitle(cohort)}
                    <span className="sr-only">
                      {" "}
                      · {agentNames.get(cohort.agent_id) ?? "Agent unavailable"} ·{" "}
                      {failureGroupTask(cohort)}
                    </span>
                  </Link>
                  <p className="type-secondary break-words text-muted">
                    {agentNames.get(cohort.agent_id) ?? "Agent unavailable"}
                    {" · "}
                    {failureGroupTask(cohort)} ·{" "}
                    {cohort.symptom_kind === "scorer" ? "Scorer failure" : "Validation failure"}
                  </p>
                  <FailureGroupStatus cohort={cohort} compact />
                  <FailureGroupLimits cohort={cohort} />
                </div>
                <FailureGroupCounts cohort={cohort} />
              </li>
            ))}
          </ul>
        ) : (
          <div className="space-y-2 px-4 py-6 sm:px-5">
            <h2 className="type-section-title">
              {page.cursor_unavailable
                ? "This results page is no longer available"
                : after
                  ? "No more failure groups"
                  : filtered
                    ? "No failure groups match these filters"
                    : "No failure groups yet"}
            </h2>
            {!filtered && !after ? (
              <>
                <p className="type-secondary text-muted">
                  Related scorer and validation failures appear here as evidence is recorded.
                </p>
                <Link
                  className="ui-button"
                  href={workspaceRunsPath(workspaceSlug, { factory: scope.factoryId })}
                >
                  Browse runs
                </Link>
              </>
            ) : null}
          </div>
        )}
        {after || page.next_cohort_id ? (
          <nav
            aria-label="Failure group pages"
            className="flex flex-wrap gap-2 border-t border-border p-4"
          >
            {after ? (
              <Link
                className="ui-button"
                href={workspaceFailureGroupsPath(workspaceSlug, preserved)}
              >
                First page
              </Link>
            ) : null}
            {page.next_cohort_id ? (
              <Link
                className="ui-button"
                href={workspaceFailureGroupsPath(workspaceSlug, {
                  ...preserved,
                  after: page.next_cohort_id,
                })}
              >
                More groups
              </Link>
            ) : null}
          </nav>
        ) : null}
      </section>
    </PageContainer>
  );
}
