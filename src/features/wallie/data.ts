import type { IssueMember } from "@/features/issues/types";
import type { Tables } from "@/lib/supabase/database.types";
import {
  buildWallieBillingState,
  buildWallieBlockingReasons,
  canRetryWallieRun,
  inferWallieRunMode,
  isWallieRunActiveStatus,
  isWallieRunTerminalStatus,
  parseWallieRunMode,
} from "@/lib/wallie/core";
import { WALLIE_REQUIRED_SECRET_KEYS } from "@/lib/wallie/constants";
import type { WallieBillingSnapshot } from "@/lib/wallie/types";
import type {
  WallieIssueData,
  WallieIssueRepository,
  WallieRun,
  WallieRunMessage,
} from "@/features/wallie/types";

function sortRuns(left: Pick<WallieRun, "createdAt">, right: Pick<WallieRun, "createdAt">) {
  return right.createdAt.localeCompare(left.createdAt);
}

export function mapAgentRunMessageRow(
  row: Pick<
    Tables<"agent_run_messages">,
    "created_at" | "id" | "kind" | "message_md"
  >,
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
    | "status"
    | "triggered_by_member_id"
  >,
  memberIndex: ReadonlyMap<string, IssueMember>,
  messages: WallieRunMessage[],
): WallieRun {
  return {
    canRetry: false,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    id: row.id,
    isActive: false,
    isTerminal: false,
    messages: [...messages].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    ),
    modelName: row.model_name,
    modelProvider: row.model_provider,
    runType: parseWallieRunMode(row.run_type),
    startedAt: row.started_at,
    status: row.status,
    triggeredByMember: row.triggered_by_member_id
      ? memberIndex.get(row.triggered_by_member_id) ?? null
      : null,
    triggeredByMemberId: row.triggered_by_member_id,
  };
}

export function upsertWallieRun(
  runs: readonly WallieRun[],
  nextRun: WallieRun,
) {
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

    const nextMessages = run.messages.filter(
      (message) => message.id !== input.message.id,
    );

    nextMessages.push(input.message);

    return {
      ...run,
      messages: nextMessages.sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      ),
    };
  });

  return normalizeWallieRuns(nextRuns);
}

export function buildWallieIssueData(input: {
  billing: WallieBillingSnapshot;
  issueGithubRepositoryId: string | null;
  memberIndex: ReadonlyMap<string, IssueMember>;
  messages: readonly Pick<
    Tables<"agent_run_messages">,
    "agent_run_id" | "created_at" | "id" | "kind" | "message_md"
  >[];
  missingSecretKeys: string[];
  repository: WallieIssueRepository | null;
  runs: readonly Pick<
    Tables<"agent_runs">,
    | "created_at"
    | "finished_at"
    | "id"
    | "model_name"
    | "model_provider"
    | "run_type"
    | "started_at"
    | "status"
    | "triggered_by_member_id"
  >[];
}) {
  const messagesByRunId = new Map<string, WallieRunMessage[]>();

  for (const message of input.messages) {
    const currentMessages =
      messagesByRunId.get(message.agent_run_id) ?? [];

    currentMessages.push(mapAgentRunMessageRow(message));
    messagesByRunId.set(message.agent_run_id, currentMessages);
  }

  const billing = buildWallieBillingState(input.billing);
  const mode = inferWallieRunMode(input.issueGithubRepositoryId);
  const runs = normalizeWallieRuns(
    input.runs.map((run) =>
      mapAgentRunRow(
        run,
        input.memberIndex,
        messagesByRunId.get(run.id) ?? [],
      ),
    ),
  );
  const blockingReasons = buildWallieBlockingReasons({
    billing,
    hasActiveRun: runs.some((run) => run.isActive),
    missingSecretKeys: input.missingSecretKeys,
    mode,
    repository: input.repository,
  });

  return {
    billing,
    blockingReasons,
    canEnqueue: blockingReasons.length === 0,
    missingSecretKeys: input.missingSecretKeys,
    mode,
    repository: input.repository,
    requiredSecretKeys: [...WALLIE_REQUIRED_SECRET_KEYS],
    runs,
  } satisfies WallieIssueData;
}
