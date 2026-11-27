import "server-only";

import { notFound } from "next/navigation";
import { z } from "zod";

import { BenchmarkTrialEvidenceView } from "@/features/factory-benchmarks/benchmark-trial-evidence-view";
import { loadBenchmarkScope } from "@/features/factory-benchmarks/suites-data";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
import { BenchmarkComparisonError } from "@/lib/factory-benchmarks/comparison";
import {
  benchmarkComparisonIdSchema,
  benchmarkComparisonQuerySchema,
} from "@/lib/factory-benchmarks/comparison-contracts";
import { readBenchmarkTrialPageEvidence } from "@/lib/factory-benchmarks/trial-evidence";
import { WorkspaceResourceScope } from "@/components/app-shell/workspace-factory-page.server";
import { workspaceBenchmarkComparisonPath, workspaceBenchmarkTrialPath } from "@/lib/routes";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const pathSchema = z.object({
  workspaceSlug: z.string(),
  suiteId: benchmarkComparisonIdSchema,
  experimentId: benchmarkComparisonIdSchema,
  trialId: benchmarkComparisonIdSchema,
});

export default async function BenchmarkTrialPage({
  params,
  searchParams,
}: {
  params: Promise<{
    workspaceSlug: string;
    suiteId: string;
    experimentId: string;
    trialId: string;
  }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [rawPath, query] = await Promise.all([params, searchParams]);
  const path = pathSchema.safeParse(rawPath);
  const from = benchmarkComparisonQuerySchema.safeParse({
    afterTrialId: query.afterTrialId,
    afterCandidateKey: query.afterCandidateKey,
  });
  if (!path.success || !from.success) notFound();
  const { workspaceSlug, suiteId, experimentId, trialId } = path.data;
  const [scope, access] = await Promise.all([
    loadBenchmarkScope(workspaceSlug, query.factory, suiteId),
    loadAuthenticatedWorkspaceContext(workspaceSlug),
  ]);
  if (!scope?.factory.canManage) notFound();
  const { workspaceId, factory } = scope;

  const evidenceScope = {
    admin: createSupabaseAdminClient(),
    workspaceId,
    factoryId: factory.id,
    actorUserId: access.user.id,
    experimentId,
    trialId,
  };
  const { detail, transcript } = await readBenchmarkTrialPageEvidence(evidenceScope, suiteId).catch(
    (error: unknown) => {
      if (error instanceof BenchmarkComparisonError && [400, 403, 404].includes(error.status)) {
        notFound();
      }
      throw error;
    },
  );

  return (
    <>
      <WorkspaceResourceScope
        factoryId={factory.id}
        pathname={workspaceBenchmarkTrialPath(
          workspaceSlug,
          rawPath.suiteId,
          rawPath.experimentId,
          rawPath.trialId,
        )}
        workspaceSlug={workspaceSlug}
      />
      <BenchmarkTrialEvidenceView
        detail={detail}
        endpoint={`/api/workspaces/${workspaceId}/factories/${factory.id}/benchmarks/experiments/${experimentId}/trials/${trialId}`}
        transcript={transcript}
        comparisonHref={`${workspaceBenchmarkComparisonPath(workspaceSlug, suiteId, experimentId, {
          factory: factory.id,
          afterTrialId: from.data.afterTrialId,
          afterCandidateKey: from.data.afterCandidateKey,
        })}#trial-${trialId}`}
      />
    </>
  );
}
