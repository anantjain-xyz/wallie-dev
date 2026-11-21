import "server-only";

import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { BenchmarkComparisonExports } from "@/features/factory-benchmarks/benchmark-comparison-exports";
import { BenchmarkComparisonFrontier } from "@/features/factory-benchmarks/benchmark-comparison-frontier";
import { BenchmarkComparisonResults } from "@/features/factory-benchmarks/benchmark-comparison-results";
import { loadBenchmarkScope } from "@/features/factory-benchmarks/suites-data";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
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
import { benchmarkFrontierQuerySchema } from "@/lib/factory-benchmarks/frontier-contracts";
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
  if (!ids.success || !trials.success || !history.success || !frontierQuery.success) notFound();
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
    readBenchmarkFrontier(reportScope, frontierQuery.data),
  ]).catch((error: unknown) => {
    if (error instanceof BenchmarkComparisonError && [400, 403, 404].includes(error.status)) {
      notFound();
    }
    throw error;
  });
  if (comparison.suite.id !== suiteId || frontier.suite.id !== suiteId) notFound();

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
          <Link className="ui-button" href="#result-exports">
            Result exports
          </Link>
        }
      />
      <div className="space-y-8">
        <BenchmarkComparisonResults
          comparison={comparison}
          frontier={
            <BenchmarkComparisonFrontier
              frontier={frontier}
              action={`${workspaceBenchmarkComparisonPath(workspaceSlug, suiteId, experimentId)}#cost-quality-frontier`}
              preservedQuery={resultCursors}
              firstHref={
                frontierQuery.data.afterCandidateKey
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
