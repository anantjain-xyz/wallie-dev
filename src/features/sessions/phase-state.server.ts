import "server-only";

import type { QueryData, SupabaseClient } from "@supabase/supabase-js";

import { loadPinnedFactoryExecution } from "@/lib/factory-definitions/runtime-definition";
import type { Database } from "@/lib/supabase/database.types";

import type { SessionPhaseMutationResult } from "./mutation-contracts";

type SessionClient = Pick<SupabaseClient<Database>, "from">;

export function querySessionPhaseState(client: SessionClient, sessionId: string) {
  return client
    .from("sessions")
    .select(
      "id, workspace_id, archived_at, phase_status, current_stage_id, current_artifact_id, current_artifact_version, rejection_count, updated_at, execute_pinned_definition, factory_definition_revision_id, currentStage:pipeline_stages!sessions_current_stage_id_fkey(id, description, name, position, slug)",
    )
    .eq("id", sessionId);
}

type SessionPhaseRow = QueryData<ReturnType<typeof querySessionPhaseState>>[number];

export async function resolveSessionPhaseState(
  client: SessionClient,
  row: SessionPhaseRow,
): Promise<SessionPhaseMutationResult | null> {
  let currentStage = row.currentStage;
  try {
    const pinned = await loadPinnedFactoryExecution(client, row);
    if (pinned) {
      const index = pinned.stages.findIndex(({ id }) => id === row.current_stage_id);
      const stage = pinned.stages[index];
      if (!stage) return null;
      const { id, description, name, slug } = stage;
      currentStage = { id, description, name, slug, position: index + 1 };
    }
  } catch {
    return null;
  }
  if (!currentStage) return null;

  return {
    archivedAt: row.archived_at,
    currentArtifactId: row.current_artifact_id ?? null,
    artifactVersion: row.current_artifact_version,
    currentStage,
    currentStageId: row.current_stage_id,
    id: row.id,
    phaseStatus: row.phase_status,
    rejectionCount: row.rejection_count,
    updatedAt: row.updated_at,
  };
}
