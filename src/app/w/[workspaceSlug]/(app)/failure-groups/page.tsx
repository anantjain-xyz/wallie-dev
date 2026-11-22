import Link from "next/link";

import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { FactorySelector } from "@/features/factories/factory-selector";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import { loadFailureGroupScope } from "@/features/factory-failures/failure-group-scope";
import {
  FailureGroupCounts,
  FailureGroupLimits,
  FailureGroupStatus,
  failureGroupTitle,
} from "@/features/factory-failures/failure-group-summary";
import { parseFailureCohortQuery } from "@/lib/factory-failures/cohort-contracts";
import {
  listFailureCohorts,
  listRecentFailureDefinitionRevisions,
} from "@/lib/factory-failures/cohorts";
import { workspaceFailureGroupPath, workspaceFailureGroupsPath } from "@/lib/routes";
import { titleFromSlug } from "@/lib/utils";

const revisionDate = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });
const FAILURE_GROUPS_FACTORY_RESET_PARAMS = ["revision"] as const;

export default async function FailureGroupsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceSlug }, search] = await Promise.all([params, searchParams]);
  const query = parseFailureCohortQuery(search);
  const [scope, factories] = await Promise.all([
    loadFailureGroupScope(workspaceSlug, search.factory),
    loadWorkspaceFactoryOptions(workspaceSlug),
  ]);
  if (!scope)
    return (
      <FactoryUnavailable
        actions={
          <FactorySelector
            factories={factories}
            resetParams={FAILURE_GROUPS_FACTORY_RESET_PARAMS}
            selectedValue="unavailable"
          />
        }
        title="Failure groups"
        workspaceSlug={workspaceSlug}
      />
    );
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
  const preserved = { ...filters, factory: scope.factoryId };
  const filtered = Boolean(filters.symptom || filters.revision || filters.disposition);
  const [page, revisions] = await Promise.all([
    listFailureCohorts(scope.supabase, scope, query.data),
    listRecentFailureDefinitionRevisions(scope.supabase, scope),
  ]);
  if (!page)
    return (
      <FactoryUnavailable
        actions={
          <FactorySelector
            factories={factories}
            resetParams={FAILURE_GROUPS_FACTORY_RESET_PARAMS}
            selectedValue="unavailable"
          />
        }
        title="Failure groups"
        workspaceSlug={workspaceSlug}
      />
    );

  return (
    <PageContainer>
      <PageHeader actions={factorySelector} actionsRightOnDesktop title="Failure groups" />
      <form
        action={base}
        key={JSON.stringify(preserved)}
        className="ui-sheet grid gap-4 p-4 sm:grid-cols-[1fr_minmax(0,1.6fr)_1fr] sm:items-end sm:p-5"
      >
        <input type="hidden" name="factory" value={scope.factoryId} />
        <label className="type-label grid min-w-0 gap-1.5">
          Symptom
          <select className="ui-input w-full" name="symptom" defaultValue={filters.symptom ?? ""}>
            <option value="">All symptoms</option>
            <option value="scorer">Scorer failures</option>
            <option value="validation">Validation failures</option>
          </select>
        </label>
        <label className="type-label grid min-w-0 gap-1.5">
          Factory definition revision
          <input
            className="ui-input w-full min-w-0"
            name="revision"
            defaultValue={filters.revision ?? ""}
            list="failure-definition-revisions"
            placeholder="Any revision"
          />
        </label>
        <datalist id="failure-definition-revisions">
          {revisions.map((revision) => (
            <option key={revision.id} value={revision.id}>
              {revisionDate.format(new Date(revision.created_at))} ·{" "}
              {revision.canonical_digest.slice(0, 10)}
            </option>
          ))}
        </datalist>
        <label className="type-label grid min-w-0 gap-1.5">
          Review state
          <select
            className="ui-input w-full"
            name="disposition"
            defaultValue={filters.disposition ?? ""}
          >
            <option value="">All states</option>
            <option value="open">Open</option>
            <option value="dismissed">Dismissed</option>
            <option value="split">Split</option>
          </select>
        </label>
        <div className="flex flex-wrap gap-2 sm:col-span-3">
          <button className="ui-button ui-button-primary" type="submit">
            Apply filters
          </button>
          {filtered ? (
            <Link className="ui-button" href={reset}>
              Clear filters
            </Link>
          ) : null}
        </div>
      </form>
      <section aria-label="Failure groups" className="ui-sheet mt-5">
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
                  </Link>
                  <p className="type-secondary text-muted">
                    {cohort.task_class_slug
                      ? titleFromSlug(cohort.task_class_slug)
                      : "Unclassified task"}{" "}
                    · {cohort.symptom_kind === "scorer" ? "Scorer failure" : "Validation failure"}
                  </p>
                  <FailureGroupStatus cohort={cohort} />
                  <FailureGroupLimits cohort={cohort} />
                </div>
                <FailureGroupCounts cohort={cohort} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="type-secondary px-4 py-8 text-muted sm:px-5">
            {after
              ? "There are no more failure groups."
              : filtered
                ? "No failure groups match these filters."
                : "This factory has no recorded failure groups."}
          </p>
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
