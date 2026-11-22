import Link from "next/link";

import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import { loadImprovementScope } from "@/features/factory-proposals/improvement-scope";
import {
  ImprovementStatus,
  ImprovementTime,
} from "@/features/factory-proposals/improvement-status";
import { factoryProposalUuidSchema } from "@/lib/factory-proposals/contracts";
import { listImprovementProposals } from "@/lib/factory-proposals/workbench";
import {
  workspaceFailureGroupPath,
  workspaceImprovementPath,
  workspaceImprovementsPath,
} from "@/lib/routes";

export default async function ImprovementsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceSlug }, search] = await Promise.all([params, searchParams]);
  const scope = await loadImprovementScope(workspaceSlug, search.factory);
  if (!scope) return <FactoryUnavailable title="Improvements" workspaceSlug={workspaceSlug} />;
  const after = factoryProposalUuidSchema.optional().safeParse(search.after);
  const cohort = factoryProposalUuidSchema.optional().safeParse(search.cohort);
  const factoryQuery = { factory: scope.factoryId };
  if (!after.success || !cohort.success) {
    return (
      <PageContainer>
        <PageHeader title="Improvements" description={scope.factory.name} />
        <section className="ui-sheet space-y-3 p-5">
          <p className="type-secondary">Check the proposal filters and try again.</p>
          <Link className="ui-button" href={workspaceImprovementsPath(workspaceSlug, factoryQuery)}>
            Clear filters
          </Link>
        </section>
      </PageContainer>
    );
  }

  const query = { ...factoryQuery, cohort: cohort.data };
  const page = await listImprovementProposals(scope.supabase, scope, {
    after: after.data,
    cohortId: cohort.data,
  });

  return (
    <PageContainer>
      <PageHeader title="Improvements" description={scope.factory.name} />
      <div className="space-y-4">
        {cohort.data ? (
          <nav aria-label="Failure group filter" className="flex flex-wrap items-center gap-2">
            <Link
              className="ui-button"
              href={workspaceFailureGroupPath(workspaceSlug, cohort.data, factoryQuery)}
              prefetch={false}
            >
              View failure group
            </Link>
            <Link
              className="ui-button"
              href={workspaceImprovementsPath(workspaceSlug, factoryQuery)}
            >
              All proposals
            </Link>
          </nav>
        ) : null}
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
                      <ImprovementTime instant={proposal.createdAt} />
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="type-secondary p-5 text-muted">
              {after.data
                ? "There are no more proposals."
                : cohort.data
                  ? "This failure group has no improvement proposals."
                  : "This factory has no improvement proposals."}
            </p>
          )}
          {after.data || page.nextProposalId ? (
            <nav
              aria-label="Proposal pages"
              className="flex flex-wrap gap-2 border-t border-border p-4"
            >
              {after.data ? (
                <Link className="ui-button" href={workspaceImprovementsPath(workspaceSlug, query)}>
                  First page
                </Link>
              ) : null}
              {page.nextProposalId ? (
                <Link
                  className="ui-button"
                  href={workspaceImprovementsPath(workspaceSlug, {
                    ...query,
                    after: page.nextProposalId,
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
