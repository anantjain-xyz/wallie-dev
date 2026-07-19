import { STATUS_DEFINITIONS, agentRunStatusValue } from "@/components/ui/status";
import { timestampMs } from "@/components/shared/time-format";
import type { WallieRun, WallieRunMessage } from "@/features/wallie/types";

export type WallieRealtimeConnectionState = "connecting" | "live" | "disconnected" | "recovered";

export function isRunActivityStalled(input: {
  createdAt: string;
  isActive: boolean;
  lastActivityAt: string | null;
  nowMs: number;
  stallTimeoutMs: number;
}): boolean {
  if (!input.isActive || input.stallTimeoutMs <= 0) {
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
    default: {
      if (!normalized) return "Message";
      return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
    }
  }
}

function previewMessage(message: WallieRunMessage) {
  const preview = message.messageMd.replace(/\s+/g, " ").trim();
  if (!preview) {
    return formatMessageSourceLabel(message.kind);
  }

  return preview.length > 96 ? `${preview.slice(0, 93)}…` : preview;
}

export function currentOperationLabel(input: { run: WallieRun; stalled: boolean }): string {
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

  const latestMessage = run.messages.at(-1);
  if (latestMessage) {
    return previewMessage(latestMessage);
  }

  if (run.status === "running" || run.status === "started") {
    return "Wallie is working…";
  }

  return STATUS_DEFINITIONS[agentRunStatusValue(run.status)].label;
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
