import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { resolveQueuedRunConfig } from "@/lib/wallie/service";
import { wakeWorker } from "@/lib/worker/wake";

import {
  specificationAnswerReceiptSchema,
  type SessionSpecificationState,
  type SpecificationAnswer,
} from "./specification-contracts";

type Client = SupabaseClient<Database>;

export async function findSpecificationSession(reader: Pick<Client, "from">, sessionId: string) {
  const { data, error } = await reader
    .from("sessions")
    .select(
      "id, workspace_id, factory_id, specification_stage_id, archived_at, phase_status, current_stage_id, current_artifact_id, current_artifact_version, artifact_review_revision",
    )
    .eq("id", sessionId)
    .maybeSingle();
  if (error) throw error;
  return data?.specification_stage_id
    ? { ...data, specification_stage_id: data.specification_stage_id }
    : null;
}

type SpecificationSession = NonNullable<Awaited<ReturnType<typeof findSpecificationSession>>>;

function canAnswer(session: SpecificationSession) {
  return (
    session.archived_at === null &&
    session.phase_status === "awaiting_review" &&
    session.current_stage_id === session.specification_stage_id
  );
}

export async function readSessionSpecification(
  reader: Pick<Client, "from">,
  session: SpecificationSession,
): Promise<SessionSpecificationState> {
  const state = {
    stageId: session.specification_stage_id,
    artifactId: session.current_artifact_id,
    artifactVersion: session.current_artifact_version,
    reviewable: canAnswer(session),
    clarification: null,
  };
  if (!session.current_artifact_id || session.current_stage_id !== session.specification_stage_id) {
    return state;
  }

  const { data, error } = await reader
    .from("session_specification_clarifications")
    .select("id, artifact_id, artifact_version, question, status, execution_exhausted")
    .eq("workspace_id", session.workspace_id)
    .eq("factory_id", session.factory_id)
    .eq("session_id", session.id)
    .eq("artifact_id", session.current_artifact_id)
    .maybeSingle();
  if (error) throw error;
  if (!data || (data.status === "pending" && !canAnswer(session))) return state;

  return {
    ...state,
    clarification: {
      id: data.id,
      artifactId: data.artifact_id,
      artifactVersion: data.artifact_version,
      reviewRevision: session.artifact_review_revision,
      question: data.question,
      status: data.status,
      executionExhausted: data.execution_exhausted,
    },
  };
}

export async function answerSessionSpecification(input: {
  admin: Client;
  session: SpecificationSession;
  actorMemberId: string;
  answer: SpecificationAnswer;
}) {
  const { admin, session, actorMemberId, answer } = input;
  const { data: question, error: questionError } = await admin
    .from("session_specification_clarifications")
    .select("status")
    .eq("workspace_id", session.workspace_id)
    .eq("factory_id", session.factory_id)
    .eq("session_id", session.id)
    .eq("id", answer.clarificationId)
    .maybeSingle();
  if (questionError) throw questionError;

  // A completed receipt can replay after runtime configuration changes. The
  // mutation still validates the exact question and live actor in its lock.
  const needsRunConfig =
    question?.status === "pending" &&
    canAnswer(session) &&
    session.current_artifact_id === answer.artifactId &&
    session.current_artifact_version === answer.artifactVersion &&
    session.artifact_review_revision === answer.reviewRevision;
  const runConfig = needsRunConfig
    ? await resolveQueuedRunConfig(admin, { id: session.id, workspace_id: session.workspace_id })
    : null;

  const { data, error } = await admin
    .rpc("answer_session_specification_clarification_once", {
      p_workspace_id: session.workspace_id,
      p_factory_id: session.factory_id,
      p_session_id: session.id,
      p_actor_member_id: actorMemberId,
      p_clarification_id: answer.clarificationId,
      p_expected_artifact_id: answer.artifactId,
      p_expected_artifact_version: answer.artifactVersion,
      p_expected_review_revision: answer.reviewRevision,
      p_request_id: answer.requestId,
      p_answer_text: answer.answer,
      p_agent_model_provider: runConfig?.modelProvider,
      p_agent_model_name: runConfig?.modelName,
      p_run_type: runConfig?.runType,
    })
    .single();
  if (error || !data) throw error ?? new Error("No clarification answer receipt was returned.");

  const receipt = specificationAnswerReceiptSchema.parse({
    clarificationId: data.clarification_id,
    feedbackBatchId: data.feedback_batch_id,
    jobId: data.job_id,
    runId: data.run_id,
    executionExhausted: data.execution_exhausted,
    replayed: data.replayed,
  });
  if (receipt.jobId) await wakeWorker();
  return receipt;
}
