import Link from "next/link";

import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { failureGroupTitle } from "@/features/factory-failures/failure-group-summary";
import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { FactorySelector } from "@/features/factories/factory-selector";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import { loadImprovementScope } from "@/features/factory-proposals/improvement-scope";
import {
  ImprovementStatus,
  ImprovementTime,
  improvementReviewStates,
} from "@/features/factory-proposals/improvement-status";
import { getFailureCohort } from "@/lib/factory-failures/cohorts";
import { factoryProposalUuidSchema } from "@/lib/factory-proposals/contracts";
import { proposalReviewDispositionSchema } from "@/lib/factory-proposals/workbench-contracts";
import { listImprovementProposals } from "@/lib/factory-proposals/workbench";
import {
  workspaceFailureGroupPath,
  workspaceFailureGroupsPath,
  workspaceImprovementPath,
  workspaceImprovementsPath,
} from "@/lib/routes";

const IMPROVEMENTS_FACTORY_RESET_PARAMS = ["cohort"] as const;

export default async function ImprovementsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceSlug }, search] = await Promise.all([params, searchParams]);
  const [scope, factories] = await Promise.all([
    loadImprovementScope(workspaceSlug, search.factory),
    loadWorkspaceFactoryOptions(workspaceSlug),
  ]);
  if (!scope)
    return (
      <FactoryUnavailable
        actions={
          <FactorySelector
            factories={factories}
            resetParams={IMPROVEMENTS_FACTORY_RESET_PARAMS}
            selectedValue="unavailable"
          />
        }
        title="Improvements"
        workspaceSlug={workspaceSlug}
      />
    );
  const factorySelector = (
    <FactorySelector
      factories={factories}
      resetParams={IMPROVEMENTS_FACTORY_RESET_PARAMS}
      selectedValue={scope.factoryId}
    />
  );
  const after = factoryProposalUuidSchema.optional().safeParse(search.after);
  const cohort = factoryProposalUuidSchema.optional().safeParse(search.cohort);
  const reviewState = proposalReviewDispositionSchema
    .optional()
    .safeParse(search.reviewState === "all" ? undefined : search.reviewState);
  const factoryQuery = { factory: scope.factoryId };
  if (!after.success || !cohort.success || !reviewState.success) {
    return (
      <PageContainer>
        <PageHeader actions={factorySelector} actionsRightOnDesktop title="Improvements" />
        <section className="ui-sheet space-y-3 p-5">
          <p className="type-secondary">Check the proposal filters and try again.</p>
          <Link className="ui-button" href={workspaceImprovementsPath(workspaceSlug, factoryQuery)}>
            Clear filters
          </Link>
        </section>
      </PageContainer>
    );
  }

  const query = { ...factoryQuery, cohort: cohort.data, reviewState: reviewState.data };
  const [page, group] = await Promise.all([
    listImprovementProposals(scope.supabase, scope, {
      after: after.data,
      cohortId: cohort.data,
      reviewState: reviewState.data,
    }),
    cohort.data ? getFailureCohort(scope.supabase, scope, cohort.data, {}) : null,
  ]);
  const groupHref =
    cohort.data && workspaceFailureGroupPath(workspaceSlug, cohort.data, factoryQuery);
  const nextCursor = page.nextRevisionId ?? page.nextProposalId;

  return (
    <PageContainer>
      <PageHeader actions={factorySelector} actionsRightOnDesktop title="Improvements" />
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <form
            action={workspaceImprovementsPath(workspaceSlug)}
            className="flex flex-wrap items-end gap-2"
          >
            <input name="factory" type="hidden" value={scope.factoryId} />
            {cohort.data ? <input name="cohort" type="hidden" value={cohort.data} /> : null}
            <label className="type-label grid gap-1">
              Review state
              <select
                key={reviewState.data ?? "all"}
                className="ui-input"
                defaultValue={reviewState.data ?? "all"}
                name="reviewState"
              >
                <option value="all">All</option>
                {proposalReviewDispositionSchema.options.map((state) => (
                  <option key={state} value={state}>
                    {improvementReviewStates[state].label}
                  </option>
                ))}
              </select>
            </label>
            <button className="ui-button" type="submit">
              Apply filter
            </button>
          </form>
          {groupHref ? (
            <nav
              aria-label="Failure group filter"
              className="flex min-w-0 flex-wrap items-center gap-2"
            >
              <Link
                className="ui-button max-w-full whitespace-normal [overflow-wrap:anywhere]"
                href={groupHref}
                prefetch={false}
              >
                {group ? `Failure group: ${failureGroupTitle(group.cohort)}` : "View failure group"}
              </Link>
              <Link
                className="ui-button"
                href={workspaceImprovementsPath(workspaceSlug, factoryQuery)}
              >
                All proposals
              </Link>
            </nav>
          ) : null}
        </div>
        <section aria-label="Improvement proposals" className="ui-sheet">
          {page.proposals.length ? (
            <ul className="divide-y divide-border">
              {page.proposals.map((proposal) => (
                <li
                  key={proposal.proposalId}
                  className="grid min-w-0 gap-x-6 gap-y-2 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:p-5"
                >
                  <div className="min-w-0 space-y-1.5">
                    <Link
                      className="line-clamp-2 break-words font-semibold underline-offset-4 hover:underline"
                      href={workspaceImprovementPath(workspaceSlug, proposal.proposalId, {
                        ...query,
                        revision: proposal.revisionId,
                      })}
                      prefetch={false}
                    >
                      {proposal.rationale}
                    </Link>
                    <p className="type-secondary line-clamp-2 break-words text-muted">
                      {proposal.expectedBenefit}
                    </p>
                  </div>
                  <div className="space-y-2 sm:justify-self-end">
                    <ImprovementStatus {...proposal} />
                    <p className="type-annotation flex flex-wrap items-baseline gap-2 text-muted">
                      <span>Revision {proposal.revisionNumber}</span>
                      <span>
                        Updated <ImprovementTime instant={proposal.createdAt} />
                      </span>
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="space-y-2 p-5">
              <p className="type-secondary text-muted">
                {after.data
                  ? "There are no more proposals."
                  : reviewState.data
                    ? "No improvement proposals match this review state."
                    : groupHref
                      ? "This failure group has no improvement proposals."
                      : "This factory has no improvement proposals. Proposals are based on completed diagnoses."}
              </p>
              {!after.data && reviewState.data ? (
                <Link
                  className="ui-button"
                  href={workspaceImprovementsPath(workspaceSlug, {
                    ...query,
                    reviewState: undefined,
                  })}
                >
                  Clear review state
                </Link>
              ) : !after.data && groupHref ? (
                <Link className="ui-button" href={groupHref}>
                  Back to failure group
                </Link>
              ) : !after.data ? (
                <Link
                  className="ui-button"
                  href={workspaceFailureGroupsPath(workspaceSlug, factoryQuery)}
                >
                  View failure groups
                </Link>
              ) : null}
            </div>
          )}
          {after.data || nextCursor ? (
            <nav
              aria-label="Proposal pages"
              className="flex flex-wrap gap-2 border-t border-border p-4"
            >
              {after.data ? (
                <Link className="ui-button" href={workspaceImprovementsPath(workspaceSlug, query)}>
                  First page
                </Link>
              ) : null}
              {nextCursor ? (
                <Link
                  className="ui-button"
                  href={workspaceImprovementsPath(workspaceSlug, {
                    ...query,
                    after: nextCursor,
                  })}
                >
                  More proposals
                </Link>
              ) : null}
            </nav>
          ) : null}
        </section>
      </div>
    </PageContainer>
  );
}
