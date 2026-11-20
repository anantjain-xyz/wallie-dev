import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

import { runScoresSchema, scoreCohortPageSchema, scoreTrendSchema } from "./score-trend-contracts";
import type { ScorerTrendQuery } from "./score-trend-query";

type Client = SupabaseClient<Database>;
type FactoryScope = { workspaceId: string; factoryId: string };
type ScorerSelection = { scorerId: string; scorerRevisionId: string };

async function listCohorts(
  client: Client,
  scope: FactoryScope,
  selection?: Partial<ScorerSelection>,
) {
  const { data, error } = await client.rpc("list_factory_score_cohorts", {
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    p_scorer_id: selection?.scorerId,
    p_scorer_revision_id: selection?.scorerRevisionId,
    p_limit: 100,
  });
  if (error) throw error;
  return scoreCohortPageSchema.parse(data).cohorts;
}

async function readTrend(
  client: Client,
  scope: FactoryScope,
  policyId: string,
  query: ScorerTrendQuery,
) {
  const { data, error } = await client.rpc("read_factory_score_cohort", {
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    p_policy_id: policyId,
    p_from: `${query.from}T00:00:00Z`,
    p_to: `${query.to}T00:00:00Z`,
    p_snapshot: query.scoreSnapshot,
    p_bucket_at: query.evaluationDay ? `${query.evaluationDay}T00:00:00Z` : undefined,
    p_status: query.evaluationStatus,
    p_before_run_finished_at: query.beforeRunFinishedAt,
    p_before_run_id: query.beforeScoreRun,
    p_limit: 25,
  });
  if (error?.code === "P0002" || error?.code === "22023") return null;
  if (error?.code === "PT422") return "limit" as const;
  if (error) throw error;
  return data === null ? null : scoreTrendSchema.parse(data);
}

export async function loadScoreTrendPanel(
  client: Client,
  scope: FactoryScope,
  query: ScorerTrendQuery,
  selection?: ScorerSelection,
) {
  const requestedRevision = selection?.scorerRevisionId ?? query.scorerRevision;
  const [recentCohorts, revisionCohorts, selectedTrend] = await Promise.all([
    listCohorts(client, scope, selection),
    !selection && requestedRevision
      ? listCohorts(client, scope, { scorerRevisionId: requestedRevision })
      : [],
    query.cohort ? readTrend(client, scope, query.cohort, query) : null,
  ]);
  const recent = recentCohorts.find(
    ({ scorer_revision_id }) => !requestedRevision || scorer_revision_id === requestedRevision,
  );
  const policyId = query.cohort ?? revisionCohorts[0]?.policy_id ?? recent?.policy_id;
  const read = query.cohort
    ? selectedTrend
    : policyId
      ? await readTrend(client, scope, policyId, query)
      : null;
  let trend = read === "limit" ? null : read;
  if (
    trend &&
    (trend.cohort.policy_id !== policyId ||
      (requestedRevision && trend.cohort.scorer_revision_id !== requestedRevision) ||
      (selection && trend.cohort.scorer_id !== selection.scorerId) ||
      (query.scoreSnapshot && trend.snapshot !== query.scoreSnapshot))
  ) {
    trend = null;
  }
  const cohorts = new Map(
    [...revisionCohorts, ...recentCohorts].map((cohort) => [cohort.policy_id, cohort]),
  );
  if (trend) cohorts.set(trend.cohort.policy_id, trend.cohort);
  return {
    cohorts: [...cohorts.values()],
    trend,
    requestedRevision,
    policyId,
    ...(read === "limit" ? { limitExceeded: true } : {}),
  };
}

export type ScoreTrendPanelData = Awaited<ReturnType<typeof loadScoreTrendPanel>>;

export async function loadRunScores(
  client: Client,
  scope: { workspaceId: string; sessionId: string; runId: string; evaluationAttempt?: string },
) {
  const { data: session, error: sessionError } = await client
    .from("sessions")
    .select("factory_id")
    .eq("workspace_id", scope.workspaceId)
    .eq("id", scope.sessionId)
    .maybeSingle();
  if (sessionError) throw sessionError;
  if (!session?.factory_id) return null;
  const factoryId = session.factory_id;
  const { data, error } = await client.rpc("list_factory_run_score_results", {
    p_workspace_id: scope.workspaceId,
    p_factory_id: factoryId,
    p_run_id: scope.runId,
    p_attempt_id: scope.evaluationAttempt,
  });
  if (error) throw error;
  const scores = runScoresSchema.parse(data);
  if (
    scope.evaluationAttempt &&
    !scores.some(({ receipt }) => receipt?.attempt_id === scope.evaluationAttempt)
  ) {
    throw new Error("Score attempt was unavailable on this run.");
  }
  if (
    scores.some(
      ({ receipt, diff, evaluation_job_id, scorer_revision_id }) =>
        receipt &&
        (receipt.workspace_id !== scope.workspaceId ||
          receipt.factory_id !== factoryId ||
          receipt.session_id !== scope.sessionId ||
          receipt.run_id !== scope.runId ||
          receipt.job_id !== evaluation_job_id ||
          receipt.scorer_revision_id !== scorer_revision_id ||
          (diff && diff.output_sha !== receipt.target_commit_sha)),
    )
  )
    throw new Error("Score did not match the active run scope.");
  return { factoryId, scores };
}

export type RunScoreData = Awaited<ReturnType<typeof loadRunScores>>;
