import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

import {
  type EvaluationGovernanceCommand,
  type ScorerGovernanceCommand,
  evaluationReviewSchema,
  scorerAdjudicationSchema,
  scorerCalibrationRevisionSchema,
  scorerCalibrationSchema,
  scorerPauseHistorySchema,
  scorerPauseSchema,
  scorerReevaluationSchema,
  scorerReevaluationsSchema,
} from "./scorer-governance-contracts";

type Client = Pick<SupabaseClient<Database>, "rpc">;
export type ScorerGovernanceScope = { workspaceId: string; factoryId: string };
export type ScorerGovernanceActor = ScorerGovernanceScope & { actorUserId: string };

function scoped({ workspaceId, factoryId }: ScorerGovernanceScope) {
  return { p_workspace_id: workspaceId, p_factory_id: factoryId };
}

function scopedActor(scope: ScorerGovernanceActor) {
  return { ...scoped(scope), p_actor_user_id: scope.actorUserId };
}

export async function readScorerPause(
  client: Client,
  scope: ScorerGovernanceScope,
  scorerId: string,
  beforePauseRevision?: number,
) {
  const { data, error } = await client.rpc("get_factory_scorer_pause", {
    ...scoped(scope),
    p_scorer_id: scorerId,
    p_before_pause_revision: beforePauseRevision,
  });
  if (error) throw error;
  return scorerPauseHistorySchema.parse(data);
}

export async function readScorerCalibration(
  client: Client,
  scope: ScorerGovernanceScope,
  scorerId: string,
  selection: {
    setId?: string;
    beforeRevision?: number;
    beforeSetAt?: string;
    beforeSetId?: string;
    beforeCandidateAt?: string;
    beforeCandidateId?: string;
  },
) {
  const { data, error } = await client.rpc("read_factory_scorer_calibration", {
    ...scoped(scope),
    p_scorer_id: scorerId,
    p_set_id: selection.setId,
    p_before_revision: selection.beforeRevision,
    p_before_set_at: selection.beforeSetAt,
    p_before_set_id: selection.beforeSetId,
    p_before_candidate_at: selection.beforeCandidateAt,
    p_before_candidate_id: selection.beforeCandidateId,
  });
  if (error) throw error;
  const calibration = scorerCalibrationSchema.parse(data);
  if (selection.setId && calibration.versions.some(({ set_id }) => set_id !== selection.setId)) {
    throw new Error("Calibration history did not match the selected set.");
  }
  return calibration;
}

export async function readEvaluationReview(
  client: Client,
  scope: ScorerGovernanceScope,
  attemptId: string,
  before?: { createdAt: string; adjudicationId: string },
  selectedAdjudicationId?: string,
) {
  const { data, error } = await client.rpc("read_factory_evaluation_review", {
    ...scoped(scope),
    p_attempt_id: attemptId,
    p_before_created_at: before?.createdAt,
    p_before_adjudication_id: before?.adjudicationId,
    p_selected_adjudication_id: selectedAdjudicationId,
  });
  if (error) throw error;
  const review = evaluationReviewSchema.parse(data);
  if (
    review.adjudications.some(({ attempt_id }) => attempt_id !== attemptId) ||
    (review.selected_adjudication &&
      (review.selected_adjudication.attempt_id !== attemptId ||
        review.selected_adjudication.id !== selectedAdjudicationId))
  ) {
    throw new Error("Evaluation review did not match the selected attempt.");
  }
  return review;
}

export async function readScorerReevaluations(
  client: Client,
  scope: ScorerGovernanceScope,
  attemptId: string,
  runId: string,
  before?: { createdAt: string; jobId: string },
) {
  const { data, error } = await client.rpc("list_factory_scorer_reevaluations", {
    ...scoped(scope),
    p_prior_attempt_id: attemptId,
    p_before_created_at: before?.createdAt,
    p_before_job_id: before?.jobId,
  });
  if (error) throw error;
  const reevaluations = scorerReevaluationsSchema.parse(data);
  if (
    reevaluations.jobs.some(
      ({ prior_attempt_id, target_scorer_revision_id, job_id, receipt }) =>
        prior_attempt_id !== attemptId ||
        (receipt &&
          (receipt.run_id !== runId ||
            receipt.workspace_id !== scope.workspaceId ||
            receipt.factory_id !== scope.factoryId ||
            receipt.job_id !== job_id ||
            receipt.scorer_revision_id !== target_scorer_revision_id)),
    )
  )
    throw new Error("Re-evaluation history did not match the selected attempt.");
  return reevaluations;
}

export async function applyScorerGovernance(
  client: Client,
  scope: ScorerGovernanceActor,
  scorerId: string,
  command: ScorerGovernanceCommand,
) {
  const target = { ...scopedActor(scope), p_scorer_id: scorerId };
  if (command.action === "pause") {
    const { data, error } = await client.rpc("configure_factory_scorer_pause", {
      ...target,
      p_expected_revision: command.expectedRevision,
      p_paused: command.paused,
    });
    if (error) throw error;
    const pause = scorerPauseSchema.parse(data);
    if (pause.paused !== command.paused) throw new Error("Unexpected scorer pause response.");
    return { action: command.action, pause };
  }

  const { data, error } = await client.rpc("save_factory_scorer_calibration_revision", {
    ...target,
    p_set_id: command.setId,
    p_expected_revision: command.expectedRevision,
    p_scorer_revision_id: command.scorerRevisionId,
    p_name: command.name,
    p_adjudication_ids: command.adjudicationIds,
  });
  if (error) throw error;
  const calibration = scorerCalibrationRevisionSchema.parse(data);
  if (
    calibration.set_id !== command.setId.toLowerCase() ||
    calibration.scorer_revision_id !== command.scorerRevisionId.toLowerCase()
  ) {
    throw new Error("Calibration revision did not match the requested set.");
  }
  return { action: command.action, calibration };
}

export async function applyEvaluationGovernance(
  client: Client,
  scope: ScorerGovernanceActor,
  attemptId: string,
  command: EvaluationGovernanceCommand,
) {
  if (command.action === "adjudicate") {
    const { data, error } = await client.rpc("adjudicate_factory_evaluation_receipt", {
      ...scopedActor(scope),
      p_attempt_id: attemptId,
      p_adjudication_id: command.adjudicationId,
      p_disposition: command.disposition,
      p_note: command.note,
      p_expected_status: command.expectedStatus,
    });
    if (error) throw error;
    const adjudication = scorerAdjudicationSchema.parse(data);
    if (
      adjudication.attempt_id !== attemptId ||
      adjudication.id !== command.adjudicationId.toLowerCase()
    ) {
      throw new Error("Evaluation adjudication did not match the requested attempt.");
    }
    return { action: command.action, adjudication };
  }

  const { data, error } = await client.rpc("request_factory_scorer_reevaluation", {
    ...scopedActor(scope),
    p_prior_attempt_id: attemptId,
    p_target_revision_id: command.targetRevisionId,
  });
  if (error) throw error;
  const reevaluation = scorerReevaluationSchema.parse(data);
  if (
    reevaluation.prior_attempt_id !== attemptId ||
    reevaluation.target_scorer_revision_id !== command.targetRevisionId.toLowerCase()
  ) {
    throw new Error("Re-evaluation did not match the requested attempt.");
  }
  return { action: command.action, reevaluation };
}
