import { z } from "zod";

const failureCodes = {
  credentials: {
    category: "configuration",
    categoryLabel: "Configuration",
    cause: "The agent credentials are missing, expired, or no longer authorized.",
    recovery: "Reconnect the session owner's agent account in their profile before trying again.",
  },
  sandbox_configuration: {
    category: "configuration",
    categoryLabel: "Configuration",
    cause: "The sandbox connection is missing, invalid, or needs a fresh capability check.",
    recovery:
      "Check the sandbox connection and capability check in workspace Settings before trying again.",
  },
  repository_configuration: {
    category: "configuration",
    categoryLabel: "Configuration",
    cause: "The repository connection is unavailable or is not configured for this session.",
    recovery:
      "Check the repository and GitHub connection in workspace Settings before trying again.",
  },
  agent_configuration: {
    category: "configuration",
    categoryLabel: "Configuration",
    cause: "The workspace agent configuration could not be used.",
    recovery:
      "Review the agent provider, model, and limits in workspace Settings before trying again.",
  },
  agent_exit: {
    category: "agent_exit",
    categoryLabel: "Agent exit",
    cause: "The agent process exited unsuccessfully before completing the run.",
    recovery:
      "Inspect the agent activity for the exit details. Retry only after addressing any reported problem.",
  },
  agent_incomplete: {
    category: "agent_exit",
    categoryLabel: "Agent exit",
    cause: "The agent stopped without producing a completed, reviewable result.",
    recovery: "Inspect the agent activity and stage instructions before trying again.",
  },
  timeout: {
    category: "timeout",
    categoryLabel: "Timeout",
    cause: "The run exceeded its time limit or stopped reporting activity.",
    recovery:
      "Check the activity and timeout settings. Retry only when the work can finish within the configured limit.",
  },
  budget: {
    category: "budget",
    categoryLabel: "Execution limit",
    cause: "The session's execution budget was exhausted, so no further repair could be queued.",
    recovery:
      "Review the session's elapsed time, token, cost, and repair limits before starting more work.",
  },
  publication: {
    category: "publication",
    categoryLabel: "Publication",
    cause: "Wallie could not preserve or publish the run's output for review.",
    recovery:
      "Inspect the run details and repository connection. Check retained source recovery before starting another run.",
  },
  unknown: {
    category: "unknown",
    categoryLabel: "Run error",
    cause: "Wallie recorded an execution error but could not classify its cause.",
    recovery: "Inspect the available activity and run details before deciding whether to retry.",
  },
} as const;

const persistedFailureSchema = z.object({
  version: z.literal(1),
  category: z.enum(["configuration", "agent_exit", "timeout", "budget", "publication", "unknown"]),
  code: z.enum([
    "credentials",
    "sandbox_configuration",
    "repository_configuration",
    "agent_configuration",
    "agent_exit",
    "agent_incomplete",
    "timeout",
    "budget",
    "publication",
    "unknown",
  ]),
});

export type RunFailure = (typeof failureCodes)[keyof typeof failureCodes] & {
  code: keyof typeof failureCodes;
};

/** Only allowlisted terminal metadata becomes UI copy; arbitrary payloads never do. */
export function parseRunFailure(messageMd: string): RunFailure | null {
  let value: unknown;
  try {
    value = JSON.parse(messageMd);
  } catch {
    return null;
  }
  const parsed = persistedFailureSchema.safeParse(value);
  if (!parsed.success) return null;
  const failure = failureCodes[parsed.data.code];
  if (failure.category !== parsed.data.category) return null;
  return { ...failure, code: parsed.data.code };
}
