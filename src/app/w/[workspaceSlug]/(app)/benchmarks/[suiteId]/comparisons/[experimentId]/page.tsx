import "server-only";

import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { BenchmarkComparisonExports } from "@/features/factory-benchmarks/benchmark-comparison-exports";
import { BenchmarkComparisonResults } from "@/features/factory-benchmarks/benchmark-comparison-results";
import { loadBenchmarkScope } from "@/features/factory-benchmarks/suites-data";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
import {
  BenchmarkComparisonError,
  listBenchmarkComparisonExports,
  readBenchmarkComparison,
} from "@/lib/factory-benchmarks/comparison";
import {
  benchmarkComparisonExportListQuerySchema,
  benchmarkComparisonIdSchema,
  benchmarkComparisonQuerySchema,
} from "@/lib/factory-benchmarks/comparison-contracts";
import { workspaceBenchmarkComparisonPath, workspaceBenchmarkSuitePath } from "@/lib/routes";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const comparisonIds = z.object({
  workspaceSlug: z.string(),
  suiteId: benchmarkComparisonIdSchema,
  experimentId: benchmarkComparisonIdSchema,
});

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
  if (!ids.success || !trials.success || !history.success) notFound();
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
  const [comparison, exports] = await Promise.all([
    readBenchmarkComparison(reportScope, trials.data),
    listBenchmarkComparisonExports(reportScope, history.data),
  ]).catch((error: unknown) => {
    if (error instanceof BenchmarkComparisonError && [400, 403, 404].includes(error.status)) {
      notFound();
    }
    throw error;
  });
  if (comparison.suite.id !== suiteId) notFound();

  const href = (extra: Record<string, string | undefined>) =>
    workspaceBenchmarkComparisonPath(workspaceSlug, suiteId, experimentId, {
      factory: factory.id,
      afterTrialId: trials.data.afterTrialId,
      afterCandidateKey: trials.data.afterCandidateKey,
      beforeCapturedAt: history.data.beforeCapturedAt,
      beforeExportId: history.data.beforeExportId,
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
