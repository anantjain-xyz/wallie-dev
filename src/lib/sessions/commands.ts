import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  querySessionPhaseState,
  resolveSessionPhaseState,
} from "@/features/sessions/phase-state.server";
import type { SessionPhaseMutationResult } from "@/features/sessions/mutation-contracts";
import { cancelSessionWork, cleanupSessionWorkReceipt } from "@/lib/pipeline/cancel";
import type { Database } from "@/lib/supabase/database.types";

type SessionClient = SupabaseClient<Database>;

export async function readSessionCommand(
  reader: Pick<SessionClient, "from">,
  sessionId: string,
  scope?: { workspaceId: string; factoryId: string },
): Promise<
  | { ok: true; result: SessionPhaseMutationResult }
  | { ok: false; code: "mutation_failed" | "not_found"; error: string }
> {
  let lookup = querySessionPhaseState(reader, sessionId);
  if (scope) {
    lookup = lookup.eq("workspace_id", scope.workspaceId).eq("factory_id", scope.factoryId);
  }

  const { data, error } = await lookup.maybeSingle();
  if (error) return { ok: false, code: "mutation_failed", error: error.message };
  if (!data) return { ok: false, code: "not_found", error: "Session not found" };

  const result = await resolveSessionPhaseState(reader, data);
  return result
    ? { ok: true, result }
    : { ok: false, code: "mutation_failed", error: "Session stage not found" };
}

type CancellationIdentity = {
  actorMemberId: string;
  factoryId: string;
  requestId: string;
  expectedRunId: string;
};

type CancelSessionInput = {
  admin: SessionClient;
  sessionId: string;
  workspaceId: string;
} & ({ command: CancellationIdentity; reason?: never } | { command?: never; reason: string });

export async function cancelSessionCommand(input: CancelSessionInput) {
  const { admin, command, sessionId, workspaceId } = input;
  if (!command) {
    const result = await cancelSessionWork(admin, { reason: input.reason, sessionId, workspaceId });
    return { ...result, replayed: false };
  }

  const digest = createHash("sha256")
    .update(JSON.stringify([sessionId, command.expectedRunId]))
    .digest("hex");
  const { data, error } = await admin
    .rpc("cancel_session_command_once", {
      actor_member_id: command.actorMemberId,
      expected_run_id: command.expectedRunId,
      target_factory_id: command.factoryId,
      target_request_hash: digest,
      target_request_id: command.requestId,
      target_session_id: sessionId,
      target_workspace_id: workspaceId,
    })
    .single();
  if (error || !data) throw error ?? new Error("Wallie could not cancel that session.");

  const result = await cleanupSessionWorkReceipt(admin, { receipt: data, workspaceId });
  return { ...result, replayed: data.replayed };
}
