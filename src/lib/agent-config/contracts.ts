import { z } from "zod";

import type { AgentProvider } from "@/lib/sandbox/types";

export const ALLOWED_AGENT_CONFIG_KEYS = [
  "concurrency_limit",
  "stall_timeout_ms",
  "max_retries",
  "agent_provider",
  "agent_model",
] as const;

export type AgentConfigKey = (typeof ALLOWED_AGENT_CONFIG_KEYS)[number];

export const AGENT_PROVIDERS = ["codex", "claude-code"] as const satisfies readonly AgentProvider[];

export type { AgentProvider };

export const RECOMMENDED_AGENT_MODELS = {
  codex: "gpt-5.5",
  "claude-code": "claude-opus-4-7[1m]",
} as const satisfies Record<AgentProvider, string>;

export const RECOMMENDED_CODEX_REASONING_EFFORT = "xhigh";
export const RECOMMENDED_CLAUDE_CODE_EFFORT = "xhigh";

const AGENT_PROVIDER_ALIASES: Record<string, AgentProvider> = {
  claude_code: "claude-code",
  "claude-code": "claude-code",
  codex: "codex",
};

export function normalizeAgentProviderName(provider: string | undefined): AgentProvider | null {
  if (!provider) return null;
  return AGENT_PROVIDER_ALIASES[provider] ?? null;
}

export const AGENT_CONFIG_LIMITS = {
  concurrency_limit: { min: 1, max: 20 },
  stall_timeout_ms: { min: 30_000, max: 1_800_000 },
  max_retries: { min: 0, max: 10 },
} as const;

export const RECOMMENDED_AGENT_CONFIG_DEFAULTS = {
  agent_provider: "codex",
  agent_model: RECOMMENDED_AGENT_MODELS.codex,
  concurrency_limit: 1,
  max_retries: 3,
  stall_timeout_ms: 900_000,
} as const satisfies Record<AgentConfigKey, string | number>;

export function getRecommendedAgentModel(provider: AgentProvider): string {
  return RECOMMENDED_AGENT_MODELS[provider];
}

export function getRecommendedAgentConfigDefault(
  key: AgentConfigKey,
  provider: AgentProvider = RECOMMENDED_AGENT_CONFIG_DEFAULTS.agent_provider,
): string | number {
  return key === "agent_model"
    ? getRecommendedAgentModel(provider)
    : RECOMMENDED_AGENT_CONFIG_DEFAULTS[key];
}

/**
 * Model identifiers must match the prefix of a supported provider family.
 * This prevents typos (e.g. "lol") while keeping the field flexible enough
 * that a new model release like `claude-sonnet-4-7` works without a code
 * change. Runtime readiness still pairs the configured model family with the
 * selected provider before sessions can run.
 *
 * Lowercase-only: provider model IDs are always lowercase in practice, and
 * the matching DB CHECK uses case-sensitive `LIKE`. Rejecting uppercase here
 * keeps UI / API / DB validation aligned so a value can't pass the UI gate
 * and then fail the DB constraint with a 500.
 */
const CLAUDE_MODEL_PREFIX = "claude-";
const CODEX_MODEL_PREFIXES = ["gpt-", "o1", "o3", "o4"] as const;
const CLAUDE_EXTENDED_CONTEXT_SUFFIX = "[1m]";
const AGENT_MODEL_BODY_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/;

const intInRange = (label: string, min: number, max: number) =>
  z
    .number({
      invalid_type_error: `${label} must be a number.`,
      required_error: `${label} is required.`,
    })
    .int(`${label} must be a whole number.`)
    .min(min, `${label} must be at least ${min}.`)
    .max(max, `${label} must be at most ${max}.`);

const concurrencyLimitSchema = intInRange(
  "Concurrency limit",
  AGENT_CONFIG_LIMITS.concurrency_limit.min,
  AGENT_CONFIG_LIMITS.concurrency_limit.max,
);

const stallTimeoutSchema = intInRange(
  "Stall timeout (ms)",
  AGENT_CONFIG_LIMITS.stall_timeout_ms.min,
  AGENT_CONFIG_LIMITS.stall_timeout_ms.max,
);

