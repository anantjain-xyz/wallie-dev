import type { WorkspaceMember } from "@/features/workspace-members/types";
import type {
  AgentRunActionErrorResponse,
  AgentRunActionResponse,
  AgentRunCancelResponse,
} from "@/features/wallie/contracts";
import { mapAgentRunRow } from "@/features/wallie/data";
import type { Tables } from "@/lib/supabase/database.types";
import { WallieActionError } from "@/lib/wallie/service";

const emptyMemberIndex = new Map<string, WorkspaceMember>();

export function buildAgentRunActionResponse(input: {
  attemptCount?: number;
  created: boolean;
  processScheduled: boolean;
  run: Tables<"agent_runs">;
}) {
  return {
    code: input.created ? undefined : "active_run",
    created: input.created,
    processScheduled: input.processScheduled,
    run: mapAgentRunRow(input.run, emptyMemberIndex, [], {
      attemptCount: input.attemptCount,
    }),
  } satisfies AgentRunActionResponse;
}

export function buildAgentRunCancelResponse(input: {
  attemptCount?: number;
  canceled: boolean;
  run: Tables<"agent_runs">;
}) {
  return {
    canceled: input.canceled,
    run: mapAgentRunRow(input.run, emptyMemberIndex, [], {
      attemptCount: input.attemptCount,
    }),
  } satisfies AgentRunCancelResponse;
}

export function buildAgentRunActionErrorResponse(error: unknown) {
  if (!(error instanceof WallieActionError)) {
    throw error;
  }

  return {
    body: {
      code: error.code,
      error: error.message,
      missingSecretKeys: error.missingSecretKeys,
    } satisfies AgentRunActionErrorResponse,
    status: error.statusCode,
  };
}
