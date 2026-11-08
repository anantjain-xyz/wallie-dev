import type { WorkspaceMember } from "@/features/workspace-members/types";
import type { Tables } from "@/lib/supabase/database.types";
import { RECOMMENDED_AGENT_CONFIG_DEFAULTS } from "@/lib/agent-config/contracts";
import { parseRunFailure } from "@/lib/pipeline/run-failure";
import {
  sanitizeRunFailureDiagnostic,
  VERCEL_SANDBOX_FAILURE_DIAGNOSTIC_MAX_LENGTH,
} from "@/lib/pipeline/failure-diagnostic";
import {
  buildWallieBlockingReasons,
  canCancelWallieRun,
  canRetryWallieRun,
  inferWallieRunMode,
  isWallieRunActiveStatus,
  isWallieRunTerminalStatus,
  parseWallieRunMode,
} from "@/features/wallie/utils";
import type {
  WallieSessionData,
  WallieSessionRepository,
  WallieRun,
  WallieRunMessage,
  WallieVercelSandboxConnectionStatus,
} from "@/features/wallie/types";

function sortRuns(
  left: Pick<WallieRun, "createdAt" | "id">,
  right: Pick<WallieRun, "createdAt" | "id">,
) {
  const createdAtOrder = right.createdAt.localeCompare(left.createdAt);

  return createdAtOrder === 0 ? right.id.localeCompare(left.id) : createdAtOrder;
}

function isGenericRunnerCompletionMessage(message: Pick<WallieRunMessage, "kind" | "messageMd">) {
  return (
    message.kind === "completion" &&
    message.messageMd.trim().toLowerCase() === "codex session completed"
  );
}

function isDisplayableRunMessage(message: Pick<WallieRunMessage, "kind" | "messageMd">) {
  return message.kind !== "run_failure" && !isGenericRunnerCompletionMessage(message);
}

function recordedRunFailure(messages: readonly WallieRunMessage[]) {
  const terminal = messages.findLast((message) => message.kind === "run_failure");
  return terminal ? parseRunFailure(terminal.messageMd) : null;
}

export function mapAgentRunMessageRow(
  row: Pick<Tables<"agent_run_messages">, "created_at" | "id" | "kind" | "message_md">,
): WallieRunMessage {
  return {
    createdAt: row.created_at,
    id: row.id,
    kind: row.kind,
    messageMd:
      row.kind === "error"
        ? sanitizeRunFailureDiagnostic(row.message_md, VERCEL_SANDBOX_FAILURE_DIAGNOSTIC_MAX_LENGTH)
        : row.message_md,
  };
}

export function normalizeWallieRuns(runs: readonly WallieRun[]) {
  const sortedRuns = [...runs].sort(sortRuns);
  const hasActiveRun = sortedRuns.some((run) => isWallieRunActiveStatus(run.status));

  return sortedRuns.map((run) => {
    const canCancel = canCancelWallieRun(run.status);
    const canRetry = canRetryWallieRun(run.status, hasActiveRun);
    const isActive = isWallieRunActiveStatus(run.status);
    const isTerminal = isWallieRunTerminalStatus(run.status);

    if (
      run.canCancel === canCancel &&
      run.canRetry === canRetry &&
      run.isActive === isActive &&
      run.isTerminal === isTerminal
    ) {
      return run;
    }

    return { ...run, canCancel, canRetry, isActive, isTerminal };
  });
}

/**
 * Stable per-run attempt ordinal within a stage for live inserts that lack a
 * server-computed count (realtime INSERT, action responses before reconcile).
 * Group by immutable stageId so slug renames do not reset the sequence.
 */
export function nextAttemptOrdinal(
  runs: readonly Pick<WallieRun, "attemptCount" | "id" | "stageId">[],
  input: { id: string; stageId: string | null },
) {
  const existing = runs.find((run) => run.id === input.id);
  if (existing) {
    return existing.attemptCount;
  }

  let maxOrdinal = 0;
  for (const run of runs) {
    if ((run.stageId ?? null) !== (input.stageId ?? null)) {
      continue;
    }
    maxOrdinal = Math.max(maxOrdinal, run.attemptCount);
  }

  return maxOrdinal + 1;
}

