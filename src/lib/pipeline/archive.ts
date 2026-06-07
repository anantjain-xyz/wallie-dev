import type { SupabaseClient } from "@supabase/supabase-js";

import { cancelSessionWork } from "@/lib/pipeline/cancel";
import type { Database } from "@/lib/supabase/database.types";

type AdminClient = SupabaseClient<Database>;

export type SessionArchiveState = {
  archivedAt: string | null;
  id: string;
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
  // Set the archived marker FIRST, before canceling any work. Order matters:
  // the run-enqueue/retry path rejects archived sessions, so landing the marker
  // up front blocks new work before cleanup begins. If we canceled first, a
  // concurrent request that passed the archived check could insert a fresh
  // job/run in the window before the marker lands — work this call would never
  // cancel. The processor's claim CAS is also archive-aware, so anything that
  // still slips in before the marker cannot execute.
  const { data, error } = await admin
    .from("sessions")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", input.sessionId)
    .is("archived_at", null)
    .select("id, archived_at")
    .maybeSingle();

  if (error) {
    throw error;
  }

  // No row matched ⇒ the session was already archived; a prior archive owns the
  // cancellation. Read the current state so the caller still gets the id +
  // archived_at to echo back.
  if (!data) {
    return readSessionArchiveState(admin, input.sessionId);
  }

  // Marker is set; now stop in-flight work.
  await cancelSessionWork(admin, {
    parkPhaseStatus: true,
    reason: input.reason,
    sessionId: input.sessionId,
  });

  return { archivedAt: data.archived_at, id: data.id };
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
  input: { sessionId: string },
): Promise<SessionArchiveState> {
  const { data, error } = await admin
    .from("sessions")
    .update({ archived_at: null })
    .eq("id", input.sessionId)
    .not("archived_at", "is", null)
    .select("id, archived_at")
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return readSessionArchiveState(admin, input.sessionId);
  }

  return { archivedAt: data.archived_at, id: data.id };
}

async function readSessionArchiveState(
  admin: AdminClient,
  sessionId: string,
): Promise<SessionArchiveState> {
  const { data, error } = await admin
    .from("sessions")
    .select("id, archived_at")
    .eq("id", sessionId)
    .single();

  if (error) {
    throw error;
  }

  return { archivedAt: data.archived_at, id: data.id };
}
