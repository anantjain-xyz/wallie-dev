import "server-only";

import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { BenchmarkComparisonExports } from "@/features/factory-benchmarks/benchmark-comparison-exports";
import { BenchmarkComparisonFrontier } from "@/features/factory-benchmarks/benchmark-comparison-frontier";
import { BenchmarkComparisonResults } from "@/features/factory-benchmarks/benchmark-comparison-results";
import { comparisonScheduleHandoff } from "@/features/factory-benchmarks/benchmark-comparison-schedule";
import { loadBenchmarkScope } from "@/features/factory-benchmarks/suites-data";
import {
  isWorkspaceOperator,
  loadAuthenticatedWorkspaceContext,
} from "@/features/workspaces/authenticated-context";
import {
  BenchmarkComparisonError,
  listBenchmarkComparisonExports,
  readBenchmarkComparison,
  readBenchmarkFrontier,
} from "@/lib/factory-benchmarks/comparison";
import {
  benchmarkComparisonExportListQuerySchema,
  benchmarkComparisonIdSchema,
  benchmarkComparisonQuerySchema,
} from "@/lib/factory-benchmarks/comparison-contracts";
import { benchmarkReplayPolicyLabels } from "@/lib/factory-benchmarks/comparison-labels";
import { loadBenchmarkDefinitionChoices } from "@/lib/factory-benchmarks/experiment-axes";
import {
  benchmarkFrontierQuerySchema,
  type BenchmarkFrontierQuery,
} from "@/lib/factory-benchmarks/frontier-contracts";
import {
  workspaceBenchmarkComparisonPath,
  workspaceBenchmarkSuitePath,
  workspaceBenchmarkTrialPath,
} from "@/lib/routes";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const comparisonIds = z.object({
  workspaceSlug: z.string(),
  suiteId: benchmarkComparisonIdSchema,
  experimentId: benchmarkComparisonIdSchema,
});

const numberInput = z
  .string()
  .max(24)
  .regex(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i)
  .transform(Number);

const qualityFloorPercent = numberInput
  .pipe(z.number().min(0).max(100))
  .transform((value) => value * 100)
  .refine((scaled) => Math.abs(scaled - Math.round(scaled)) < 1e-9)
  .transform((scaled) => String(Math.round(scaled)))
  .optional();

const minimumResolvedTrials = numberInput.pipe(z.number().int()).transform(String).optional();

async function readFrontierAtRoutingCandidate(
  scope: Parameters<typeof readBenchmarkFrontier>[0],
  query: BenchmarkFrontierQuery,
  candidateKey: string,
) {
  const candidates = await scope.admin
    .from("factory_benchmark_experiment_candidates")
    .select("candidate_key")
    .eq("workspace_id", scope.workspaceId)
    .eq("factory_id", scope.factoryId)
    .eq("experiment_id", scope.experimentId)
    .not("comparison_position", "is", null)
    .order("comparison_position")
    .limit(100);
  if (candidates.error) throw candidates.error;
  const target = candidates.data.findIndex(({ candidate_key }) => candidate_key === candidateKey);
  if (target < 0) notFound();
  return readBenchmarkFrontier(scope, {
    ...query,
    afterCandidateKey: candidates.data[target - 1]?.candidate_key,
  });
}

