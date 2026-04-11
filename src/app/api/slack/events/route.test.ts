import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

const SIGNING_SECRET = "test-signing-secret";

function makeSignature(body: string, timestamp: string) {
  const sigBasestring = `v0:${timestamp}:${body}`;
  return `v0=${createHmac("sha256", SIGNING_SECRET).update(sigBasestring).digest("hex")}`;
}

function nowTimestamp() {
  return String(Math.floor(Date.now() / 1000));
}

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  processQueuedAgentJobs: vi.fn(),
  decryptSecretValue: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/wallie/service", () => ({
  processQueuedAgentJobs: mocked.processQueuedAgentJobs,
}));

vi.mock("@/lib/secrets/crypto", () => ({
  decryptSecretValue: mocked.decryptSecretValue,
}));

// Mock next/server's after() to execute immediately
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return {
    ...actual,
    after: (fn: () => Promise<void>) => {
      fn().catch(() => {});
    },
  };
});

import { POST } from "./route";

function makeRequest(body: string, overrides?: { signature?: string; timestamp?: string }) {
  const ts = overrides?.timestamp ?? nowTimestamp();
  const sig = overrides?.signature ?? makeSignature(body, ts);

  return new Request("http://localhost:3000/api/slack/events", {
    body,
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": sig,
    },
    method: "POST",
  });
}

