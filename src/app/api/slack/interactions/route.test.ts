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
  handleApproval: vi.fn(),
  handleRejection: vi.fn(),
  processQueuedAgentJobs: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  decryptSecretValue: vi.fn(),
}));

vi.mock("@/lib/pipeline/processor", () => ({
  handleApproval: mocked.handleApproval,
  handleRejection: mocked.handleRejection,
}));

vi.mock("@/lib/wallie/service", () => ({
  processQueuedAgentJobs: mocked.processQueuedAgentJobs,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/secrets/crypto", () => ({
  decryptSecretValue: mocked.decryptSecretValue,
}));

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

function makeInteractionRequest(
  payload: Record<string, unknown>,
  overrides?: { signature?: string; timestamp?: string },
) {
  const payloadStr = JSON.stringify(payload);
  const body = `payload=${encodeURIComponent(payloadStr)}`;
  const ts = overrides?.timestamp ?? nowTimestamp();
  const sig = overrides?.signature ?? makeSignature(body, ts);

  return new Request("http://localhost:3000/api/slack/interactions", {
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": sig,
    },
    method: "POST",
  });
}

// Every non-verification path now resolves teamId -> workspace_id via
// slack_installations before dispatch. This helper installs a from() mock
// that returns a matching install for team "T1".
function installSlackLookup(workspaceId = "ws-1", botTokenEncrypted = "enc") {
  const fromMock = vi.fn().mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue(chain);
    chain.maybeSingle = vi.fn().mockResolvedValue({
      data: { workspace_id: workspaceId, bot_token_encrypted: botTokenEncrypted },
      error: null,
    });
    return chain;
  });
  mocked.createSupabaseAdminClient.mockReturnValue({ from: fromMock });
  return fromMock;
}

