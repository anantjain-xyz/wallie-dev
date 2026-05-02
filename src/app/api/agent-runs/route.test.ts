import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RATE_LIMITS, clearRateLimitsForTesting } from "@/lib/rate-limit";

const mocked = vi.hoisted(() => ({
  enqueueWallieRun: vi.fn(),
  processQueuedAgentJobs: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
}));

vi.mock("@/lib/wallie/service", () => ({
  enqueueWallieRun: mocked.enqueueWallieRun,
  processQueuedAgentJobs: mocked.processQueuedAgentJobs,
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return {
    ...actual,
    after: () => {
      // Drop deferred work — these tests only assert on the synchronous path.
    },
  };
});

import { POST } from "./route";

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost:3000/api/agent-runs", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

const validBody = {
  sessionId: "11111111-1111-1111-1111-111111111111",
  workspaceId: "22222222-2222-2222-2222-222222222222",
};

describe("POST /api/agent-runs rate limiting", () => {
  beforeEach(() => {
    clearRateLimitsForTesting();
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");

    mocked.requireWorkspaceAccessById.mockResolvedValue({
      ok: true,
      context: {
        currentMember: { id: "member-1", is_active: true, kind: "human", role: "owner" },
        supabase: {},
        user: { id: "user-1" },
        workspace: { id: validBody.workspaceId, name: "Acme", slug: "acme" },
      },
    });
    mocked.enqueueWallieRun.mockResolvedValue({
      created: true,
      jobId: "job-1",
      run: { id: "run-1" },
    });
    mocked.processQueuedAgentJobs.mockResolvedValue({});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("returns 201 up to the cap, then 429 with Retry-After + X-RateLimit headers", async () => {
    const cap = RATE_LIMITS.agentRuns.max;

    for (let i = 0; i < cap; i += 1) {
      const response = await POST(makeRequest(validBody));
      expect(response.status).toBe(201);
    }

    const blocked = await POST(makeRequest(validBody));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).not.toBeNull();
    expect(blocked.headers.get("X-RateLimit-Limit")).toBe(String(cap));
    expect(blocked.headers.get("X-RateLimit-Remaining")).toBe("0");

    const body = (await blocked.json()) as { error: string; retryAfterSeconds: number };
    expect(body.error).toMatch(/rate limit/i);
    expect(body.retryAfterSeconds).toBeGreaterThan(0);

    expect(mocked.enqueueWallieRun).toHaveBeenCalledTimes(cap);
  });

  it("isolates per-(workspace, user) buckets", async () => {
    const cap = RATE_LIMITS.agentRuns.max;
    for (let i = 0; i < cap; i += 1) {
      await POST(makeRequest(validBody));
    }

    // Same workspace, different user — should still succeed.
    mocked.requireWorkspaceAccessById.mockResolvedValueOnce({
      ok: true,
      context: {
        currentMember: { id: "member-2", is_active: true, kind: "human", role: "member" },
        supabase: {},
        user: { id: "user-2" },
        workspace: { id: validBody.workspaceId, name: "Acme", slug: "acme" },
      },
    });

    const response = await POST(makeRequest(validBody));
    expect(response.status).toBe(201);
  });
});
