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
  decryptSecretValue: vi.fn(),
  fetchLinearIssue: vi.fn(),
  processQueuedAgentJobs: vi.fn(),
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

vi.mock("@/lib/linear/client", () => ({
  fetchLinearIssue: mocked.fetchLinearIssue,
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

// Helper to assemble the per-table chains the events route consumes. Each
// route call walks several tables in sequence, and the test surface needs to
// be able to override behavior per table while keeping the rest sane.
type TableHandler = () => Record<string, unknown>;

function makeAdmin(
  handlers: Record<string, TableHandler>,
  rpcResult: { data: unknown; error: unknown } = { data: 1, error: null },
) {
  const fromMock = vi.fn().mockImplementation((table: string) => {
    const handler = handlers[table];
    if (handler) return handler();

    const fallback: Record<string, unknown> = {};
    fallback.select = vi.fn().mockReturnValue(fallback);
    fallback.eq = vi.fn().mockReturnValue(fallback);
    fallback.insert = vi.fn().mockReturnValue(fallback);
    fallback.delete = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });
    fallback.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    fallback.single = vi.fn().mockResolvedValue({ data: { id: `${table}-id` }, error: null });
    return fallback;
  });

  const rpcMock = vi.fn().mockResolvedValue(rpcResult);
  return { client: { from: fromMock, rpc: rpcMock }, fromMock, rpcMock };
}

function slackInstallHandler(workspaceId: string = "ws-1"): TableHandler {
  return () => {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue(chain);
    chain.maybeSingle = vi.fn().mockResolvedValue({
      data: { bot_token_encrypted: "enc-bot-token", workspace_id: workspaceId },
      error: null,
    });
    return chain;
  };
}

describe("POST /api/slack/events", () => {
  beforeAll(() => {
    vi.stubEnv("SLACK_SIGNING_SECRET", SIGNING_SECRET);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("responds to Slack URL verification challenge", async () => {
    const body = JSON.stringify({ challenge: "test-challenge-token", type: "url_verification" });
    const response = await POST(makeRequest(body));
    const json = await response.json();

    expect(json.challenge).toBe("test-challenge-token");
  });

  it("rejects requests with invalid signatures", async () => {
    const body = JSON.stringify({ event: { text: "hello", type: "app_mention" } });
    const response = await POST(makeRequest(body, { signature: "v0=invalid" }));

    expect(response.status).toBe(401);
  });

  it("rejects requests with stale timestamps (>5 min)", async () => {
    const staleTs = String(Math.floor(Date.now() / 1000) - 600);
    const body = JSON.stringify({ event: { text: "hello", type: "app_mention" } });
    const response = await POST(
      makeRequest(body, { signature: makeSignature(body, staleTs), timestamp: staleTs }),
    );

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

  it("returns ok when neither team_id nor enterprise_id is present", async () => {
    const body = JSON.stringify({
      event: { channel: "C1", text: "<@U> hi", ts: "1.1", type: "app_mention" },
    });
    const response = await POST(makeRequest(body));
    const json = await response.json();

    expect(json.ok).toBe(true);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("falls back to enterprise_id for Enterprise Grid mentions", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ json: () => ({ ok: true }), ok: true });
    vi.stubGlobal("fetch", mockFetch);
    mocked.decryptSecretValue.mockReturnValue("xoxb-grid");

    const lookups: Array<{ col: string; value: unknown }> = [];
    const installHandler: TableHandler = () => {
      const chain: Record<string, unknown> = {};
      chain.select = vi.fn().mockReturnValue(chain);
      chain.eq = vi.fn().mockImplementation((col: string, value: unknown) => {
        lookups.push({ col, value });
        return chain;
      });
      chain.maybeSingle = vi.fn().mockResolvedValue({
        data: { bot_token_encrypted: "enc", workspace_id: "ws-grid" },
        error: null,
      });
      return chain;
    };
    const { client } = makeAdmin({ slack_installations: installHandler });
    mocked.createSupabaseAdminClient.mockReturnValue(client);

    // No Linear URL → fast-path help reply, which is enough to confirm the
    // installation lookup actually used enterprise_id.
    const body = JSON.stringify({
      enterprise_id: "E-GRID",
      event: { channel: "C1", text: "<@U> hello", ts: "1.1", type: "app_mention" },
    });

    const response = await POST(makeRequest(body));
    const json = await response.json();

    expect(json.ok).toBe(true);
    expect(lookups).toContainEqual({ col: "team_id", value: "E-GRID" });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({ method: "POST" }),
    );

    vi.unstubAllGlobals();
    vi.stubEnv("SLACK_SIGNING_SECRET", SIGNING_SECRET);
  });

  it("responds with help text when no Linear URL in mention", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ json: () => ({ ok: true }), ok: true });
    vi.stubGlobal("fetch", mockFetch);

    mocked.decryptSecretValue.mockReturnValue("xoxb-test-token");
    const { client } = makeAdmin({ slack_installations: slackInstallHandler() });
    mocked.createSupabaseAdminClient.mockReturnValue(client);

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

  it("posts a Slack error and aborts when LINEAR_API_KEY is missing", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ json: () => ({ ok: true }), ok: true });
    vi.stubGlobal("fetch", mockFetch);
    mocked.decryptSecretValue.mockReturnValue("xoxb-token");

    const { client, fromMock } = makeAdmin({
      pipeline_issues: () => {
        const chain: Record<string, unknown> = {};
        chain.select = vi.fn().mockReturnValue(chain);
        chain.eq = vi.fn().mockReturnValue(chain);
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
        return chain;
      },
      slack_installations: slackInstallHandler(),
      workspace_secrets: () => {
        const chain: Record<string, unknown> = {};
        chain.select = vi.fn().mockReturnValue(chain);
        chain.eq = vi.fn().mockReturnValue(chain);
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
        return chain;
      },
    });
    mocked.createSupabaseAdminClient.mockReturnValue(client);

    const body = JSON.stringify({
      event: {
        channel: "C1",
        text: "<@U> https://linear.app/team/issue/TEAM-200",
        ts: "1.1",
        type: "app_mention",
      },
      team_id: "T1",
    });

    const response = await POST(makeRequest(body));
    const json = await response.json();

    expect(json.ok).toBe(true);
    // Linear fetch must NOT be called without an API key
    expect(mocked.fetchLinearIssue).not.toHaveBeenCalled();
    // No anchor row should have been created
    expect(fromMock).not.toHaveBeenCalledWith("issues");
    // The user should have been told to set the key
    expect(mockFetch).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({ method: "POST" }),
    );
    const callBody = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
    expect(callBody.text).toContain("LINEAR_API_KEY");

    vi.unstubAllGlobals();
    vi.stubEnv("SLACK_SIGNING_SECRET", SIGNING_SECRET);
  });

  it("posts a Slack error when the Linear fetch fails", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ json: () => ({ ok: true }), ok: true });
    vi.stubGlobal("fetch", mockFetch);
    mocked.decryptSecretValue.mockReturnValue("xoxb-or-linear-key");
    mocked.fetchLinearIssue.mockRejectedValue(new Error("Linear issue not found: TEAM-300"));

    const { client, fromMock } = makeAdmin({
      pipeline_issues: () => {
        const chain: Record<string, unknown> = {};
        chain.select = vi.fn().mockReturnValue(chain);
        chain.eq = vi.fn().mockReturnValue(chain);
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
        return chain;
      },
      slack_installations: slackInstallHandler(),
      workspace_secrets: () => {
        const chain: Record<string, unknown> = {};
        chain.select = vi.fn().mockReturnValue(chain);
        chain.eq = vi.fn().mockReturnValue(chain);
        chain.maybeSingle = vi.fn().mockResolvedValue({
          data: { encrypted_value: "enc-linear-key" },
          error: null,
        });
        return chain;
      },
    });
    mocked.createSupabaseAdminClient.mockReturnValue(client);

    const body = JSON.stringify({
      event: {
        channel: "C1",
        text: "<@U> https://linear.app/team/issue/TEAM-300",
        ts: "1.1",
        type: "app_mention",
      },
      team_id: "T1",
    });

    const response = await POST(makeRequest(body));
    const json = await response.json();

    expect(json.ok).toBe(true);
    expect(mocked.fetchLinearIssue).toHaveBeenCalled();
    // No anchor row should have been created
    expect(fromMock).not.toHaveBeenCalledWith("issues");
    // The user should have been told why
    expect(mockFetch).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({ method: "POST" }),
    );
    const callBody = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
    expect(callBody.text).toContain("TEAM-300");

    vi.unstubAllGlobals();
    vi.stubEnv("SLACK_SIGNING_SECRET", SIGNING_SECRET);
  });

  it("creates an anchor + pipeline_issues row and shadow-writes sessions", async () => {
    mocked.decryptSecretValue.mockReturnValue("plain-linear-key");
    mocked.fetchLinearIssue.mockResolvedValue({
      description: "fix the auth bug",
      id: "linear-uuid",
      identifier: "TEAM-456",
      title: "Auth bug",
      url: "https://linear.app/myteam/issue/TEAM-456",
    });
    mocked.processQueuedAgentJobs.mockResolvedValue({});

    const issuesInsert = vi.fn();
    const pipelineInsert = vi.fn();
    const sessionsInsert = vi.fn();

    const { client, fromMock, rpcMock } = makeAdmin(
      {
        agent_jobs: () => {
          const chain: Record<string, unknown> = {};
          chain.insert = vi.fn().mockReturnValue(chain);
          chain.select = vi.fn().mockReturnValue(chain);
          chain.single = vi.fn().mockResolvedValue({ data: { id: "job-1" }, error: null });
          return chain;
        },
        issues: () => {
          const chain: Record<string, unknown> = {};
          chain.insert = vi.fn().mockImplementation((row: unknown) => {
            issuesInsert(row);
            return chain;
          });
          chain.select = vi.fn().mockReturnValue(chain);
          chain.single = vi.fn().mockResolvedValue({ data: { id: "anchor-1" }, error: null });
          return chain;
        },
        pipeline_issues: () => {
          const chain: Record<string, unknown> = {};
          chain.select = vi.fn().mockReturnValue(chain);
          chain.eq = vi.fn().mockReturnValue(chain);
          // Pre-insert dedup check finds nothing
          chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
          chain.insert = vi.fn().mockImplementation((row: unknown) => {
            pipelineInsert(row);
            return chain;
          });
          chain.single = vi.fn().mockResolvedValue({ data: { id: "pi-1" }, error: null });
          return chain;
        },
        sessions: () => ({
          insert: vi.fn().mockImplementation(async (row: unknown) => {
            sessionsInsert(row);
            return { error: null };
          }),
        }),
        slack_installations: slackInstallHandler(),
        workspace_members: () => {
          const chain: Record<string, unknown> = {};
          chain.select = vi.fn().mockReturnValue(chain);
          chain.eq = vi.fn().mockReturnValue(chain);
          chain.maybeSingle = vi.fn().mockResolvedValue({
            data: { id: "wallie-member-id" },
            error: null,
          });
          return chain;
        },
        workspace_secrets: () => {
          const chain: Record<string, unknown> = {};
          chain.select = vi.fn().mockReturnValue(chain);
          chain.eq = vi.fn().mockReturnValue(chain);
          chain.maybeSingle = vi.fn().mockResolvedValue({
            data: { encrypted_value: "enc-linear-key" },
            error: null,
          });
          return chain;
        },
      },
      { data: 42, error: null },
    );

    mocked.createSupabaseAdminClient.mockReturnValue(client);

    const body = JSON.stringify({
      event: {
        channel: "C1",
        text: "<@U> https://linear.app/myteam/issue/TEAM-456 please",
        ts: "1.1",
        type: "app_mention",
      },
      team_id: "T1",
    });

    const response = await POST(makeRequest(body));
    const json = await response.json();

    expect(json.ok).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith("next_issue_number", { target_workspace_id: "ws-1" });
    // Anchor was populated from Linear data
    expect(issuesInsert).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Auth bug", workspace_id: "ws-1" }),
    );
    const anchorRow = issuesInsert.mock.calls[0]![0] as { description_md: string };
    expect(anchorRow.description_md).toContain("fix the auth bug");
    expect(anchorRow.description_md).toContain("https://linear.app/myteam/issue/TEAM-456");
    // pipeline_issues row references the anchor
    expect(pipelineInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_id: "anchor-1",
        linear_issue_id: "TEAM-456",
        phase: "product",
        phase_status: "agent_generating",
      }),
    );
    // Shadow-write to sessions carries the same per-workspace number, phase,
    // Slack thread, and Linear linkage as the legacy pipeline_issue.
    expect(sessionsInsert).toHaveBeenCalledTimes(1);
    expect(sessionsInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        creator_member_id: "wallie-member-id",
        linear_issue_id: "TEAM-456",
        linear_issue_url: "https://linear.app/myteam/issue/TEAM-456",
        number: 42,
        phase: "product",
        phase_status: "agent_generating",
        slack_channel_id: "C1",
        slack_thread_ts: "1.1",
        title: "Auth bug",
        workspace_id: "ws-1",
      }),
    );
    expect(fromMock).toHaveBeenCalledWith("agent_jobs");
  });

  it("logs but does not abort when the sessions shadow write fails", async () => {
    mocked.decryptSecretValue.mockReturnValue("plain-linear-key");
    mocked.fetchLinearIssue.mockResolvedValue({
      description: "shadow failure",
      id: "linear-uuid",
      identifier: "TEAM-555",
      title: "Shadow failure",
      url: "https://linear.app/team/issue/TEAM-555",
    });
    mocked.processQueuedAgentJobs.mockResolvedValue({});

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { client, fromMock } = makeAdmin(
      {
        agent_jobs: () => {
          const chain: Record<string, unknown> = {};
          chain.insert = vi.fn().mockReturnValue(chain);
          chain.select = vi.fn().mockReturnValue(chain);
          chain.single = vi.fn().mockResolvedValue({ data: { id: "job-555" }, error: null });
          return chain;
        },
        issues: () => {
          const chain: Record<string, unknown> = {};
          chain.insert = vi.fn().mockReturnValue(chain);
          chain.select = vi.fn().mockReturnValue(chain);
          chain.single = vi.fn().mockResolvedValue({ data: { id: "anchor-555" }, error: null });
          return chain;
        },
        pipeline_issues: () => {
          const chain: Record<string, unknown> = {};
          chain.select = vi.fn().mockReturnValue(chain);
          chain.eq = vi.fn().mockReturnValue(chain);
          chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
          chain.insert = vi.fn().mockReturnValue(chain);
          chain.single = vi.fn().mockResolvedValue({ data: { id: "pi-555" }, error: null });
          return chain;
        },
        sessions: () => ({
          insert: vi.fn().mockResolvedValue({
            error: { code: "XX000", message: "shadow insert blew up" },
          }),
        }),
        slack_installations: slackInstallHandler(),
        workspace_members: () => {
          const chain: Record<string, unknown> = {};
          chain.select = vi.fn().mockReturnValue(chain);
          chain.eq = vi.fn().mockReturnValue(chain);
          chain.maybeSingle = vi.fn().mockResolvedValue({
            data: { id: "wallie-member-id" },
            error: null,
          });
          return chain;
        },
        workspace_secrets: () => {
          const chain: Record<string, unknown> = {};
          chain.select = vi.fn().mockReturnValue(chain);
          chain.eq = vi.fn().mockReturnValue(chain);
          chain.maybeSingle = vi.fn().mockResolvedValue({
            data: { encrypted_value: "enc-linear-key" },
            error: null,
          });
          return chain;
        },
      },
      { data: 99, error: null },
    );
    mocked.createSupabaseAdminClient.mockReturnValue(client);

    const body = JSON.stringify({
      event: {
        channel: "C1",
        text: "<@U> https://linear.app/team/issue/TEAM-555",
        ts: "1.1",
        type: "app_mention",
      },
      team_id: "T1",
    });

    const response = await POST(makeRequest(body));
    const json = await response.json();

    expect(json.ok).toBe(true);
    // Legacy path must still have queued a job — shadow-write failure cannot
    // regress production.
    expect(fromMock).toHaveBeenCalledWith("agent_jobs");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to shadow-write sessions row",
      expect.objectContaining({ error: expect.objectContaining({ code: "XX000" }) }),
    );

    consoleErrorSpy.mockRestore();
  });

  it("recovers from a previously rejected pipeline_issue when re-mentioned", async () => {
    mocked.decryptSecretValue.mockReturnValue("plain-linear-key");
    mocked.fetchLinearIssue.mockResolvedValue({
      description: "round 2",
      id: "linear-uuid",
      identifier: "TEAM-789",
      title: "Retry me",
      url: "https://linear.app/team/issue/TEAM-789",
    });
    mocked.processQueuedAgentJobs.mockResolvedValue({});

    const pipelineDeleteEq = vi.fn().mockResolvedValue({ error: null });
    const issuesDeleteEq = vi.fn().mockResolvedValue({ error: null });

    const { client, fromMock } = makeAdmin({
      agent_jobs: () => {
        const chain: Record<string, unknown> = {};
        chain.insert = vi.fn().mockReturnValue(chain);
        chain.select = vi.fn().mockReturnValue(chain);
        chain.single = vi.fn().mockResolvedValue({ data: { id: "job-2" }, error: null });
        return chain;
      },
      issues: () => {
        const chain: Record<string, unknown> = {};
        chain.insert = vi.fn().mockReturnValue(chain);
        chain.select = vi.fn().mockReturnValue(chain);
        chain.single = vi.fn().mockResolvedValue({ data: { id: "anchor-new" }, error: null });
        chain.delete = vi.fn().mockReturnValue({ eq: issuesDeleteEq });
        return chain;
      },
      pipeline_issues: () => {
        const chain: Record<string, unknown> = {};
        chain.select = vi.fn().mockReturnValue(chain);
        chain.eq = vi.fn().mockReturnValue(chain);
        chain.maybeSingle = vi.fn().mockResolvedValue({
          data: {
            id: "old-pi",
            issue_id: "old-anchor",
            phase_status: "rejected",
          },
          error: null,
        });
        chain.delete = vi.fn().mockReturnValue({ eq: pipelineDeleteEq });
        chain.insert = vi.fn().mockReturnValue(chain);
        chain.single = vi.fn().mockResolvedValue({ data: { id: "pi-new" }, error: null });
        return chain;
      },
      slack_installations: slackInstallHandler(),
      workspace_members: () => {
        const chain: Record<string, unknown> = {};
        chain.select = vi.fn().mockReturnValue(chain);
        chain.eq = vi.fn().mockReturnValue(chain);
        chain.maybeSingle = vi.fn().mockResolvedValue({
          data: { id: "wallie-member-id" },
          error: null,
        });
        return chain;
      },
      workspace_secrets: () => {
        const chain: Record<string, unknown> = {};
        chain.select = vi.fn().mockReturnValue(chain);
        chain.eq = vi.fn().mockReturnValue(chain);
        chain.maybeSingle = vi.fn().mockResolvedValue({
          data: { encrypted_value: "enc-linear-key" },
          error: null,
        });
        return chain;
      },
    });
    mocked.createSupabaseAdminClient.mockReturnValue(client);

    const body = JSON.stringify({
      event: {
        channel: "C1",
        text: "<@U> https://linear.app/team/issue/TEAM-789",
        ts: "1.1",
        type: "app_mention",
      },
      team_id: "T1",
    });

    const response = await POST(makeRequest(body));
    const json = await response.json();

    expect(json.ok).toBe(true);
    // Old pipeline_issue and its anchor were dropped
    expect(pipelineDeleteEq).toHaveBeenCalledWith("id", "old-pi");
    expect(issuesDeleteEq).toHaveBeenCalledWith("id", "old-anchor");
    // A fresh anchor + agent job were created
    expect(fromMock).toHaveBeenCalledWith("agent_jobs");
  });

  it("deduplicates mentions for the same Linear issue when not rejected", async () => {
    const { client, fromMock } = makeAdmin({
      pipeline_issues: () => {
        const chain: Record<string, unknown> = {};
        chain.select = vi.fn().mockReturnValue(chain);
        chain.eq = vi.fn().mockReturnValue(chain);
        chain.maybeSingle = vi.fn().mockResolvedValue({
          data: { id: "existing-pi", issue_id: "anchor-a", phase_status: "awaiting_review" },
          error: null,
        });
        return chain;
      },
      slack_installations: slackInstallHandler(),
    });
    mocked.createSupabaseAdminClient.mockReturnValue(client);

    const body = JSON.stringify({
      event: {
        channel: "C1",
        text: "<@U> https://linear.app/team/issue/TEAM-789",
        ts: "1.1",
        type: "app_mention",
      },
      team_id: "T1",
    });

    const response = await POST(makeRequest(body));
    const json = await response.json();

    expect(json.ok).toBe(true);
    expect(fromMock).not.toHaveBeenCalledWith("issues");
    expect(fromMock).not.toHaveBeenCalledWith("agent_jobs");
    expect(mocked.fetchLinearIssue).not.toHaveBeenCalled();
  });

  it("treats 23505 unique_violation on pipeline_issues insert as silent dedup", async () => {
    mocked.decryptSecretValue.mockReturnValue("plain-linear-key");
    mocked.fetchLinearIssue.mockResolvedValue({
      description: "race",
      id: "linear-uuid",
      identifier: "TEAM-111",
      title: "Race",
      url: "https://linear.app/team/issue/TEAM-111",
    });

    const issuesDeleteEq = vi.fn().mockResolvedValue({ error: null });

    const { client, fromMock } = makeAdmin(
      {
        issues: () => {
          const chain: Record<string, unknown> = {};
          chain.insert = vi.fn().mockReturnValue(chain);
          chain.select = vi.fn().mockReturnValue(chain);
          chain.single = vi.fn().mockResolvedValue({ data: { id: "anchor-race" }, error: null });
          chain.delete = vi.fn().mockReturnValue({ eq: issuesDeleteEq });
          return chain;
        },
        pipeline_issues: () => {
          const chain: Record<string, unknown> = {};
          chain.select = vi.fn().mockReturnValue(chain);
          chain.eq = vi.fn().mockReturnValue(chain);
          chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
          chain.insert = vi.fn().mockReturnValue(chain);
          // The losing race hits the partial unique index
          chain.single = vi.fn().mockResolvedValue({
            data: null,
            error: { code: "23505", message: "duplicate key value violates unique constraint" },
          });
          return chain;
        },
        slack_installations: slackInstallHandler(),
        workspace_members: () => {
          const chain: Record<string, unknown> = {};
          chain.select = vi.fn().mockReturnValue(chain);
          chain.eq = vi.fn().mockReturnValue(chain);
          chain.maybeSingle = vi.fn().mockResolvedValue({
            data: { id: "wallie-member-id" },
            error: null,
          });
          return chain;
        },
        workspace_secrets: () => {
          const chain: Record<string, unknown> = {};
          chain.select = vi.fn().mockReturnValue(chain);
          chain.eq = vi.fn().mockReturnValue(chain);
          chain.maybeSingle = vi.fn().mockResolvedValue({
            data: { encrypted_value: "enc-linear-key" },
            error: null,
          });
          return chain;
        },
      },
      { data: 7, error: null },
    );

    mocked.createSupabaseAdminClient.mockReturnValue(client);

    const body = JSON.stringify({
      event: {
        channel: "C1",
        text: "<@U> https://linear.app/team/issue/TEAM-111",
        ts: "1.1",
        type: "app_mention",
      },
      team_id: "T1",
    });

    const response = await POST(makeRequest(body));
    const json = await response.json();

    expect(json.ok).toBe(true);
    // The losing race must NOT enqueue a second agent_jobs row
    expect(fromMock).not.toHaveBeenCalledWith("agent_jobs");
    // Orphan compensator runs
    expect(issuesDeleteEq).toHaveBeenCalledWith("id", "anchor-race");
  });

  it("handles unknown Slack team gracefully", async () => {
    const { client } = makeAdmin({
      slack_installations: () => {
        const chain: Record<string, unknown> = {};
        chain.select = vi.fn().mockReturnValue(chain);
        chain.eq = vi.fn().mockReturnValue(chain);
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
        return chain;
      },
    });
    mocked.createSupabaseAdminClient.mockReturnValue(client);

    const body = JSON.stringify({
      event: {
        channel: "C1",
        text: "<@U> https://linear.app/team/issue/TEAM-999",
        ts: "1.1",
        type: "app_mention",
      },
      team_id: "T-UNKNOWN",
    });

    const response = await POST(makeRequest(body));
    const json = await response.json();

    expect(json.ok).toBe(true);
  });
});