describe("POST /api/slack/events", () => {
  beforeAll(() => {
    vi.stubEnv("SLACK_SIGNING_SECRET", SIGNING_SECRET);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("responds to Slack URL verification challenge", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "test-challenge-token" });
    const response = await POST(makeRequest(body));
    const json = await response.json();

    expect(json.challenge).toBe("test-challenge-token");
  });

  it("rejects requests with invalid signatures", async () => {
    const body = JSON.stringify({ event: { type: "app_mention", text: "hello" } });
    const response = await POST(makeRequest(body, { signature: "v0=invalid" }));

    expect(response.status).toBe(401);
  });

  it("rejects requests with stale timestamps (>5 min)", async () => {
    const staleTs = String(Math.floor(Date.now() / 1000) - 600);
    const body = JSON.stringify({ event: { type: "app_mention", text: "hello" } });
    const response = await POST(
      makeRequest(body, { timestamp: staleTs, signature: makeSignature(body, staleTs) }),
    );

    // Stale timestamp should fail signature check
    expect(response.status).toBe(401);
  });

  it("drops bot messages immediately", async () => {
    const body = JSON.stringify({
      event: { bot_id: "B123", channel: "C1", text: "bot msg", ts: "1.1", type: "app_mention" },
      team_id: "T1",
    });
    const response = await POST(makeRequest(body));
    const json = await response.json();

    expect(json.ok).toBe(true);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("ignores non-app_mention events", async () => {
    const body = JSON.stringify({
      event: { channel: "C1", text: "hello", ts: "1.1", type: "message" },
      team_id: "T1",
    });
    const response = await POST(makeRequest(body));
    const json = await response.json();

    expect(json.ok).toBe(true);
  });

  it("responds with help text when no Linear URL in mention", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => ({ ok: true }) });
    vi.stubGlobal("fetch", mockFetch);

    mocked.decryptSecretValue.mockReturnValue("xoxb-test-token");

    const mockAdmin = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { bot_token_encrypted: "encrypted", workspace_id: "ws-1" },
        error: null,
      }),
    };
    mocked.createSupabaseAdminClient.mockReturnValue(mockAdmin);

    const body = JSON.stringify({
      event: { channel: "C1", text: "<@U123> help me", ts: "1.1", type: "app_mention" },
      team_id: "T1",
    });

    const response = await POST(makeRequest(body));
    const json = await response.json();

    expect(json.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({ method: "POST" }),
    );

    vi.unstubAllGlobals();
    vi.stubEnv("SLACK_SIGNING_SECRET", SIGNING_SECRET);
  });

  it("extracts Linear issue ID from mention text", async () => {
    const rpcFn = vi.fn().mockResolvedValue({ data: 42, error: null });

    const mockChain = () => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockReturnValue(chain);
      chain.select = vi.fn().mockReturnValue(chain);
      chain.eq = vi.fn().mockReturnValue(chain);
      chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      chain.insert = vi.fn().mockReturnValue(chain);
      chain.single = vi.fn().mockResolvedValue({ data: { id: "new-id" }, error: null });
      chain.rpc = rpcFn;
      return chain;
    };

    const mockAdmin = mockChain();

    // Override specific from() calls based on table name
    const fromMock = vi.fn().mockImplementation((table: string) => {
      const tableChain: Record<string, unknown> = {};
      tableChain.select = vi.fn().mockReturnValue(tableChain);
      tableChain.eq = vi.fn().mockReturnValue(tableChain);
      tableChain.insert = vi.fn().mockReturnValue(tableChain);
      tableChain.single = vi.fn().mockResolvedValue({ data: { id: `${table}-id` }, error: null });

      if (table === "slack_installations") {
        tableChain.maybeSingle = vi.fn().mockResolvedValue({
          data: { workspace_id: "ws-1" },
          error: null,
        });
      } else if (table === "pipeline_issues") {
        // First call (dedup check) returns null, second call (insert) returns new row
        tableChain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      } else if (table === "workspace_members") {
        tableChain.maybeSingle = vi.fn().mockResolvedValue({
          data: { id: "wallie-member-id" },
          error: null,
        });
      } else {
        tableChain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      }

      return tableChain;
    });

    mockAdmin.from = fromMock;
    mocked.createSupabaseAdminClient.mockReturnValue(mockAdmin);
    mocked.processQueuedAgentJobs.mockResolvedValue({});

    const body = JSON.stringify({
      event: {
        channel: "C1",
        text: "<@U123> check this https://linear.app/myteam/issue/TEAM-456 please",
        ts: "1.1",
        type: "app_mention",
      },
      team_id: "T1",
    });

    const response = await POST(makeRequest(body));
    const json = await response.json();

    expect(json.ok).toBe(true);
    // Should have queried slack_installations
    expect(fromMock).toHaveBeenCalledWith("slack_installations");
    // Should have created an anchor issue
    expect(fromMock).toHaveBeenCalledWith("issues");
    // Should have created a pipeline_issues row
    expect(fromMock).toHaveBeenCalledWith("pipeline_issues");
    // Should have enqueued a job
    expect(fromMock).toHaveBeenCalledWith("agent_jobs");
  });

  it("deduplicates mentions for the same Linear issue", async () => {
    const fromMock = vi.fn().mockImplementation((table: string) => {
      const tableChain: Record<string, unknown> = {};
      tableChain.select = vi.fn().mockReturnValue(tableChain);
      tableChain.eq = vi.fn().mockReturnValue(tableChain);

      if (table === "slack_installations") {
        tableChain.maybeSingle = vi.fn().mockResolvedValue({
          data: { workspace_id: "ws-1" },
          error: null,
        });
      } else if (table === "pipeline_issues") {
        // Already exists (dedup hit)
        tableChain.maybeSingle = vi.fn().mockResolvedValue({
          data: { id: "existing-pi" },
          error: null,
        });
      } else {
        tableChain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      }

      return tableChain;
    });

    mocked.createSupabaseAdminClient.mockReturnValue({ from: fromMock });

    const body = JSON.stringify({
      event: {
        channel: "C1",
        text: "<@U123> https://linear.app/team/issue/TEAM-789",
        ts: "1.1",
        type: "app_mention",
      },
      team_id: "T1",
    });

    const response = await POST(makeRequest(body));
    const json = await response.json();

    expect(json.ok).toBe(true);
    // Should NOT have called issues insert (dedup)
    expect(fromMock).not.toHaveBeenCalledWith("issues");
    expect(fromMock).not.toHaveBeenCalledWith("agent_jobs");
  });

  it("treats 23505 unique_violation on pipeline_issues insert as silent dedup", async () => {
    const rpcFn = vi.fn().mockResolvedValue({ data: 7, error: null });

    const issuesDelete = vi.fn();
    const fromMock = vi.fn().mockImplementation((table: string) => {
      const tableChain: Record<string, unknown> = {};
      tableChain.select = vi.fn().mockReturnValue(tableChain);
      tableChain.eq = vi.fn().mockReturnValue(tableChain);
      tableChain.insert = vi.fn().mockReturnValue(tableChain);
      tableChain.rpc = rpcFn;

      if (table === "slack_installations") {
        tableChain.maybeSingle = vi.fn().mockResolvedValue({
          data: { workspace_id: "ws-1" },
          error: null,
        });
      } else if (table === "pipeline_issues") {
        // Pre-insert dedup check: nothing exists yet
        tableChain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
        // The insert races with a concurrent request and hits the partial unique index
        tableChain.single = vi.fn().mockResolvedValue({
          data: null,
          error: { code: "23505", message: "duplicate key value violates unique constraint" },
        });
      } else if (table === "workspace_members") {
        tableChain.maybeSingle = vi.fn().mockResolvedValue({
          data: { id: "wallie-member-id" },
          error: null,
        });
      } else if (table === "issues") {
        tableChain.single = vi.fn().mockResolvedValue({
          data: { id: "anchor-id" },
          error: null,
        });
        // Orphan-issues compensator: events route deletes the anchor row
        // after a failed pipeline_issues insert to avoid ghost rows.
        tableChain.delete = issuesDelete.mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
        });
      } else {
        tableChain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
        tableChain.single = vi.fn().mockResolvedValue({ data: null, error: null });
      }

      return tableChain;
    });

    const mockAdmin = { from: fromMock, rpc: rpcFn };
    mocked.createSupabaseAdminClient.mockReturnValue(mockAdmin);

    const body = JSON.stringify({
      event: {
        channel: "C1",
        text: "<@U123> https://linear.app/team/issue/TEAM-111",
        ts: "1.1",
        type: "app_mention",
      },
      team_id: "T1",
    });

    const response = await POST(makeRequest(body));
    const json = await response.json();

    // 23505 must return ok:true silently (concurrent request will enqueue the job)
    expect(json.ok).toBe(true);
    // We must NOT have enqueued a second agent_jobs row after the 23505
    expect(fromMock).not.toHaveBeenCalledWith("agent_jobs");
    // Orphan-issues compensator must have fired: the anchor issues row we
    // just created is deleted since the losing race can never wire it to a
    // pipeline_issue.
    expect(issuesDelete).toHaveBeenCalled();
  });

  it("handles unknown Slack team gracefully", async () => {
    const fromMock = vi.fn().mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      chain.select = vi.fn().mockReturnValue(chain);
      chain.eq = vi.fn().mockReturnValue(chain);
      chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      return chain;
    });

    mocked.createSupabaseAdminClient.mockReturnValue({ from: fromMock });

    const body = JSON.stringify({
      event: {
        channel: "C1",
        text: "<@U123> https://linear.app/team/issue/TEAM-999",
        ts: "1.1",
        type: "app_mention",
      },
      team_id: "T-UNKNOWN",
    });

    const response = await POST(makeRequest(body));
    const json = await response.json();

    expect(json.ok).toBe(true);
    // Should not crash, just log and return
  });
});