export default async function BenchmarkComparisonPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string; suiteId: string; experimentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [rawIds, query] = await Promise.all([params, searchParams]);
  const ids = comparisonIds.safeParse(rawIds);
  const trials = benchmarkComparisonQuerySchema.safeParse({
    afterTrialId: query.afterTrialId,
    afterCandidateKey: query.afterCandidateKey,
    limit: "24",
    candidateLimit: "16",
  });
  const history = benchmarkComparisonExportListQuerySchema.safeParse({
    beforeCapturedAt: query.beforeCapturedAt,
    beforeExportId: query.beforeExportId,
    limit: "12",
  });
  const constraints = z
    .object({ qualityFloorPercent, minResolvedTrials: minimumResolvedTrials })
    .safeParse(query);
  if (!constraints.success) notFound();
  const frontierQuery = benchmarkFrontierQuerySchema.safeParse({
    scorerRevisionId: query.scorerRevisionId,
    qualityFloorBps: constraints.data.qualityFloorPercent,
    minResolvedTrials: constraints.data.minResolvedTrials,
    afterCandidateKey: query.afterFrontierCandidateKey,
    limit: "16",
  });
  const routingCandidateKey = benchmarkFrontierQuerySchema.shape.afterCandidateKey.safeParse(
    query.routingCandidateKey,
  );
  if (
    !ids.success ||
    !trials.success ||
    !history.success ||
    !frontierQuery.success ||
    !routingCandidateKey.success
  )
    notFound();
  const { workspaceSlug, suiteId, experimentId } = ids.data;
  const [scope, access] = await Promise.all([
    loadBenchmarkScope(workspaceSlug, query.factory, suiteId),
    loadAuthenticatedWorkspaceContext(workspaceSlug),
  ]);
  if (!scope?.factory.canManage) notFound();
  const { workspaceId, factory } = scope;

  const reportScope = {
    admin: createSupabaseAdminClient(),
    workspaceId,
    factoryId: factory.id,
    actorUserId: access.user.id,
    experimentId,
  };
  const [comparison, exports, frontier] = await Promise.all([
    readBenchmarkComparison(reportScope, trials.data),
    listBenchmarkComparisonExports(reportScope, history.data),
    routingCandidateKey.data
      ? readFrontierAtRoutingCandidate(reportScope, frontierQuery.data, routingCandidateKey.data)
      : readBenchmarkFrontier(reportScope, frontierQuery.data),
  ]).catch((error: unknown) => {
    if (error instanceof BenchmarkComparisonError && [400, 403, 404].includes(error.status)) {
      notFound();
    }
    throw error;
  });
  if (comparison.suite.id !== suiteId || frontier.suite.id !== suiteId) notFound();

  const fetchSchedulePins =
    scope.canEdit && comparison.scheduleState === "unconfigured" && comparison.counts.eligible > 0;
  const [definitions, policy, schedulePins] = await Promise.all([
    loadBenchmarkDefinitionChoices({
      supabase: scope.supabase,
      workspaceId,
      factoryId: factory.id,
      revisionIds: [
        ...new Set(comparison.candidates.map(({ definitionRevisionId }) => definitionRevisionId)),
      ],
      frozenAt: comparison.createdAt,
    }),
    scope.supabase
      .from("factory_benchmark_replay_policy_revisions")
      .select("revision_number,profile")
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factory.id)
      .eq("id", comparison.policyRevisionId)
      .eq("policy_digest", comparison.policyDigest)
      .maybeSingle(),
    fetchSchedulePins
      ? scope.supabase
          .from("factory_benchmark_experiment_candidates")
          .select(
            "qualification_id,worker_runtime,live_inference_connection_revision,sandbox_connection_revision",
          )
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factory.id)
          .eq("experiment_id", comparison.experimentId)
          .limit(100)
      : null,
  ]);
  if (policy.error) throw policy.error;
  if (schedulePins?.error) throw schedulePins.error;
  const scheduleHandoff = comparisonScheduleHandoff({
    canConfigure: scope.canEdit,
    comparison,
    endpoint: `/api/workspaces/${workspaceId}/factories/${factory.id}/benchmarks/experiments/${comparison.experimentId}/schedule`,
    policyProfile: policy.data?.profile,
    pins: schedulePins?.data ?? undefined,
  });
  const requiresScorerChoice =
    comparison.scorers.length > 1 && !frontierQuery.data.scorerRevisionId;
  const resultCursors = {
    factory: factory.id,
    afterTrialId: trials.data.afterTrialId,
    afterCandidateKey: trials.data.afterCandidateKey,
    beforeCapturedAt: history.data.beforeCapturedAt,
    beforeExportId: history.data.beforeExportId,
  };
  const href = (extra: Record<string, string | undefined>) =>
    workspaceBenchmarkComparisonPath(workspaceSlug, suiteId, experimentId, {
      ...resultCursors,
      scorerRevisionId: frontierQuery.data.scorerRevisionId,
      qualityFloorPercent:
        typeof query.qualityFloorPercent === "string" ? query.qualityFloorPercent : undefined,
      minResolvedTrials:
        typeof query.minResolvedTrials === "string" ? query.minResolvedTrials : undefined,
      afterFrontierCandidateKey: frontierQuery.data.afterCandidateKey,
      ...extra,
    });

  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader
        title="Comparison results"
        description={`${comparison.suite.name} · Revision ${comparison.suite.revisionNumber}`}
        eyebrow={
          <Link
            className="hover:text-foreground"
            href={workspaceBenchmarkSuitePath(workspaceSlug, suiteId, {
              factory: factory.id,
              revision: comparison.suite.revisionId,
            })}
          >
            ← Benchmark suite
          </Link>
        }
        eyebrowAsPlain
        actionsRightOnDesktop
        actions={
          <>
            <Link className="ui-button" href="#comparison-trials">
              Inspect trials
            </Link>
            <Link className="ui-button" href="#result-exports">
              Result exports
            </Link>
          </>
        }
      />
      <div className="space-y-8">
        <BenchmarkComparisonResults
          comparison={comparison}
          definitionLabels={Object.fromEntries(
            definitions.map(({ id, digest, label }) => [`${id}:${digest}`, label]),
          )}
          policyLabel={
            policy.data
              ? `Revision ${policy.data.revision_number} · ${benchmarkReplayPolicyLabels[policy.data.profile]}`
              : "Replay policy revision unavailable"
          }
          scheduleHandoff={scheduleHandoff}
          trialPageKey={`${experimentId}:${trials.data.afterTrialId ?? ""}`}
          frontier={
            <BenchmarkComparisonFrontier
              frontier={frontier}
              action={`${workspaceBenchmarkComparisonPath(workspaceSlug, suiteId, experimentId)}#cost-quality-frontier`}
              preservedQuery={resultCursors}
              requiresScorerChoice={requiresScorerChoice}
              routingDraft={
                isWorkspaceOperator(access.currentMember)
                  ? { workspaceId, workspaceSlug, factoryId: factory.id }
                  : undefined
              }
              firstHref={
                frontierQuery.data.afterCandidateKey || routingCandidateKey.data
                  ? `${href({ afterFrontierCandidateKey: undefined })}#cost-quality-frontier`
                  : undefined
              }
              nextHref={
                frontier.nextCursor
                  ? `${href({ afterFrontierCandidateKey: frontier.nextCursor.candidateKey })}#cost-quality-frontier`
                  : undefined
              }
            />
          }
          trialHref={(trialId) =>
            workspaceBenchmarkTrialPath(workspaceSlug, suiteId, experimentId, trialId, {
              factory: factory.id,
              afterTrialId: trials.data.afterTrialId,
              afterCandidateKey: trials.data.afterCandidateKey,
              scorerRevisionId: frontierQuery.data.scorerRevisionId,
              qualityFloorPercent:
                typeof query.qualityFloorPercent === "string"
                  ? query.qualityFloorPercent
                  : undefined,
              minResolvedTrials:
                typeof query.minResolvedTrials === "string" ? query.minResolvedTrials : undefined,
              afterFrontierCandidateKey: frontierQuery.data.afterCandidateKey,
            })
          }
          firstTrialsHref={
            trials.data.afterTrialId
              ? `${href({ afterTrialId: undefined })}#comparison-trials`
              : undefined
          }
          nextTrialsHref={
            comparison.nextCursor
              ? `${href({ afterTrialId: comparison.nextCursor.trialId })}#comparison-trials`
              : undefined
          }
          firstConfigurationsHref={
            trials.data.afterCandidateKey
              ? `${href({ afterCandidateKey: undefined })}#comparison-configurations`
              : undefined
          }
          nextConfigurationsHref={
            comparison.nextCandidateCursor
              ? `${href({ afterCandidateKey: comparison.nextCandidateCursor.candidateKey })}#comparison-configurations`
              : undefined
          }
        />
        <BenchmarkComparisonExports
          endpoint={`/api/workspaces/${workspaceId}/factories/${factory.id}/benchmarks/experiments/${experimentId}/exports`}
          initialReceipts={exports.items}
          pagination={
            history.data.beforeExportId || exports.nextCursor ? (
              <nav
                aria-label="Result export pages"
                className="flex flex-wrap gap-2 px-4 py-3 sm:px-5"
              >
                {history.data.beforeExportId ? (
                  <Link
                    className="ui-button"
                    href={`${href({ beforeCapturedAt: undefined, beforeExportId: undefined })}#result-exports`}
                    prefetch={false}
                  >
                    Latest exports
                  </Link>
                ) : null}
                {exports.nextCursor ? (
                  <Link
                    className="ui-button"
                    href={`${href({
                      beforeCapturedAt: exports.nextCursor.capturedAt,
                      beforeExportId: exports.nextCursor.exportId,
                    })}#result-exports`}
                    prefetch={false}
                  >
                    Older exports
                  </Link>
                ) : null}
              </nav>
            ) : null
          }
        />
      </div>
    </PageContainer>
  );
}
