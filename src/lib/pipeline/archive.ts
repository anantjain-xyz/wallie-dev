import type { SupabaseClient } from "@supabase/supabase-js";

import { cancelSessionWork } from "@/lib/pipeline/cancel";
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
 * Archive a session from any stage. Unlike the reconciler's Linear-route
 * archive, this is the user-facing primitive: it has no `phase_status` gate, so
 * a workspace member can archive a session regardless of where it sits in the
 * pipeline.
 *
 * It first reuses {@link cancelSessionWork} to stop any in-flight work — flip
 * active jobs/runs to `canceled`, stop their sandboxes, record a cancel message,
 * and park an `agent_generating` session into `rejected`. `awaiting_review`,
 * `approved`, and already-`rejected` sessions keep their phase, so a later
 * {@link unarchiveSession} restores them where they were.
 *
 * Idempotent: the `archived_at is null` guard means re-archiving an already
 * archived session is a no-op and echoes back the existing state.
 */
export async function archiveSession(
  admin: AdminClient,
  input: { reason: string; sessionId: string },
): Promise<SessionArchiveState> {
  // Set the archived marker before canceling work so later enqueue validations
  // and processor claims reject the session. This is not atomic with enqueue: a
  // request that already passed validation can still insert after this
  // cancellation pass. The work cannot execute while archived, and re-running
  // archive runs cancellation again to converge on any rows this pass missed.
  const { error } = await admin
    .from("sessions")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", input.sessionId)
    .is("archived_at", null)
    .select("id")
    .maybeSingle();

  if (error) {
    throw error;
  }

  // Always run cancellation, even when the session was already archived (no row
  // matched). cancelSessionWork is idempotent — it only touches still-active
  // jobs/runs — so re-running it lets a retry finish cleanup when a prior
  // archive's cancellation failed after the marker was already committed.
  // Otherwise the `!data` path would short-circuit and a worker could keep
  // writing to a session the UI shows as archived.
  await cancelSessionWork(admin, {
    parkPhaseStatus: true,
    reason: input.reason,
    sessionId: input.sessionId,
  });

  // Cancellation can change phase_status after archived_at is written. Always
  // reload after it settles so callers receive one authoritative final row,
  // including updated_at for timestamp-aware client reconciliation.
  return readSessionArchiveState(admin, input.sessionId);
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
  input: { expectedArchivedAt?: string; sessionId: string },
): Promise<SessionArchiveState> {
  let update = admin.from("sessions").update({ archived_at: null }).eq("id", input.sessionId);
  update = input.expectedArchivedAt
    ? update.eq("archived_at", input.expectedArchivedAt)
    : update.not("archived_at", "is", null);
  const { error } = await update.select("id").maybeSingle();

  if (error) {
    throw error;
  }

  return readSessionArchiveState(admin, input.sessionId);
}

async function readSessionArchiveState(
  admin: AdminClient,
  sessionId: string,
): Promise<SessionArchiveState> {
  const { data, error } = await admin
    .from("sessions")
    .select("id, archived_at, phase_status, updated_at")
    .eq("id", sessionId)
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
