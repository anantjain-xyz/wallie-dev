import { STATUS_DEFINITIONS, agentRunStatusValue } from "@/components/ui/status";
import { timestampMs } from "@/components/shared/time-format";
import type { WallieRun, WallieRunMessage } from "@/features/wallie/types";
import { summarizeToolUse } from "@/features/wallie/run-message-body";

export type WallieRealtimeConnectionState = "connecting" | "live" | "disconnected" | "recovered";

export function isRunActivityStalled(input: {
  createdAt: string;
  isActive: boolean;
  lastActivityAt: string | null;
  nowMs: number;
  stallTimeoutMs: number;
  status: WallieRun["status"];
}): boolean {
  if (!input.isActive || input.stallTimeoutMs <= 0) {
    return false;
  }

  // Match the worker stall sweep: unclaimed queued runs wait on concurrency and
  // are not treated as stalled for "No recent activity" recovery.
  if (input.status === "queued") {
    return false;
  }

  const activityMs = timestampMs(input.lastActivityAt ?? input.createdAt);
  if (activityMs === null) {
    return false;
  }

  return input.nowMs - activityMs >= input.stallTimeoutMs;
}

export function formatMessageSourceLabel(kind: string) {
  const normalized = kind.trim().toLowerCase();

  switch (normalized) {
    case "progress":
      return "Progress";
    case "error":
      return "Error";
    case "completion":
      return "Completion";
    case "status":
      return "Status";
    case "log":
      return "Log";
    case "tool_use":
      return "Tool use";
    default: {
      if (!normalized) return "Message";
      return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
    }
  }
}

export function compactActivityText(text: string, limit = 180) {
  const preview = text
    .replace(/^\*\*Error:\*\*\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  return preview.length > limit ? `${preview.slice(0, limit - 1)}…` : preview;
}

export function runStatusLabel(input: { run: WallieRun; stalled: boolean }): string {
  const { run, stalled } = input;

  if (stalled) {
    return "No recent activity";
  }

  switch (run.status) {
    case "queued":
      return "Waiting in queue";
    case "canceled":
      return "Canceled";
    case "error":
      return "Failed";
    case "success":
      return "Completed";
    default:
      break;
  }

  if (run.status === "running" || run.status === "started") {
    return "Working";
  }

  return STATUS_DEFINITIONS[agentRunStatusValue(run.status)].label;
}

function previewMessage(message: WallieRunMessage) {
  if (message.kind === "tool_use") {
    const tool = message.messageMd
      .match(/^\*\*Tool:\*\* ([^\n]+)/)?.[1]
      ?.trim()
      .toLowerCase();
    switch (tool) {
      case "read":
      case "read-file":
        return "Reading files";
      case "grep":
      case "glob":
      case "search":
        return "Searching the repository";
      case "shell":
      case "bash":
        return "Running a command";
      case "edit":
      case "write":
      case "apply-patch":
        return "Updating files";
      default:
        return "Using a tool";
    }
  }
  const preview = message.messageMd.replace(/\s+/g, " ").trim();
  if (!preview) {
    return formatMessageSourceLabel(message.kind);
  }

  return preview.length > 96 ? `${preview.slice(0, 93)}…` : preview;
}

/** Keep the session execution summary's startup/progress copy independent of the compact run label. */
export function currentOperationLabel(input: { run: WallieRun; stalled: boolean }): string {
  const status = runStatusLabel(input);
  if (input.stalled || !["running", "started"].includes(input.run.status)) return status;
  const latest = input.run.messages.at(-1);
  return latest ? previewMessage(latest) : status;
}

export type ActivityMessageGroup = {
  id: string;
  messages: WallieRunMessage[];
  summary: string | null;
};

/** Group adjacent exploration only, preserving chronology and the first event's identity. */
export function groupActivityMessages(messages: WallieRunMessage[]): ActivityMessageGroup[] {
  const groups: ActivityMessageGroup[] = [];
  let pending: WallieRunMessage[] = [];
  let counts = { read: 0, search: 0, list: 0 };
  const flush = () => {
    if (!pending.length) return;
    groups.push({
      id: pending[0].id,
      messages: pending,
      summary: Object.entries(counts)
        .filter(([, count]) => count > 0)
        .map(
          ([name, count]) => `${count} ${name}${count === 1 ? "" : name === "search" ? "es" : "s"}`,
        )
        .join(", "),
    });
    pending = [];
    counts = { read: 0, search: 0, list: 0 };
  };
  for (const message of messages) {
    const category =
      message.kind === "tool_use" ? summarizeToolUse(message.messageMd).category : null;
    if (category) {
      pending.push(message);
      counts[category] += 1;
    } else {
      flush();
      groups.push({ id: message.id, messages: [message], summary: null });
    }
  }
  flush();
  return groups;
}

export function connectionStateCopy(state: WallieRealtimeConnectionState) {
  switch (state) {
    case "connecting":
      return "Connecting…";
    case "live":
      return "Live";
    case "disconnected":
      return "Disconnected — history preserved";
    case "recovered":
      return "Live updates restored";
  }
}

export function messagesLoadingCopy() {
  return "Loading run messages…";
}

export function messagesEmptyCopy() {
  return "No messages recorded for this run.";
}

export function messagesFailedCopy() {
  return "Could not load run messages. Collapse and expand this run to retry.";
}

export function messagesDisconnectedCopy() {
  return "Live updates paused. History is preserved.";
}

export function lastActivityTimestamp(run: WallieRun) {
  const latestMessageAt = run.messages.at(-1)?.createdAt ?? null;
  const candidates = [
    run.lastActivityAt,
    latestMessageAt,
    run.updatedAt,
    run.startedAt,
    run.createdAt,
  ]
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.localeCompare(left));

  return candidates[0] ?? run.createdAt;
}
