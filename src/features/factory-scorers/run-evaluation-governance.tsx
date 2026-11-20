import "server-only";

import Link from "next/link";
import { z } from "zod";

import { Status } from "@/components/ui/status";
import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import {
  readEvaluationReview,
  readScorerPause,
  readScorerReevaluations,
  type ScorerGovernanceScope,
} from "@/lib/factory-evaluations/scorer-governance";
import type { RunScore } from "@/lib/factory-evaluations/score-trend-contracts";
import { listFactoryScorerRevisions } from "@/lib/factory-scorers/service";
import { workspaceRunDetailPath } from "@/lib/routes";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { createSupabaseServerClient } from "@/lib/supabase/server";

import { AdjudicationForm, ReevaluationForm } from "./evaluation-governance-controls";
import { ScoreOutcome } from "./score-outcome";

type Receipt = NonNullable<RunScore["receipt"]>;
type Client = Awaited<ReturnType<typeof createSupabaseServerClient>>;
const querySchema = z
  .object({
    beforeAdjudicationAt: z.string().datetime({ offset: true }).optional(),
    beforeAdjudicationId: z.string().uuid().optional(),
    beforeReevaluationAt: z.string().datetime({ offset: true }).optional(),
    beforeReevaluationJob: z.string().uuid().optional(),
    beforeTargetRevision: z
      .string()
      .regex(/^[1-9]\d*$/)
      .transform(Number)
      .pipe(z.number().int().max(2_147_483_647))
      .optional(),
  })
  .refine(
    (query) =>
      (query.beforeAdjudicationAt === undefined) === (query.beforeAdjudicationId === undefined) &&
      (query.beforeReevaluationAt === undefined) === (query.beforeReevaluationJob === undefined),
  );
type PageQuery = z.output<typeof querySchema>;
const instant = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export function runAttemptHref(
  workspaceSlug: string,
  runId: string,
  attemptId?: string,
  jobId?: string,
  anchor?: string,
  page: PageQuery = {},
) {
  const search = new URLSearchParams();
  if (attemptId) search.set("evaluationAttempt", attemptId);
  for (const [key, value] of Object.entries(page)) if (value) search.set(key, String(value));
  return `${workspaceRunDetailPath(workspaceSlug, runId)}${search.size ? `?${search}` : ""}#${anchor ?? (jobId ? `evaluation-${jobId}` : "scorer-evaluations")}`;
}

export async function loadRunEvaluationGovernance({
  supabase,
  scope,
  workspaceSlug,
  score,
  receipt,
  query,
}: {
  supabase: Client;
  scope: ScorerGovernanceScope;
  workspaceSlug: string;
  score: RunScore;
  receipt: Receipt;
  query: Record<string, string | string[] | undefined>;
}) {
  const parsed = querySchema.safeParse(query);
  if (!parsed.success) return null;
  const page = parsed.data;
  const before =
    page.beforeAdjudicationAt && page.beforeAdjudicationId
      ? { createdAt: page.beforeAdjudicationAt, adjudicationId: page.beforeAdjudicationId }
      : undefined;
  const beforeJob =
    page.beforeReevaluationAt && page.beforeReevaluationJob
      ? { createdAt: page.beforeReevaluationAt, jobId: page.beforeReevaluationJob }
      : undefined;
  const admin = createSupabaseAdminClient();
  const [review, reevaluations, factories, pause] = await Promise.all([
    readEvaluationReview(admin, scope, receipt.attempt_id, before).catch(() => null),
    readScorerReevaluations(admin, scope, receipt.attempt_id, receipt.run_id, beforeJob).catch(
      () => null,
    ),
    loadWorkspaceFactoryOptions(workspaceSlug).catch(() => []),
    readScorerPause(admin, scope, score.scorer_id).catch(() => null),
  ]);
  const canManage = factories.some(
    (factory) => factory.id === scope.factoryId && factory.status === "active" && factory.canManage,
  );
  const targets =
    canManage && !pause?.paused && receipt.evidence_availability !== "withheld"
      ? await listFactoryScorerRevisions(supabase, {
          workspaceId: scope.workspaceId,
          factoryId: scope.factoryId,
          scorerId: score.scorer_id,
          limit: 20,
          beforeRevisionNumber: page.beforeTargetRevision,
        }).catch(() => null)
      : null;
  return {
    review,
    reevaluations,
    page,
    canManage,
    paused: pause?.paused ?? false,
    targets:
      targets?.revisions.filter(
        ({ revision_number }) => revision_number > score.scorer_revision_number,
      ) ?? [],
    nextTarget:
      targets?.nextBeforeRevisionNumber &&
      targets.nextBeforeRevisionNumber > score.scorer_revision_number
        ? targets.nextBeforeRevisionNumber
        : null,
  };
}