const maxRetriesSchema = intInRange(
  "Max retries",
  AGENT_CONFIG_LIMITS.max_retries.min,
  AGENT_CONFIG_LIMITS.max_retries.max,
);

const agentProviderSchema = z
  .string({ invalid_type_error: "Provider must be a string." })
  .trim()
  .transform((provider, ctx) => {
    const normalized = normalizeAgentProviderName(provider);
    if (normalized) return normalized;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Provider must be one of: ${AGENT_PROVIDERS.join(", ")}.`,
    });
    return z.NEVER;
  });

const agentModelSchema = z
  .string({ invalid_type_error: "Model must be a string." })
  .trim()
  .min(1, "Model is required.")
  .max(100, "Model must be 100 characters or fewer.")
  .refine(
    (model) => modelHasSupportedSyntax(model),
    "Model may only contain lowercase letters, numbers, dots, dashes, underscores, and an optional Claude [1m] suffix.",
  )
  .refine(
    (model) => modelMatchesAnyProvider(model),
    `Model must start with "${CLAUDE_MODEL_PREFIX}" or one of: ${CODEX_MODEL_PREFIXES.join(", ")}.`,
  );

function modelMatchesAnyProvider(model: string): boolean {
  const trimmed = model.trim();
  if (!modelHasSupportedSyntax(trimmed)) return false;
  if (trimmed.startsWith(CLAUDE_MODEL_PREFIX)) return true;
  if (modelHasExtendedContextSuffix(trimmed)) return false;
  return CODEX_MODEL_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function modelHasSupportedSyntax(model: string): boolean {
  const trimmed = model.trim();
  if (trimmed.endsWith(CLAUDE_EXTENDED_CONTEXT_SUFFIX)) {
    const baseModel = trimmed.slice(0, -CLAUDE_EXTENDED_CONTEXT_SUFFIX.length);
    return baseModel.startsWith(CLAUDE_MODEL_PREFIX) && AGENT_MODEL_BODY_PATTERN.test(baseModel);
  }
  if (modelHasExtendedContextSuffix(trimmed)) return false;
  return AGENT_MODEL_BODY_PATTERN.test(trimmed);
}

function modelHasExtendedContextSuffix(model: string): boolean {
  return model.includes("[") || model.includes("]");
}

export const agentConfigValueSchemas = {
  concurrency_limit: concurrencyLimitSchema,
  stall_timeout_ms: stallTimeoutSchema,
  max_retries: maxRetriesSchema,
  agent_provider: agentProviderSchema,
  agent_model: agentModelSchema,
} as const;

/**
 * Validate one (key, value) pair. Returns either the parsed value or the
 * first user-facing error message, so callers (UI + route handler) can share
 * the same wording.
 */
export function parseAgentConfigValue(
  key: AgentConfigKey,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const schema = agentConfigValueSchemas[key];
  const result = schema.safeParse(value);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return {
    ok: false,
    error: result.error.issues[0]?.message ?? "Invalid value.",
  };
}

export function isAgentConfigKey(value: unknown): value is AgentConfigKey {
  return (
    typeof value === "string" && (ALLOWED_AGENT_CONFIG_KEYS as readonly string[]).includes(value)
  );
}

export function isAgentProvider(value: unknown): value is AgentProvider {
  return typeof value === "string" && normalizeAgentProviderName(value) !== null;
}

/**
 * Some providers only accept a subset of model identifiers — Claude Code
 * expects `claude-*`, Codex expects OpenAI-family ids. Runtime readiness uses
 * this to surface a helpful inline warning before sessions run.
 */
export function modelMatchesProvider(provider: AgentProvider, model: string): boolean {
  const trimmed = model.trim();
  if (!trimmed) return false;
  if (!modelHasSupportedSyntax(trimmed)) return false;
  switch (provider) {
    case "claude-code":
      return trimmed.startsWith(CLAUDE_MODEL_PREFIX);
    case "codex":
      return (
        !modelHasExtendedContextSuffix(trimmed) &&
        CODEX_MODEL_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
      );
  }
}
