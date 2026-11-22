import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { PageContainer, PageHeader, PageSection } from "@/components/ui/page-shell";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import { FactorySemanticDiffComparison } from "@/features/factory-definition/semantic-diff";
import { ImprovementEvidence } from "@/features/factory-proposals/improvement-evidence";
import { ImprovementReviewForm } from "@/features/factory-proposals/improvement-review-form";
import { loadImprovementScope } from "@/features/factory-proposals/improvement-scope";
import {
  ImprovementStatus,
  ImprovementTime,
  ReviewEventLabel,
} from "@/features/factory-proposals/improvement-status";
import { diagnosisReceiptSchema } from "@/lib/factory-diagnosis/contracts";
import { factoryProposalUuidSchema } from "@/lib/factory-proposals/contracts";
import { readImprovementWorkbench } from "@/lib/factory-proposals/workbench";
import { workspaceImprovementPath, workspaceImprovementsPath } from "@/lib/routes";

const reviewCursor = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().positive().max(2_147_483_647))
  .optional();

export default async function ImprovementPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string; proposalId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceSlug, proposalId }, search] = await Promise.all([params, searchParams]);
  const id = factoryProposalUuidSchema.safeParse(proposalId);
  if (!id.success) notFound();
  const scope = await loadImprovementScope(workspaceSlug, search.factory);
  if (!scope)
    return <FactoryUnavailable title="Improvement proposal" workspaceSlug={workspaceSlug} />;

  const revision = factoryProposalUuidSchema.optional().safeParse(search.revision);
  const before = reviewCursor.safeParse(search.before);
  const cohort = factoryProposalUuidSchema.optional().safeParse(search.cohort);
  const factoryQuery = { factory: scope.factoryId };
  const data =
    revision.success && before.success && cohort.success
      ? await readImprovementWorkbench(scope.supabase, scope, {
          proposalId: id.data,
          revisionId: revision.data,
          beforeEvent: before.data,
        })
      : null;
  const listQuery = {
    ...factoryQuery,
    cohort: cohort.success && cohort.data === data?.cohortId ? cohort.data : undefined,
  };
  const back = (
    <Link
      className="underline-offset-4 hover:underline"
      href={workspaceImprovementsPath(workspaceSlug, listQuery)}
    >
      Back to improvements
    </Link>
  );
  if (!data) {
    return (
      <PageContainer>
        <PageHeader title="Proposal revision unavailable" eyebrow={back} eyebrowAsPlain />
      </PageContainer>
    );
  }

  const { proposal, latestRevisionId, revisions, review, cohortId } = data;
  const diagnosis =
    cohortId === null
      ? null
      : await scope.supabase.rpc("get_factory_diagnosis", {
          p_workspace_id: scope.workspaceId,
          p_factory_id: scope.factoryId,
          p_diagnosis_id: proposal.diagnosisId,
        });
  if (diagnosis?.error && diagnosis.error.code !== "P0002") throw diagnosis.error;
  const attribution = diagnosis?.data ? diagnosisReceiptSchema.parse(diagnosis.data) : null;
  const retainedDiagnosis =
    attribution?.cohort_id === cohortId && attribution.diagnosis_id === proposal.diagnosisId
      ? attribution
      : null;

  const historical = proposal.revisionId !== latestRevisionId;
  const revisionHref = (revisionId: string, cursor?: number) =>
    workspaceImprovementPath(workspaceSlug, proposal.proposalId, {
      ...listQuery,
      revision: revisionId,
      before: cursor,
    });
  const endpoint = `/api/workspaces/${scope.workspaceId}/factories/${scope.factoryId}/improvement-proposals/${proposal.proposalId}/review`;

  return (
    <PageContainer>
      <PageHeader
        title="Improvement proposal"
        eyebrow={back}
        eyebrowAsPlain
        description={scope.factory.name}
      />
      <div className="space-y-7">
        <section aria-label="Proposal summary" className="ui-sheet min-w-0 space-y-4 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="type-section-title min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
              {proposal.rationale}
            </h2>
            <ImprovementStatus
              status={proposal.status}
              disposition={review.disposition}
              baseCurrent={proposal.baseCurrent}
            />
          </div>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="min-w-0 space-y-1">
              <dt className="type-annotation text-muted">Predicted benefit</dt>
              <dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                {proposal.expectedBenefit}
              </dd>
            </div>
            <div className="min-w-0 space-y-1">
              <dt className="type-annotation text-muted">Regression risks</dt>
              <dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                {proposal.regressionRisks || "None recorded"}
              </dd>
            </div>
          </dl>
          <nav aria-label="Proposal revisions" className="flex flex-wrap gap-2">
            {revisions.map((entry) => (
              <Link
                key={entry.revisionId}
                aria-current={entry.revisionId === proposal.revisionId ? "page" : undefined}
                className={
                  entry.revisionId === proposal.revisionId
                    ? "ui-button ui-button-primary"
                    : "ui-button"
                }
                href={revisionHref(entry.revisionId)}
                prefetch={false}
              >
                Revision {entry.revisionNumber}
              </Link>
            ))}
            {proposal.previousRevisionId &&
            !revisions.some(({ revisionId }) => revisionId === proposal.previousRevisionId) ? (
              <Link className="ui-button" href={revisionHref(proposal.previousRevisionId)}>
                Previous revision
              </Link>
            ) : null}
          </nav>
          <p className="type-annotation text-muted">
            Revision {proposal.revisionNumber} · <ImprovementTime instant={proposal.createdAt} />
          </p>
        </section>

        <ImprovementEvidence
          diagnosis={retainedDiagnosis}
          diagnosisId={proposal.diagnosisId}
          cohortId={cohortId}
          scope={{ workspaceSlug, workspaceId: scope.workspaceId, factoryId: scope.factoryId }}
        />

        <PageSection anchorId="candidate-diff" title="Candidate diff">
          <div className="ui-sheet min-w-0 space-y-4 p-4 sm:p-5">
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div className="min-w-0 space-y-1">
                <dt className="type-annotation text-muted">
                  Recorded base · Activation {proposal.base.activationNumber}
                </dt>
                <dd className="font-mono text-xs [overflow-wrap:anywhere]">
                  {proposal.base.digest}
                </dd>
              </div>
              {proposal.candidate ? (
                <div className="min-w-0 space-y-1">
                  <dt className="type-annotation text-muted">Proposed configuration</dt>
                  <dd className="font-mono text-xs [overflow-wrap:anywhere]">
                    {proposal.candidate.digest}
                  </dd>
                </div>
              ) : null}
            </dl>
            {!proposal.baseCurrent ? (
              <p className="type-secondary text-muted">
                The active definition changed. This revision keeps its original comparison.
              </p>
            ) : null}
            {proposal.status === "compiled" ? (
              <FactorySemanticDiffComparison
                comparison={proposal.diff}
                beforeLabel={proposal.baseCurrent ? "Active configuration" : "Recorded base"}
                afterLabel="Proposed configuration"
              />
            ) : (
              <ul
                className="divide-y divide-border rounded-md border border-border"
                aria-label="Validation errors"
              >
                {proposal.diagnostics.map((diagnostic, index) => (
                  <li key={index} className="min-w-0 p-3">
                    {diagnostic.path.length ? (
                      <p className="type-annotation font-mono text-muted [overflow-wrap:anywhere]">
                        {diagnostic.path.join(".")}
                      </p>
                    ) : null}
                    <p className="type-secondary whitespace-pre-wrap [overflow-wrap:anywhere]">
                      {diagnostic.message}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </PageSection>

        <PageSection anchorId="discussion" title="Discussion">
          <div className="ui-sheet min-w-0 space-y-4 p-4 sm:p-5">
            {historical ? (
              <div className="flex flex-wrap items-center gap-2">
                <p className="type-secondary text-muted">Discussion for an earlier revision.</p>
                <Link className="ui-button" href={revisionHref(latestRevisionId)}>
                  Open latest revision
                </Link>
              </div>
            ) : null}
            {review.events.length ? (
              <ol
                className="divide-y divide-border rounded-md border border-border"
                aria-label="Revision discussion"
              >
                {review.events.map((event) => (
                  <li key={event.id} className="min-w-0 space-y-1.5 p-3">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <ReviewEventLabel action={event.action} />
                      <span className="type-annotation text-muted [overflow-wrap:anywhere]">
                        {event.actorName || `Member ${event.actorMemberId.slice(0, 8)}`}
                      </span>
                      <ImprovementTime instant={event.createdAt} />
                    </div>
                    {event.note ? (
                      <p className="type-secondary whitespace-pre-wrap [overflow-wrap:anywhere]">
                        {event.note}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="type-secondary text-muted">This revision has no discussion yet.</p>
            )}
            {before.data || review.nextEventBefore ? (
              <nav aria-label="Discussion pages" className="flex flex-wrap gap-2">
                {before.data ? (
                  <Link
                    className="ui-button"
                    href={`${revisionHref(proposal.revisionId)}#discussion`}
                  >
                    Latest comments
                  </Link>
                ) : null}
                {review.nextEventBefore ? (
                  <Link
                    className="ui-button"
                    href={`${revisionHref(proposal.revisionId, review.nextEventBefore)}#discussion`}
                  >
                    Earlier comments
                  </Link>
                ) : null}
              </nav>
            ) : null}
            <ImprovementReviewForm
              key={`${scope.reviewerMemberId}:${proposal.revisionId}`}
              endpoint={endpoint}
              proposalRevisionId={proposal.revisionId}
              reviewerMemberId={scope.reviewerMemberId}
              reviewVersion={review.version}
              canReview={review.canReview && !historical && review.disposition !== "dismissed"}
            />
          </div>
        </PageSection>
      </div>
    </PageContainer>
  );
}