export type RunEvaluationGovernance = Awaited<ReturnType<typeof loadRunEvaluationGovernance>>;

export function RunEvaluationControls({
  data,
  workspaceSlug,
  scope,
  receipt,
  visibleJobIds,
}: {
  data: RunEvaluationGovernance;
  workspaceSlug: string;
  scope: Pick<ScorerGovernanceScope, "workspaceId" | "factoryId">;
  receipt: Receipt;
  visibleJobIds: ReadonlySet<string | null>;
}) {
  const endpoint = `/api/workspaces/${scope.workspaceId}/factories/${scope.factoryId}/evaluation-attempts/${receipt.attempt_id}`;
  const reviewId = `adjudication-${receipt.attempt_id}`;
  const reevaluateId = `reevaluation-${receipt.attempt_id}`;
  const pageHref = (anchor: string, page: PageQuery) =>
    runAttemptHref(workspaceSlug, receipt.run_id, receipt.attempt_id, receipt.job_id, anchor, page);
  const review = data?.review;
  const reevaluations = data?.reevaluations;
  return (
    <div className="grid min-w-0 gap-4 border-t border-border pt-4">
      <section
        aria-labelledby={`${reviewId}-title`}
        className="scroll-mt-24 space-y-3"
        id={reviewId}
      >
        <h4 className="type-label font-semibold" id={`${reviewId}-title`}>
          Adjudication
        </h4>
        {review?.adjudications.length ? (
          <ul
            aria-label="Adjudication history"
            className="divide-y divide-border rounded-md border border-border"
          >
            {review.adjudications.map((record) => (
              <li className="space-y-1 px-3 py-2.5" key={record.id}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Status
                    compact
                    label={record.disposition === "disputed" ? "Disputed" : "Confirmed"}
                    value={record.disposition === "disputed" ? "needs_attention" : "approved"}
                  />
                  {record.expected_status ? (
                    <span className="type-secondary text-muted">
                      Expected {record.expected_status}
                    </span>
                  ) : null}
                  <time className="type-secondary text-muted" dateTime={record.created_at}>
                    {instant.format(new Date(record.created_at))} UTC
                  </time>
                </div>
                <p className="type-secondary whitespace-pre-wrap break-words">
                  {record.note ?? "Adjudication note withheld"}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="type-secondary text-muted">
            {review ? "No adjudications recorded." : "Adjudication history is unavailable."}
          </p>
        )}
        {review && data && (data.page.beforeAdjudicationId || review.has_more) ? (
          <nav aria-label="Adjudication history pages" className="flex flex-wrap gap-2">
            {data.page.beforeAdjudicationId ? (
              <Link
                className="ui-button"
                href={pageHref(reviewId, {
                  ...data.page,
                  beforeAdjudicationAt: undefined,
                  beforeAdjudicationId: undefined,
                })}
                prefetch={false}
              >
                Latest adjudications
              </Link>
            ) : null}
            {review.next_before_created_at && review.next_before_adjudication_id ? (
              <Link
                className="ui-button"
                href={pageHref(reviewId, {
                  ...data.page,
                  beforeAdjudicationAt: review.next_before_created_at,
                  beforeAdjudicationId: review.next_before_adjudication_id,
                })}
                prefetch={false}
              >
                Older adjudications
              </Link>
            ) : null}
          </nav>
        ) : null}
        {review?.can_adjudicate && !data?.page.beforeAdjudicationId ? (
          <AdjudicationForm endpoint={endpoint} />
        ) : null}
      </section>
      <section
        aria-labelledby={`${reevaluateId}-title`}
        className="scroll-mt-24 space-y-3 border-t border-border pt-4"
        id={reevaluateId}
      >
        <h4 className="type-label font-semibold" id={`${reevaluateId}-title`}>
          Re-evaluate
        </h4>
        {reevaluations?.jobs.length ? (
          <ul
            aria-label="Re-evaluation history"
            className="divide-y divide-border rounded-md border border-border"
          >
            {reevaluations.jobs.map((child) => (
              <li
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5"
                key={child.job_id}
              >
                {child.receipt || visibleJobIds.has(child.job_id) ? (
                  <Link
                    className="text-sm text-accent underline underline-offset-4"
                    href={runAttemptHref(
                      workspaceSlug,
                      receipt.run_id,
                      child.receipt?.attempt_id,
                      child.job_id,
                    )}
                    prefetch={false}
                  >
                    Open re-evaluation
                  </Link>
                ) : (
                  <span className="type-secondary text-muted">
                    Re-evaluation {child.job_id.slice(0, 8)}
                  </span>
                )}
                {child.status === "queued" || child.status === "claimed" ? (
                  <Status
                    compact
                    label={child.status === "queued" ? "Queued" : "Running"}
                    value={child.status === "queued" ? "queued" : "running"}
                  />
                ) : child.receipt ? (
                  <ScoreOutcome reason={child.receipt.reason} status={child.receipt.status} />
                ) : (
                  <Status
                    compact
                    label={child.status === "canceled" ? "Canceled" : "Judgment unavailable"}
                    value={child.status === "canceled" ? "canceled" : "needs_attention"}
                  />
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="type-secondary text-muted">
            {reevaluations
              ? "No re-evaluations on this page."
              : "Re-evaluation history is unavailable."}
          </p>
        )}
        {reevaluations &&
        data &&
        (data.page.beforeReevaluationJob || reevaluations.next_before_job_id) ? (
          <nav aria-label="Re-evaluation history pages" className="flex flex-wrap gap-2">
            {data.page.beforeReevaluationJob ? (
              <Link
                className="ui-button"
                href={pageHref(reevaluateId, {
                  ...data.page,
                  beforeReevaluationAt: undefined,
                  beforeReevaluationJob: undefined,
                })}
                prefetch={false}
              >
                Latest re-evaluations
              </Link>
            ) : null}
            {reevaluations.next_before_created_at && reevaluations.next_before_job_id ? (
              <Link
                className="ui-button"
                href={pageHref(reevaluateId, {
                  ...data.page,
                  beforeReevaluationAt: reevaluations.next_before_created_at,
                  beforeReevaluationJob: reevaluations.next_before_job_id,
                })}
                prefetch={false}
              >
                Older re-evaluations
              </Link>
            ) : null}
          </nav>
        ) : null}
        {data?.canManage ? (
          data.paused ? (
            <p className="type-secondary text-muted">
              Resume this scorer to admit a re-evaluation.
            </p>
          ) : receipt.evidence_availability === "withheld" ? (
            <p className="type-secondary text-muted">The source evidence is withheld.</p>
          ) : data.targets.length ? (
            <ReevaluationForm endpoint={endpoint} revisions={data.targets} />
          ) : (
            <p className="type-secondary text-muted">
              No newer rubric revisions are available on this page.
            </p>
          )
        ) : null}
        {data?.canManage && (data.page.beforeTargetRevision || data.nextTarget) ? (
          <nav aria-label="Re-evaluation target revision pages" className="flex flex-wrap gap-2">
            {data.page.beforeTargetRevision ? (
              <Link
                className="ui-button"
                href={pageHref(reevaluateId, { ...data.page, beforeTargetRevision: undefined })}
                prefetch={false}
              >
                Latest rubric revisions
              </Link>
            ) : null}
            {data.nextTarget ? (
              <Link
                className="ui-button"
                href={pageHref(reevaluateId, {
                  ...data.page,
                  beforeTargetRevision: data.nextTarget,
                })}
                prefetch={false}
              >
                Older rubric revisions
              </Link>
            ) : null}
          </nav>
        ) : null}
      </section>
    </div>
  );
}
