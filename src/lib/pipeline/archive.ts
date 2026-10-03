import type { SupabaseClient } from "@supabase/supabase-js";

import { cleanupSessionWorkReceipt } from "@/lib/pipeline/cancel";
import type { PipelinePhaseStatus } from "@/lib/pipeline/types";
import type { Database } from "@/lib/supabase/database.types";

type AdminClient = SupabaseClient<Database>;

export type SessionArchiveState = {
  archivedAt: string | null;
  id: string;
  phaseStatus: PipelinePhaseStatus;
  updatedAt: string;
};

/**
 * Archive and cancel under one session lock, preserving an existing review or
 * approved phase unless the caller explicitly completes the session. Provider
 * cleanup uses only the transaction's receipt; it never changes session state.
 */
export async function archiveSession(
  admin: AdminClient,
  input: { completed?: boolean; reason: string; sessionId: string; workspaceId: string },
): Promise<SessionArchiveState> {
  const { data, error } = await admin.rpc("archive_session_job_attempts", {
    p_completed: input.completed ?? false,
    p_reason: input.reason,
    p_session_id: input.sessionId,
    p_workspace_id: input.workspaceId,
  });
  if (error) throw error;

  await cleanupSessionWorkReceipt(admin, {
    receipt: data?.[0] ?? { job_ids: [], run_ids: [] },
    reason: input.reason,
    workspaceId: input.workspaceId,
  });

  return readSessionArchiveState(admin, input.sessionId, input.workspaceId);
}

/**
 * Clear a session's `archived_at`, returning it to its prior phase. No work is
 * re-enqueued — the user re-runs the stage manually if they want to continue.
 *
 * Idempotent: the `archived_at is not null` guard means unarchiving an active
 * session is a no-op and echoes back the existing state.
 */
export async function unarchiveSession(
  admin: AdminClient,
  input: { expectedArchivedAt?: string; sessionId: string; workspaceId: string },
): Promise<SessionArchiveState> {
  let update = admin
    .from("sessions")
    .update({ archived_at: null })
    .eq("id", input.sessionId)
    .eq("workspace_id", input.workspaceId);
  update = input.expectedArchivedAt
    ? update.eq("archived_at", input.expectedArchivedAt)
    : update.not("archived_at", "is", null);
  const { error } = await update.select("id").maybeSingle();

  if (error) {
    throw error;
  }

  return readSessionArchiveState(admin, input.sessionId, input.workspaceId);
}

async function readSessionArchiveState(
  admin: AdminClient,
  sessionId: string,
  workspaceId: string,
): Promise<SessionArchiveState> {
  const { data, error } = await admin
    .from("sessions")
    .select("id, archived_at, phase_status, updated_at")
    .eq("id", sessionId)
    .eq("workspace_id", workspaceId)
    .single();

  if (error) {
    throw error;
  }

  return {
    archivedAt: data.archived_at,
    id: data.id,
    phaseStatus: data.phase_status,
    updatedAt: data.updated_at,
  };
}
