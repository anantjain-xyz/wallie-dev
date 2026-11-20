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
  selection?: ScorerSelection | { scorerRevisionId: string },
  before?: { createdAt?: string; policyId?: string },
) {
  const { data, error } = await client.rpc("list_factory_score_cohorts", {
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    p_scorer_id: selection && "scorerId" in selection ? selection.scorerId : undefined,
    p_scorer_revision_id: selection?.scorerRevisionId,
    p_before_created_at: before?.createdAt,
    p_before_policy_id: before?.policyId,
    p_limit: 100,
  });
  if (error) throw error;
  return scoreCohortPageSchema.parse(data);
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
  const beforeCohort = { createdAt: query.beforeCohortAt, policyId: query.beforeCohortPolicy };
  const [revisionOptions, requestedCohorts, selectedTrend] = await Promise.all([
    selection
      ? null
      : listCohorts(client, scope, undefined, {
          createdAt: query.beforeRevisionAt,
          policyId: query.beforeRevisionPolicy,
        }),
    requestedRevision
      ? listCohorts(
          client,
          scope,
          selection ?? { scorerRevisionId: requestedRevision },
          beforeCohort,
        )
      : null,
    query.cohort ? readTrend(client, scope, query.cohort, query) : null,
  ]);
  const listed = revisionOptions?.cohorts ?? [];
  const revisionId =
    requestedRevision ??
    (selectedTrend === "limit" ? null : selectedTrend?.cohort.scorer_revision_id) ??
    listed.find(({ policy_id }) => policy_id === query.cohort)?.scorer_revision_id ??
    listed[0]?.scorer_revision_id;
  const firstPolicy =
    requestedCohorts?.cohorts[0] ?? (!query.beforeCohortPolicy ? listed[0] : undefined);
  const [cohortOptions, defaultTrend] = await Promise.all([
    requestedCohorts ??
      (revisionId
        ? listCohorts(client, scope, { scorerRevisionId: revisionId }, beforeCohort)
        : null),
    !query.cohort && firstPolicy && firstPolicy.scorer_revision_id === revisionId
      ? readTrend(client, scope, firstPolicy.policy_id, query)
      : null,
  ]);
  const policyId = query.cohort ?? cohortOptions?.cohorts[0]?.policy_id;
  const read = query.cohort
    ? selectedTrend
    : firstPolicy?.policy_id === policyId
      ? defaultTrend
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
  const cohorts = new Map(cohortOptions?.cohorts.map((cohort) => [cohort.policy_id, cohort]));
  if (trend) cohorts.set(trend.cohort.policy_id, trend.cohort);
  const revisions = new Map(listed.map((cohort) => [cohort.scorer_revision_id, cohort]));
  const selected = trend?.cohort ?? cohortOptions?.cohorts[0];
  if (selected) revisions.set(selected.scorer_revision_id, selected);
  return {
    cohorts: [...cohorts.values()],
    revisions: [...revisions.values()],
    nextCohort: cohortOptions?.next ?? null,
    nextRevision: revisionOptions?.next ?? null,
    trend,
    revisionId,
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
