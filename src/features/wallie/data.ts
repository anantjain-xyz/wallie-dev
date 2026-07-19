import type { WorkspaceMember } from "@/features/workspace-members/types";
import type { Tables } from "@/lib/supabase/database.types";
import { RECOMMENDED_AGENT_CONFIG_DEFAULTS } from "@/lib/agent-config/contracts";
import {
  buildWallieBlockingReasons,
  canCancelWallieRun,
  canRetryWallieRun,
  inferWallieRunMode,
  isWallieRunActiveStatus,
  isWallieRunTerminalStatus,
  parseWallieRunMode,
} from "@/features/wallie/utils";
import { WALLIE_REQUIRED_SECRET_KEYS } from "@/lib/wallie/constants";
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
  return !isGenericRunnerCompletionMessage(message);
}

export function mapAgentRunMessageRow(
  row: Pick<Tables<"agent_run_messages">, "created_at" | "id" | "kind" | "message_md">,
): WallieRunMessage {
  return {
    createdAt: row.created_at,
    id: row.id,
    kind: row.kind,
    messageMd: row.message_md,
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

export function mapAgentRunRow(
  row: Pick<
    Tables<"agent_runs">,
    | "created_at"
    | "finished_at"
    | "id"
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
  options?: { attemptCount?: number },
): WallieRun {
  return {
    attemptCount: options?.attemptCount && options.attemptCount > 0 ? options.attemptCount : 1,
    canCancel: false,
    canRetry: false,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    id: row.id,
    isActive: false,
    isTerminal: false,
    lastActivityAt: row.last_activity_at ?? null,
    messages: [...messages].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
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
  missingSecretKeys: string[];
  nextRunCursor?: WallieSessionData["nextRunCursor"];
  repository: WallieSessionRepository | null;
  requiresVercelSandbox: boolean;
  runs: readonly (Pick<
    Tables<"agent_runs">,
    | "created_at"
    | "finished_at"
    | "id"
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
  > & { attemptCount?: number })[];
  stallTimeoutMs?: number;
  vercelSandboxConnection: WallieVercelSandboxConnectionStatus;
  workspaceMembers?: readonly WorkspaceMember[];
}) {
  const messagesByRunId = new Map<string, WallieRunMessage[]>();

  for (const message of input.messages) {
    const runMessage = mapAgentRunMessageRow(message);
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
      }),
    ),
  );
  const blockingReasons = buildWallieBlockingReasons({
    hasActiveRun: runs.some((run) => run.isActive),
    missingSecretKeys: input.missingSecretKeys,
    mode,
    repository: input.repository,
    requiresVercelSandbox: input.requiresVercelSandbox,
    vercelSandboxConnection: input.vercelSandboxConnection,
  });

  return {
    blockingReasons,
    canEnqueue: blockingReasons.length === 0,
    loadedMessageRunIds: [...(input.loadedMessageRunIds ?? messagesByRunId.keys())],
    missingSecretKeys: input.missingSecretKeys,
    mode,
    nextRunCursor: input.nextRunCursor ?? null,
    repository: input.repository,
    requiresVercelSandbox: input.requiresVercelSandbox,
    requiredSecretKeys: [...WALLIE_REQUIRED_SECRET_KEYS],
    runs,
    stallTimeoutMs: input.stallTimeoutMs ?? RECOMMENDED_AGENT_CONFIG_DEFAULTS.stall_timeout_ms,
    vercelSandboxConnection: input.vercelSandboxConnection,
    workspaceMembers: [...(input.workspaceMembers ?? input.memberIndex.values())],
  } satisfies WallieSessionData;
}
