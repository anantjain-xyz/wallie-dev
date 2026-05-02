import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RATE_LIMITS,
  buildRateLimitHeaders,
  checkRateLimit,
  clearRateLimitsForTesting,
  describeRateLimits,
  enforceRateLimit,
} from "@/lib/rate-limit";

describe("rate-limit memory backend", () => {
  beforeEach(() => {
    clearRateLimitsForTesting();
    // Force the cached limiter to re-resolve as the in-memory backend even if
    // a stray UPSTASH_REDIS_REST_URL is exported on the developer's shell.
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows up to the configured cap per scope+key", async () => {
    const cap = RATE_LIMITS.agentRuns.max;
    for (let i = 0; i < cap; i += 1) {
      const result = await checkRateLimit("agentRuns", "ws-1:user-1");
      expect(result.success).toBe(true);
      expect(result.remaining).toBe(cap - 1 - i);
    }
  });

  it("blocks the next request after the cap is reached and reports Retry-After", async () => {
    const cap = RATE_LIMITS.agentRuns.max;
    for (let i = 0; i < cap; i += 1) {
      await checkRateLimit("agentRuns", "ws-1:user-1");
    }

    const blocked = await checkRateLimit("agentRuns", "ws-1:user-1");

    expect(blocked.success).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(
      Math.ceil(RATE_LIMITS.agentRuns.windowMs / 1000),
    );
  });

  it("isolates state between distinct keys and scopes", async () => {
    const cap = RATE_LIMITS.agentRuns.max;
    for (let i = 0; i < cap; i += 1) {
      await checkRateLimit("agentRuns", "ws-1:user-1");
    }

    // Different user — fresh bucket.
    const otherUser = await checkRateLimit("agentRuns", "ws-1:user-2");
    expect(otherUser.success).toBe(true);

    // Different scope — fresh bucket.
    const otherScope = await checkRateLimit("phaseAction", "ws-1:user-1");
    expect(otherScope.success).toBe(true);
  });

  it("recovers after the window elapses", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(0));
      const cap = RATE_LIMITS.agentRuns.max;
      for (let i = 0; i < cap; i += 1) {
        await checkRateLimit("agentRuns", "ws-1:user-window");
      }
      const blocked = await checkRateLimit("agentRuns", "ws-1:user-window");
      expect(blocked.success).toBe(false);

      vi.setSystemTime(new Date(RATE_LIMITS.agentRuns.windowMs + 1));
      const recovered = await checkRateLimit("agentRuns", "ws-1:user-window");
      expect(recovered.success).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("buildRateLimitHeaders includes Retry-After only when blocked", () => {
    const allowed = buildRateLimitHeaders({
      success: true,
      limit: 10,
      remaining: 9,
      resetMs: 60_000,
      retryAfterSeconds: 0,
    });
    expect(allowed["Retry-After"]).toBeUndefined();
    expect(allowed["X-RateLimit-Limit"]).toBe("10");
    expect(allowed["X-RateLimit-Remaining"]).toBe("9");
    expect(allowed["X-RateLimit-Reset"]).toBe("60");

    const blocked = buildRateLimitHeaders({
      success: false,
      limit: 10,
      remaining: 0,
      resetMs: 120_000,
      retryAfterSeconds: 30,
    });
    expect(blocked["Retry-After"]).toBe("30");
    expect(blocked["X-RateLimit-Limit"]).toBe("10");
    expect(blocked["X-RateLimit-Remaining"]).toBe("0");
  });

  it("enforceRateLimit returns null until the cap, then a 429 NextResponse", async () => {
    const cap = RATE_LIMITS.phaseAction.max;
    for (let i = 0; i < cap; i += 1) {
      const { response } = await enforceRateLimit("phaseAction", "ws-1:user-enforce");
      expect(response).toBeNull();
    }

    const { response, result } = await enforceRateLimit("phaseAction", "ws-1:user-enforce");
    expect(response).not.toBeNull();
    expect(response!.status).toBe(429);
    expect(response!.headers.get("Retry-After")).toBe(String(result.retryAfterSeconds));
    expect(response!.headers.get("X-RateLimit-Limit")).toBe(String(cap));
    expect(response!.headers.get("X-RateLimit-Remaining")).toBe("0");

    const body = (await response!.json()) as { error: string; retryAfterSeconds: number };
    expect(body.error).toMatch(/rate limit/i);
    expect(body.retryAfterSeconds).toBe(result.retryAfterSeconds);
  });

  it("describeRateLimits surfaces every configured bucket", () => {
    const summary = describeRateLimits();
    const scopes = summary.map((s) => s.scope).sort();
    expect(scopes).toEqual(["agentRuns", "phaseAction", "slackPerChannel", "slackPerWorkspace"]);
    for (const entry of summary) {
      const config = RATE_LIMITS[entry.scope];
      expect(entry.windowMs).toBe(config.windowMs);
      expect(entry.max).toBe(config.max);
      expect(entry.endpoint.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });
});

describe("rate-limit upstash backend", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearRateLimitsForTesting();
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://upstash.test");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");
    fetchSpy = vi.spyOn(globalThis, "fetch");
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    errorSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  function mockPipelineResponse(payload: unknown) {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(payload), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );
  }

  it("fails open and logs when a pipeline command returns an error", async () => {
    // ZCARD command (index 2) reports a Redis-level error; the pipeline still
    // returns 200. The buggy version of this code read result=undefined, treated
    // count as 0, and let every request through silently. We now surface the
    // error explicitly and fail open with a console.error trail.
    mockPipelineResponse([
      { result: 0 },
      { result: 1 },
      { error: "WRONGTYPE Operation against a key holding the wrong kind of value" },
      { result: 1 },
    ]);

    const result = await checkRateLimit("agentRuns", "ws-err:user-err");

    expect(result.success).toBe(true);
    expect(result.remaining).toBe(RATE_LIMITS.agentRuns.max);
    expect(errorSpy).toHaveBeenCalledWith(
      "Rate limit backend unavailable; failing open",
      expect.objectContaining({
        scope: "agentRuns",
        key: "ws-err:user-err",
        error: expect.any(Error),
      }),
    );
    const [, ctx] = errorSpy.mock.calls[0] as [string, { error: Error }];
    expect(ctx.error.message).toMatch(/pipeline command 2 failed.*WRONGTYPE/);
  });

  it("fails open when the ZCARD result is missing or non-numeric", async () => {
    mockPipelineResponse([{ result: 0 }, { result: 1 }, { result: null }, { result: 1 }]);

    const result = await checkRateLimit("agentRuns", "ws-null:user-null");

    expect(result.success).toBe(true);
    expect(errorSpy).toHaveBeenCalled();
    const [, ctx] = errorSpy.mock.calls[0] as [string, { error: Error }];
    expect(ctx.error.message).toMatch(/ZCARD returned unexpected/);
  });

  it("blocks when ZCARD reports the bucket is over capacity", async () => {
    // First exec — over the cap.
    mockPipelineResponse([
      { result: 0 },
      { result: 1 },
      { result: RATE_LIMITS.agentRuns.max + 1 },
      { result: 1 },
    ]);
    // Second exec — the over-limit follow-up: ZREM the just-added member, then
    // ZRANGE for the oldest surviving entry.
    mockPipelineResponse([{ result: 1 }, { result: ["existing-member", "0"] }]);

    const result = await checkRateLimit("agentRuns", "ws-block:user-block");

    expect(result.success).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
