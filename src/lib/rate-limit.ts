import "server-only";

import { NextResponse } from "next/server";

export type RateLimitScope = keyof typeof RATE_LIMITS;

export type RateLimitConfig = {
  /** Sliding window length in milliseconds. */
  windowMs: number;
  /** Maximum number of requests permitted within the window. */
  max: number;
};

export type RateLimitResult = {
  success: boolean;
  /** Configured cap for this bucket. */
  limit: number;
  /** Remaining capacity after this request (0 when exceeded). */
  remaining: number;
  /** Unix epoch milliseconds at which the oldest counted request falls out of the window. */
  resetMs: number;
  /** Seconds until the caller may retry — 0 when allowed. */
  retryAfterSeconds: number;
};

/**
 * Per-route caps. Surfaced to the workspace settings UI via {@link describeRateLimits}.
 *
 * These are intentionally conservative defaults sized so a single client cannot
 * burn meaningful sandbox/LLM spend before a human notices, while staying well
 * above normal interactive use.
 */
export const RATE_LIMITS = {
  /** POST /api/agent-runs and /api/agent-runs/:id/retry — sandbox spawn. */
  agentRuns: { windowMs: 60_000, max: 10 },
  /** POST /api/sessions/:id/phase-action — approve/reject. */
  phaseAction: { windowMs: 60_000, max: 30 },
} as const satisfies Record<string, RateLimitConfig>;

export type RateLimiter = {
  check(scope: RateLimitScope, key: string): Promise<RateLimitResult>;
};

// ---------------------------------------------------------------------------
// In-memory sliding-window limiter. Production on Vercel runs across many
// isolated instances, so each instance keeps its own bucket — the effective
// cap is `max × instance_count`. Acceptable for the small caps we set here;
// revisit if we ever need precise global limits.
// ---------------------------------------------------------------------------

type MemoryBucket = number[];

const memoryBuckets = new Map<string, MemoryBucket>();

function memoryCheck(scope: RateLimitScope, key: string): RateLimitResult {
  const config = RATE_LIMITS[scope];
  const now = Date.now();
  const cutoff = now - config.windowMs;
  const fullKey = `${scope}:${key}`;
  const previous = memoryBuckets.get(fullKey) ?? [];
  const live = previous.filter((ts) => ts > cutoff);

  if (live.length >= config.max) {
    memoryBuckets.set(fullKey, live);
    const oldest = live[0] ?? now;
    const resetMs = oldest + config.windowMs;
    return {
      success: false,
      limit: config.max,
      remaining: 0,
      resetMs,
      retryAfterSeconds: Math.max(1, Math.ceil((resetMs - now) / 1000)),
    };
  }

  live.push(now);
  memoryBuckets.set(fullKey, live);
  return {
    success: true,
    limit: config.max,
    remaining: config.max - live.length,
    resetMs: now + config.windowMs,
    retryAfterSeconds: 0,
  };
}

const memoryLimiter: RateLimiter = {
  check: async (scope, key) => memoryCheck(scope, key),
};

/** Test-only: drop all in-memory rate-limit state. */
export function clearRateLimitsForTesting() {
  memoryBuckets.clear();
}

/** Check the configured limit for a scope/key. */
export async function checkRateLimit(scope: RateLimitScope, key: string): Promise<RateLimitResult> {
  return memoryLimiter.check(scope, key);
}

/** Build the standard X-RateLimit-* + Retry-After header bag for a result. */
export function buildRateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.ceil(result.resetMs / 1000)),
  };
  if (!result.success) {
    headers["Retry-After"] = String(result.retryAfterSeconds);
  }
  return headers;
}

/**
 * Convenience helper for HTTP route handlers: enforce a single bucket and, if
 * exceeded, return a fully-formed 429 NextResponse the caller can return
 * directly. The success branch returns a null response so callers can short
 * circuit with `if (gated.response) return gated.response`.
 */
export async function enforceRateLimit(
  scope: RateLimitScope,
  key: string,
): Promise<{ result: RateLimitResult; response: NextResponse | null }> {
  const result = await checkRateLimit(scope, key);
  if (result.success) {
    return { result, response: null };
  }
  const response = NextResponse.json(
    {
      error: "Rate limit exceeded. Please retry later.",
      retryAfterSeconds: result.retryAfterSeconds,
    },
    {
      headers: buildRateLimitHeaders(result),
      status: 429,
    },
  );
  return { result, response };
}

/** Read-only summary of the configured caps for display in the settings UI. */
export function describeRateLimits(): Array<{
  endpoint: string;
  scope: RateLimitScope;
  description: string;
  windowMs: number;
  max: number;
}> {
  return [
    {
      endpoint: "POST /api/agent-runs (incl. retry)",
      scope: "agentRuns",
      description: "Per workspace member — caps sandbox spawns.",
      ...RATE_LIMITS.agentRuns,
    },
    {
      endpoint: "POST /api/sessions/:id/phase-action",
      scope: "phaseAction",
      description: "Per workspace member — caps approve/reject churn.",
      ...RATE_LIMITS.phaseAction,
    },
  ];
}
