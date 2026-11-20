import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";

import { factoryErrorStatus } from "@/lib/factories/scope";
import type { Database, Tables } from "@/lib/supabase/database.types";

import {
  type configureFactoryEvaluationLaneSchema,
  factoryEvaluationLaneSchema,
  terminalFactoryEvaluationSchema,
} from "./evaluation-control-contracts";

type Client = Pick<SupabaseClient<Database>, "rpc">;
type ActorScope = { workspaceId: string; actorUserId: string };

function mapLane(workspaceId: string, lane: Tables<"factory_evaluation_lanes"> | null) {
  if (!lane || lane.workspace_id !== workspaceId.toLowerCase()) {
    throw new Error("Evaluation lane returned an invalid workspace.");
  }
  return factoryEvaluationLaneSchema.parse({
    paused: lane.paused,
    maxConcurrent: lane.max_concurrent,
    revision: lane.revision,
    updatedAt: lane.updated_at,
  });
}

export async function getFactoryEvaluationLane(client: Client, input: ActorScope) {
  const { data, error } = await client
    .rpc("get_factory_evaluation_lane", {
      p_workspace_id: input.workspaceId,
      p_actor_user_id: input.actorUserId,
    })
    .single();
  if (error) throw error;
  return mapLane(input.workspaceId, data);
}

export async function configureFactoryEvaluationLane(
  client: Client,
  input: ActorScope & z.output<typeof configureFactoryEvaluationLaneSchema>,
) {
  const { data, error } = await client
    .rpc("configure_factory_evaluation_lane", {
      p_workspace_id: input.workspaceId,
      p_actor_user_id: input.actorUserId,
      p_expected_revision: input.expectedRevision,
      p_paused: input.paused,
      p_max_concurrent: input.maxConcurrent,
    })
    .single();
  if (error) throw error;
  return mapLane(input.workspaceId, data);
}

export async function cancelFactoryEvaluationJob(
  client: Client,
  input: ActorScope & { factoryId: string; evaluationId: string },
) {
  const { data, error } = await client
    .rpc("cancel_factory_evaluation_job", {
      p_workspace_id: input.workspaceId,
      p_factory_id: input.factoryId,
      p_actor_user_id: input.actorUserId,
      p_job_id: input.evaluationId,
    })
    .select("id,workspace_id,factory_id,status,finished_at")
    .single<
      Pick<
        Tables<"factory_evaluation_jobs">,
        "id" | "workspace_id" | "factory_id" | "status" | "finished_at"
      >
    >();
  if (error) throw error;
  if (
    !data ||
    data.workspace_id !== input.workspaceId.toLowerCase() ||
    data.factory_id !== input.factoryId.toLowerCase() ||
    data.id !== input.evaluationId.toLowerCase()
  ) {
    throw new Error("Evaluation cancellation returned an invalid target.");
  }
  return terminalFactoryEvaluationSchema.parse({
    id: data.id,
    status: data.status,
    finishedAt: data.finished_at,
  });
}

export function evaluationControlErrorStatus(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return factoryErrorStatus(typeof code === "string" ? code : undefined);
}
