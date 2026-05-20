import type { WorkspaceMember } from "@/features/workspace-members/types";
import type { Tables } from "@/lib/supabase/database.types";
import {
  buildWallieBlockingReasons,
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
} from "@/features/wallie/types";

function sortRuns(left: Pick<WallieRun, "createdAt">, right: Pick<WallieRun, "createdAt">) {
  return right.createdAt.localeCompare(left.createdAt);
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

  return sortedRuns.map((run) => ({
    ...run,
    canRetry: canRetryWallieRun(run.status, hasActiveRun),
    isActive: isWallieRunActiveStatus(run.status),
    isTerminal: isWallieRunTerminalStatus(run.status),
  }));
}

export function mapAgentRunRow(
  row: Pick<
    Tables<"agent_runs">,
    | "created_at"
    | "finished_at"
    | "id"
    | "model_name"
    | "model_provider"
    | "run_type"
    | "started_at"
    | "stage_id"
    | "stage_name"
    | "stage_slug"
    | "status"
    | "triggered_by_member_id"
  >,
  memberIndex: ReadonlyMap<string, WorkspaceMember>,
  messages: WallieRunMessage[],
): WallieRun {
  return {
    canRetry: false,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    id: row.id,
    isActive: false,
    isTerminal: false,
    messages: [...messages].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    modelName: row.model_name,
    modelProvider: row.model_provider,
    requestedByMember: row.triggered_by_member_id
      ? (memberIndex.get(row.triggered_by_member_id) ?? null)
      : null,
    requestedByMemberId: row.triggered_by_member_id,
    runType: parseWallieRunMode(row.run_type),
    startedAt: row.started_at,
    stageId: row.stage_id,
    stageName: row.stage_name,
    stageSlug: row.stage_slug,
    status: row.status,
  };
}

export function upsertWallieRun(runs: readonly WallieRun[], nextRun: WallieRun) {
  const nextRuns = runs.filter((run) => run.id !== nextRun.id);

  nextRuns.push(nextRun);

  return normalizeWallieRuns(nextRuns);
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
  memberIndex: ReadonlyMap<string, WorkspaceMember>;
  messages: readonly Pick<
    Tables<"agent_run_messages">,
    "agent_run_id" | "created_at" | "id" | "kind" | "message_md"
  >[];
  missingSecretKeys: string[];
  repository: WallieSessionRepository | null;
  runs: readonly Pick<
    Tables<"agent_runs">,
    | "created_at"
    | "finished_at"
    | "id"
    | "model_name"
    | "model_provider"
    | "run_type"
    | "started_at"
    | "stage_id"
    | "stage_name"
    | "stage_slug"
    | "status"
    | "triggered_by_member_id"
  >[];
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
      mapAgentRunRow(run, input.memberIndex, messagesByRunId.get(run.id) ?? []),
    ),
  );
  const blockingReasons = buildWallieBlockingReasons({
    hasActiveRun: runs.some((run) => run.isActive),
    missingSecretKeys: input.missingSecretKeys,
    mode,
    repository: input.repository,
  });

  return {
    blockingReasons,
    canEnqueue: blockingReasons.length === 0,
    missingSecretKeys: input.missingSecretKeys,
    mode,
    repository: input.repository,
    requiredSecretKeys: [...WALLIE_REQUIRED_SECRET_KEYS],
    runs,
  } satisfies WallieSessionData;
}