export function mapAgentRunRow(
  row: Pick<
    Tables<"agent_runs">,
    | "branch_name"
    | "created_at"
    | "cost_provenance"
    | "finished_at"
    | "id"
    | "input_tokens"
    | "output_tokens"
    | "total_cost_usd"
    | "token_provenance"
    | "usage_finalized_at"
    | "last_activity_at"
    | "model_name"
    | "model_provider"
    | "run_type"
    | "sandbox_id"
    | "sandbox_provider"
    | "started_at"
    | "stage_id"
    | "stage_name"
    | "stage_slug"
    | "status"
    | "triggered_by_member_id"
    | "updated_at"
  >,
  memberIndex: ReadonlyMap<string, WorkspaceMember>,
  messages: WallieRunMessage[],
  options?: { attemptCount?: number; failure?: WallieRun["failure"] },
): WallieRun {
  return {
    attemptCount: options?.attemptCount && options.attemptCount > 0 ? options.attemptCount : 1,
    branchName: row.branch_name ?? null,
    canCancel: false,
    canRetry: false,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    failure: options?.failure ?? recordedRunFailure(messages),
    id: row.id,
    isActive: false,
    isTerminal: false,
    lastActivityAt: row.last_activity_at ?? null,
    messages: messages
      .filter(isDisplayableRunMessage)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    modelName: row.model_name,
    modelProvider: row.model_provider,
    requestedByMember: row.triggered_by_member_id
      ? (memberIndex.get(row.triggered_by_member_id) ?? null)
      : null,
    requestedByMemberId: row.triggered_by_member_id,
    runType: parseWallieRunMode(row.run_type),
    sandboxId: row.sandbox_id ?? null,
    sandboxProvider: row.sandbox_provider ?? null,
    startedAt: row.started_at,
    stageId: row.stage_id,
    stageName: row.stage_name,
    stageSlug: row.stage_slug,
    status: row.status,
    updatedAt: row.updated_at,
    usage: {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalCostUsd: row.total_cost_usd === null ? null : Number(row.total_cost_usd),
      tokenProvenance: row.token_provenance as WallieRun["usage"]["tokenProvenance"],
      costProvenance: row.cost_provenance as WallieRun["usage"]["costProvenance"],
      finalized: row.usage_finalized_at !== null,
    },
  };
}

export function upsertWallieRun(runs: readonly WallieRun[], nextRun: WallieRun) {
  const nextRuns = runs.filter((run) => run.id !== nextRun.id);

  nextRuns.push(nextRun);

  return normalizeWallieRuns(nextRuns);
}

export function mergeWallieRuns(runs: readonly WallieRun[], incomingRuns: readonly WallieRun[]) {
  let nextRuns = [...runs];

  for (const incomingRun of incomingRuns) {
    const previousRun = nextRuns.find((run) => run.id === incomingRun.id);

    if (previousRun && previousRun.updatedAt.localeCompare(incomingRun.updatedAt) > 0) {
      continue;
    }

    nextRuns = upsertWallieRun(nextRuns, {
      ...incomingRun,
      attemptCount: Math.max(incomingRun.attemptCount, previousRun?.attemptCount ?? 1),
      branchName: incomingRun.branchName ?? previousRun?.branchName ?? null,
      failure: incomingRun.failure ?? previousRun?.failure ?? null,
      messages: previousRun?.messages ?? incomingRun.messages,
      requestedByMember: incomingRun.requestedByMember ?? previousRun?.requestedByMember ?? null,
      sandboxId: incomingRun.sandboxId ?? previousRun?.sandboxId ?? null,
      sandboxProvider: incomingRun.sandboxProvider ?? previousRun?.sandboxProvider ?? null,
      lastActivityAt: incomingRun.lastActivityAt ?? previousRun?.lastActivityAt ?? null,
    });
  }

  return nextRuns;
}

