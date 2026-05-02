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
  /** POST /api/slack/events — per workspace (Slack team). */
  slackPerWorkspace: { windowMs: 60_000, max: 30 },
  /** POST /api/slack/events — per channel within a workspace. */
  slackPerChannel: { windowMs: 60_000, max: 10 },
} as const satisfies Record<string, RateLimitConfig>;

export type RateLimiter = {
  check(scope: RateLimitScope, key: string): Promise<RateLimitResult>;
};

// ---------------------------------------------------------------------------
// In-memory limiter — used in dev/tests and as a graceful fallback when
// Upstash credentials are not configured. Production on Vercel runs across
// many isolated instances, so without a shared backend the limit is "best
// effort" — explicitly logged at module init.
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

// ---------------------------------------------------------------------------
// Upstash REST limiter — sliding window via sorted sets. Activated when both
// UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set.
// Fail-open: if the backend errors we let the request through so a transient
// upstash outage cannot DoS our own product.
// ---------------------------------------------------------------------------

type UpstashPipelineResponse = Array<{ result?: unknown; error?: string }>;

function buildUpstashLimiter(url: string, token: string): RateLimiter {
  async function exec(commands: Array<Array<string>>): Promise<UpstashPipelineResponse> {
    const response = await fetch(`${url}/pipeline`, {
      body: JSON.stringify(commands),
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    if (!response.ok) {
      throw new Error(`Upstash pipeline returned ${response.status}`);
    }

    return (await response.json()) as UpstashPipelineResponse;
  }

  return {
    async check(scope, key) {
      const config = RATE_LIMITS[scope];
      const now = Date.now();
      const cutoff = now - config.windowMs;
      const redisKey = `ratelimit:${scope}:${key}`;
      // Member is unique per request so concurrent inserts at the same ms do
      // not collide on the sorted set's score+member uniqueness.
      const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;

      try {
        const results = await exec([
          ["ZREMRANGEBYSCORE", redisKey, "0", String(cutoff)],
          ["ZADD", redisKey, String(now), member],
          ["ZCARD", redisKey],
          ["PEXPIRE", redisKey, String(config.windowMs * 2)],
        ]);

        // Upstash returns HTTP 200 even when individual pipeline commands fail
        // (e.g. WRONGTYPE on a stale key). Surface those as a backend error so
        // the catch below logs and fails open explicitly instead of treating
        // the missing result as a count of 0, which would silently bypass the
        // limiter for every subsequent request.
        for (const [index, entry] of results.entries()) {
          if (entry?.error) {
            throw new Error(`Upstash pipeline command ${index} failed: ${entry.error}`);
          }
        }

        const cardResult = results[2]?.result;
        if (typeof cardResult !== "number") {
          throw new Error(
            `Upstash ZCARD returned unexpected ${typeof cardResult}: ${JSON.stringify(cardResult)}`,
          );
        }
        const count = cardResult;

        if (count <= config.max) {
          return {
            success: true,
            limit: config.max,
            remaining: Math.max(0, config.max - count),
            resetMs: now + config.windowMs,
            retryAfterSeconds: 0,
          };
        }

        // Over the limit — pull the just-inserted member back off so the next
        // call's count reflects only legitimate hits, then read the oldest
        // surviving timestamp to compute Retry-After.
        const followUp = await exec([
          ["ZREM", redisKey, member],
          ["ZRANGE", redisKey, "0", "0", "WITHSCORES"],
        ]);
        const oldestEntry = followUp[1]?.result;
        const oldestTs =
          Array.isArray(oldestEntry) && oldestEntry.length >= 2 ? Number(oldestEntry[1]) : now;
        const resetMs = oldestTs + config.windowMs;

        return {
          success: false,
          limit: config.max,
          remaining: 0,
          resetMs,
          retryAfterSeconds: Math.max(1, Math.ceil((resetMs - now) / 1000)),
        };
      } catch (error) {
        console.error("Rate limit backend unavailable; failing open", { error, scope, key });
        return {
          success: true,
          limit: config.max,
          remaining: config.max,
          resetMs: now + config.windowMs,
          retryAfterSeconds: 0,
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Singleton selection. Resolved on first use so tests that stub env vars take
// effect, but cached so we don't rebuild the fetch closure on every request.
// ---------------------------------------------------------------------------

let cachedLimiter: RateLimiter | null = null;
let cachedFingerprint: string | null = null;

function getRateLimiter(): RateLimiter {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  const fingerprint = url && token ? `upstash:${url}` : "memory";

  if (cachedLimiter && cachedFingerprint === fingerprint) {
    return cachedLimiter;
  }

  cachedFingerprint = fingerprint;
  cachedLimiter = url && token ? buildUpstashLimiter(url, token) : memoryLimiter;
  return cachedLimiter;
}

/**
 * Check the configured limit for a scope/key. Always resolves; on backend
 * failure the call fails open and `success` is true.
 */
export async function checkRateLimit(scope: RateLimitScope, key: string): Promise<RateLimitResult> {
  return getRateLimiter().check(scope, key);
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
    {
      endpoint: "POST /api/slack/events (workspace)",
      scope: "slackPerWorkspace",
      description: "Per Slack workspace — caps mention-driven session creation.",
      ...RATE_LIMITS.slackPerWorkspace,
    },
    {
      endpoint: "POST /api/slack/events (channel)",
      scope: "slackPerChannel",
      description: "Per Slack channel — extra protection against a noisy channel.",
      ...RATE_LIMITS.slackPerChannel,
    },
  ];
}
