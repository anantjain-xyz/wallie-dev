import type { AgentRunUsage } from "./types";

/** Token telemetry is measured only when both counts are safe, nonnegative integers. */
export function normalizeMeasuredUsage(
  inputTokens: unknown,
  outputTokens: unknown,
  costUsd?: unknown,
): AgentRunUsage | undefined {
  if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens)) return undefined;

  return {
    inputTokens,
    outputTokens,
    provenance: "measured",
    ...(isCostUsd(costUsd) ? { costUsd, costProvenance: "measured" as const } : {}),
  };
}

export function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isCostUsd(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}