describe("POST /api/slack/interactions", () => {
  beforeAll(() => {
    vi.stubEnv("SLACK_SIGNING_SECRET", SIGNING_SECRET);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects requests with invalid signatures", async () => {
    const payload = {
      actions: [{ action_id: "pipeline_approve", value: "{}" }],
      team: { id: "T1" },
    };
    const response = await POST(makeInteractionRequest(payload, { signature: "v0=bad" }));

    expect(response.status).toBe(401);
  });

  it("returns 400 when payload is missing", async () => {
    const ts = nowTimestamp();
    const body = "no_payload_here=true";
    const sig = makeSignature(body, ts);

    const response = await POST(
      new Request("http://localhost:3000/api/slack/interactions", {
        body,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": ts,
          "x-slack-signature": sig,
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 when payload has no team id", async () => {
    const payload = {
      actions: [{ action_id: "pipeline_approve", value: "{}" }],
    };
    const response = await POST(makeInteractionRequest(payload));

    expect(response.status).toBe(400);
  });

  it("returns 403 when the Slack team is unknown", async () => {
    const fromMock = vi.fn().mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      chain.select = vi.fn().mockReturnValue(chain);
      chain.eq = vi.fn().mockReturnValue(chain);
      chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      return chain;
    });
    mocked.createSupabaseAdminClient.mockReturnValue({ from: fromMock });

    const payload = {
      actions: [{ action_id: "pipeline_approve", value: "{}" }],
      team: { id: "T-UNKNOWN" },
    };
    const response = await POST(makeInteractionRequest(payload));

    expect(response.status).toBe(403);
    expect(mocked.handleApproval).not.toHaveBeenCalled();
  });

  it("handles successful approval", async () => {
    installSlackLookup("ws-1");
    mocked.handleApproval.mockResolvedValue({ success: true });

    const payload = {
      actions: [
        {
          action_id: "pipeline_approve",
          value: JSON.stringify({ pipeline_issue_id: "pi-1", version: 2 }),
        },
      ],
      team: { id: "T1" },
    };

    const response = await POST(makeInteractionRequest(payload));
    const json = await response.json();

    expect(mocked.handleApproval).toHaveBeenCalledWith({
      expectedWorkspaceId: "ws-1",
      pipelineIssueId: "pi-1",
      version: 2,
    });
    expect(json.replace_original).toBe(true);
    expect(json.text).toContain("v2 approved");
  });

  it("returns ephemeral error on stale version approval", async () => {
    installSlackLookup();
    mocked.handleApproval.mockResolvedValue({
      error: "Approval failed: spec version is stale or already reviewed.",
      success: false,
    });

    const payload = {
      actions: [
        {
          action_id: "pipeline_approve",
          value: JSON.stringify({ pipeline_issue_id: "pi-1", version: 1 }),
        },
      ],
      team: { id: "T1" },
    };

    const response = await POST(makeInteractionRequest(payload));
    const json = await response.json();

    expect(json.response_type).toBe("ephemeral");
    expect(json.text).toContain("stale");
  });

  it("handles double-click approval idempotently", async () => {
    installSlackLookup();
    mocked.handleApproval.mockResolvedValue({
      error: "Approval failed: spec version is stale or already reviewed.",
      success: false,
    });

    const payload = {
      actions: [
        {
          action_id: "pipeline_approve",
          value: JSON.stringify({ pipeline_issue_id: "pi-1", version: 1 }),
        },
      ],
      team: { id: "T1" },
    };

    const response = await POST(makeInteractionRequest(payload));

    // Should not crash, returns ephemeral message
    expect(response.status).toBe(200);
  });

  it("opens feedback modal on request changes using the signed team's bot token", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => ({ ok: true }) });
    vi.stubGlobal("fetch", mockFetch);

    mocked.decryptSecretValue.mockReturnValue("xoxb-test-token");
    installSlackLookup("ws-1", "enc");

    const payload = {
      actions: [
        {
          action_id: "pipeline_request_changes",
          value: JSON.stringify({ pipeline_issue_id: "pi-1", version: 1 }),
        },
      ],
      team: { id: "T1" },
      trigger_id: "trigger-123",
    };

    const response = await POST(makeInteractionRequest(payload));
    const json = await response.json();

    expect(json.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://slack.com/api/views.open",
      expect.objectContaining({ method: "POST" }),
    );

    // Verify the modal's private_metadata carries the pipeline_issue_id + version
    // so the downstream view_submission handler has what it needs.
    const fetchCall = mockFetch.mock.calls[0]!;
    const requestBody = JSON.parse(fetchCall[1].body as string);
    const metadata = JSON.parse(requestBody.view.private_metadata);
    expect(metadata).toEqual({ pipeline_issue_id: "pi-1", version: 1 });

    vi.unstubAllGlobals();
    vi.stubEnv("SLACK_SIGNING_SECRET", SIGNING_SECRET);
  });

  it("handles view_submission with feedback text", async () => {
    installSlackLookup("ws-1");
    mocked.handleRejection.mockResolvedValue({ escalated: false, success: true });
    mocked.processQueuedAgentJobs.mockResolvedValue({});

    const payload = {
      team: { id: "T1" },
      type: "view_submission",
      view: {
        callback_id: "pipeline_feedback",
        private_metadata: JSON.stringify({ pipeline_issue_id: "pi-1", version: 1 }),
        state: {
          values: {
            feedback_block: {
              feedback_input: {
                value: "Add error handling section",
              },
            },
          },
        },
      },
    };

    const response = await POST(makeInteractionRequest(payload));
    const json = await response.json();

    expect(mocked.handleRejection).toHaveBeenCalledWith({
      expectedWorkspaceId: "ws-1",
      feedbackText: "Add error handling section",
      pipelineIssueId: "pi-1",
      version: 1,
    });
    expect(json.response_action).toBe("clear");
  });

  it("rejects empty feedback text in view_submission", async () => {
    installSlackLookup();
    const payload = {
      team: { id: "T1" },
      type: "view_submission",
      view: {
        callback_id: "pipeline_feedback",
        private_metadata: JSON.stringify({ pipeline_issue_id: "pi-1", version: 1 }),
        state: {
          values: {
            feedback_block: {
              feedback_input: {
                value: "   ",
              },
            },
          },
        },
      },
    };

    const response = await POST(makeInteractionRequest(payload));
    const json = await response.json();

    expect(json.response_action).toBe("errors");
    expect(json.errors.feedback_block).toContain("provide feedback");
  });

  it("does not trigger re-generation when rejection causes escalation", async () => {
    installSlackLookup();
    mocked.handleRejection.mockResolvedValue({ escalated: true, success: true });

    const payload = {
      team: { id: "T1" },
      type: "view_submission",
      view: {
        callback_id: "pipeline_feedback",
        private_metadata: JSON.stringify({ pipeline_issue_id: "pi-1", version: 3 }),
        state: {
          values: {
            feedback_block: {
              feedback_input: { value: "Still wrong" },
            },
          },
        },
      },
    };

    await POST(makeInteractionRequest(payload));

    // processQueuedAgentJobs should NOT be called when escalated
    expect(mocked.processQueuedAgentJobs).not.toHaveBeenCalled();
  });

  it("returns ok for empty actions array", async () => {
    installSlackLookup();
    const payload = { actions: [], team: { id: "T1" } };
    const response = await POST(makeInteractionRequest(payload));
    const json = await response.json();

    expect(json.ok).toBe(true);
  });
});