export function upsertWallieRunMessage(
  runs: readonly WallieRun[],
  input: {
    agentRunId: string;
    message: WallieRunMessage;
  },
) {
  const nextRuns = runs.map((run) => {
    if (run.id !== input.agentRunId) {
      return run;
    }

    const nextMessages = run.messages.filter((message) => message.id !== input.message.id);

    if (isDisplayableRunMessage(input.message)) {
      nextMessages.push(input.message);
    }

    return {
      ...run,
      failure:
        input.message.kind === "run_failure"
          ? (parseRunFailure(input.message.messageMd) ?? run.failure)
          : run.failure,
      messages: nextMessages.sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    };
  });

  return normalizeWallieRuns(nextRuns);
}

export function buildWallieSessionData(input: {
  sessionGithubRepositoryId: string | null;
  loadedMessageRunIds?: readonly string[];
  memberIndex: ReadonlyMap<string, WorkspaceMember>;
  messages: readonly Pick<
    Tables<"agent_run_messages">,
    "agent_run_id" | "created_at" | "id" | "kind" | "message_md"
  >[];
  nextRunCursor?: WallieSessionData["nextRunCursor"];
  repository: WallieSessionRepository | null;
  requiresVercelSandbox: boolean;
  runs: readonly (Pick<
    Tables<"agent_runs">,
    | "branch_name"
    | "created_at"
    | "cost_provenance"
    | "finished_at"
    | "id"
    | "input_tokens"
    | "output_tokens"
    | "total_cost_usd"
    | "token_provenance"
    | "usage_finalized_at"
    | "last_activity_at"
    | "model_name"
    | "model_provider"
    | "run_type"
    | "sandbox_id"
    | "sandbox_provider"
    | "started_at"
    | "stage_id"
    | "stage_name"
    | "stage_slug"
    | "status"
    | "triggered_by_member_id"
    | "updated_at"
  > & { attemptCount?: number; failure?: WallieRun["failure"] })[];
  stallTimeoutMs?: number;
  vercelSandboxConnection: WallieVercelSandboxConnectionStatus;
  workspaceMembers?: readonly WorkspaceMember[];
}) {
  const messagesByRunId = new Map<string, WallieRunMessage[]>();
  const failuresByRunId = new Map<string, WallieRun["failure"]>();

  for (const message of input.messages) {
    const runMessage = mapAgentRunMessageRow(message);
    if (runMessage.kind === "run_failure") {
      const failure = parseRunFailure(runMessage.messageMd);
      if (failure) failuresByRunId.set(message.agent_run_id, failure);
    }
    if (!isDisplayableRunMessage(runMessage)) {
      continue;
    }

    const currentMessages = messagesByRunId.get(message.agent_run_id) ?? [];

    currentMessages.push(runMessage);
    messagesByRunId.set(message.agent_run_id, currentMessages);
  }

  const mode = inferWallieRunMode(input.sessionGithubRepositoryId);
  const runs = normalizeWallieRuns(
    input.runs.map((run) =>
      mapAgentRunRow(run, input.memberIndex, messagesByRunId.get(run.id) ?? [], {
        attemptCount: run.attemptCount,
        failure: run.failure ?? failuresByRunId.get(run.id),
      }),
    ),
  );
  const blockingReasons = buildWallieBlockingReasons({
    hasActiveRun: runs.some((run) => run.isActive),
    mode,
    repository: input.repository,
    requiresVercelSandbox: input.requiresVercelSandbox,
    vercelSandboxConnection: input.vercelSandboxConnection,
  });

  return {
    blockingReasons,
    canEnqueue: blockingReasons.length === 0,
    loadedMessageRunIds: [...(input.loadedMessageRunIds ?? messagesByRunId.keys())],
    mode,
    nextRunCursor: input.nextRunCursor ?? null,
    repository: input.repository,
    requiresVercelSandbox: input.requiresVercelSandbox,
    runs,
    stallTimeoutMs: input.stallTimeoutMs ?? RECOMMENDED_AGENT_CONFIG_DEFAULTS.stall_timeout_ms,
    vercelSandboxConnection: input.vercelSandboxConnection,
    workspaceMembers: [...(input.workspaceMembers ?? input.memberIndex.values())],
  } satisfies WallieSessionData;
}
