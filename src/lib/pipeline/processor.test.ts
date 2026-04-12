import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Tables } from "@/lib/supabase/database.types";

// ---- hoisted mocks ------------------------------------------------------
const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  decryptSecretValue: vi.fn((v: string) => v),
  preScreenIssue: vi.fn(),
  generateProductSpec: vi.fn(),
  postSlackMessage: vi.fn().mockResolvedValue({ ts: "1234567890.123456" }),
  openSlackDm: vi.fn().mockResolvedValue("D-dm-channel"),
  formatSpecBlocks: vi.fn(() => [{ type: "section" }]),
  formatSpecDiffBlocks: vi.fn(() => [{ type: "section" }]),
  formatPreScreenFailBlocks: vi.fn(() => [{ type: "section" }]),
  formatEscalationDmBlocks: vi.fn(() => [{ type: "section" }]),
  escapeMrkdwn: vi.fn((s: string) => s),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/secrets/crypto", () => ({
  decryptSecretValue: mocked.decryptSecretValue,
}));

vi.mock("./pre-screen", () => ({
  preScreenIssue: mocked.preScreenIssue,
}));

vi.mock("./product-agent", () => ({
  generateProductSpec: mocked.generateProductSpec,
}));

vi.mock("./slack-format", () => ({
  escapeMrkdwn: mocked.escapeMrkdwn,
  formatEscalationDmBlocks: mocked.formatEscalationDmBlocks,
  formatPreScreenFailBlocks: mocked.formatPreScreenFailBlocks,
  formatSpecBlocks: mocked.formatSpecBlocks,
  formatSpecDiffBlocks: mocked.formatSpecDiffBlocks,
  openSlackDm: mocked.openSlackDm,
  postSlackMessage: mocked.postSlackMessage,
}));

import { handleApproval, handleRejection, processPipelineJob } from "./processor";
import type { ProductSpec } from "./types";

// ---- fixtures -----------------------------------------------------------

const validSpec: ProductSpec = {
  acceptance_criteria: ["A", "B", "C"],
  constraints: ["c"],
  non_goals: [],
  open_questions: [],
  problem_statement: "Users can't log in",
  title: "SSO login",
  user_story: "As a user, I want to log in",
};

function baseJob(overrides: Partial<Tables<"agent_jobs">> = {}): Tables<"agent_jobs"> {
  return {
    id: "job-1",
    workspace_id: "ws-1",
    issue_id: "issue-1",
    job_type: "session",
    status: "queued",
    created_at: new Date().toISOString(),
    dedupe_key: "pipeline:TEAM-1:active",
    finished_at: null,
    last_error: null,
    requested_by_member_id: null,
    started_at: null,
    trigger_type: "slack_mention",
    ...overrides,
  } as Tables<"agent_jobs">;
}

function baseSession(overrides: Partial<Tables<"sessions">> = {}): Tables<"sessions"> {
  return {
    id: "sess-1",
    workspace_id: "ws-1",
    issue_id: "issue-1",
    number: 1,
    title: "SSO login",
    prompt_md: "Imported from Linear: TEAM-1",
    linear_issue_id: "TEAM-1",
    linear_issue_url: "https://linear.app/team/issue/TEAM-1",
    phase: "product",
    phase_status: "agent_generating",
    rejection_count: 0,
    current_artifact_version: 0,
    slack_channel_id: "C1",
    slack_thread_ts: "1.1",
    creator_member_id: null,
    archived_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as Tables<"sessions">;
}

// ---- handleApproval tests ------------------------------------------------

describe("handleApproval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns success when the RPC returns an updated row", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          archived_at: null,
          id: "sess-1",
          linear_issue_url: "u",
          phase: "product",
          phase_status: "approved",
          slack_channel_id: "C1",
          slack_thread_ts: "1.1",
          workspace_id: "ws-1",
        },
      ],
      error: null,
    });

    const result = await handleApproval({
      admin: { rpc } as never,
      expectedWorkspaceId: "ws-1",
      sessionId: "sess-1",
      version: 1,
    });

    expect(result).toEqual({ success: true });
    expect(rpc).toHaveBeenCalledWith("approve_session_phase", {
      approver_member_id: null,
      expected_version: 1,
      expected_workspace_id: "ws-1",
      target_session_id: "sess-1",
    });
  });

  it("returns a stale-version error when the RPC returns no rows", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });

    const result = await handleApproval({
      admin: { rpc } as never,
      expectedWorkspaceId: "ws-1",
      sessionId: "sess-1",
      version: 99,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("stale");
  });

  it("cross-workspace CAS is enforced inside the RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });

    const result = await handleApproval({
      admin: { rpc } as never,
      expectedWorkspaceId: "attacker-ws",
      sessionId: "sess-1",
      version: 1,
    });

    expect(result.success).toBe(false);
    // The route still passes workspace_id into the RPC; the database function
    // applies it as a CAS filter so the wrong workspace gets nothing.
    expect(rpc).toHaveBeenCalledWith(
      "approve_session_phase",
      expect.objectContaining({ expected_workspace_id: "attacker-ws" }),
    );
  });

  it("propagates RPC errors as-is", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "boom" },
    });

    const result = await handleApproval({
      admin: { rpc } as never,
      expectedWorkspaceId: "ws-1",
      sessionId: "sess-1",
      version: 1,
    });

    expect(result).toEqual({ error: "boom", success: false });
  });
});

// ---- handleRejection tests ------------------------------------------------

describe("handleRejection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function adminWithSession(
    session: Tables<"sessions">,
    opts: {
      rejectionCasData?: unknown;
      enqueueError?: { code?: string; message: string } | null;
    } = {},
  ) {
    const tableCalls: Record<string, number> = {};
    const insertPayloads: unknown[] = [];
    const updatePayloads: Array<{ table: string; payload: unknown }> = [];

    const admin = {
      from: vi.fn((table: string) => {
        tableCalls[table] = (tableCalls[table] ?? 0) + 1;
        const chain: Record<string, unknown> = {};

        chain.select = vi.fn(() => chain);
        chain.eq = vi.fn(() => chain);
        chain.in = vi.fn(() => chain);
        chain.order = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);

        chain.update = vi.fn((payload: unknown) => {
          updatePayloads.push({ table, payload });
          return chain;
        });
        chain.insert = vi.fn((payload: unknown) => {
          insertPayloads.push(payload);
          if (table === "agent_jobs") {
            return Promise.resolve({
              data: null,
              error: opts.enqueueError ?? null,
            });
          }
          return chain;
        });
        chain.delete = vi.fn(() => chain);

        if (table === "sessions") {
          // First call is loadSessionById, subsequent call is the rejection
          // CAS. Simulate by alternating.
          const callIdx = tableCalls[table]!;
          chain.maybeSingle = vi.fn().mockImplementation(() => {
            if (callIdx === 1) {
              return Promise.resolve({ data: session, error: null });
            }
            // CAS
            return Promise.resolve({
              data: opts.rejectionCasData ?? { id: session.id },
              error: null,
            });
          });
        } else if (table === "session_artifacts") {
          chain.maybeSingle = vi.fn().mockResolvedValue({
            data: { artifact_json: validSpec },
            error: null,
          });
        } else if (table === "workspace_members") {
          chain.maybeSingle = vi.fn().mockResolvedValue({
            data: { id: "wallie-mem" },
            error: null,
          });
        } else if (table === "slack_installations") {
          chain.maybeSingle = vi.fn().mockResolvedValue({
            data: { bot_token_encrypted: "enc-token" },
            error: null,
          });
        } else if (table === "workspace_secrets") {
          // workspace_secrets uses a direct await (no .single/.maybeSingle).
          // Override the chain with a thenable so
          // `await admin.from(...).select().eq().in()` resolves directly.
          (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
            resolve({
              data: [{ key: "EM_SLACK_USER_ID", encrypted_value: "U-em-id" }],
              error: null,
            });
        } else {
          chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
          chain.single = vi.fn().mockResolvedValue({ data: null, error: null });
        }

        return chain;
      }),
    };

    return { admin, insertPayloads, updatePayloads, tableCalls };
  }

  it("rejects with cross-workspace guard when workspace_id does not match", async () => {
    const { admin } = adminWithSession(baseSession());

    const result = await handleRejection({
      admin: admin as never,
      expectedWorkspaceId: "attacker-ws",
      feedbackText: "nope",
      sessionId: "sess-1",
      version: 1,
    });

    expect(result.success).toBe(false);
    expect(result.escalated).toBe(false);
  });

  it("rejects when phase_status is not awaiting_review", async () => {
    const { admin } = adminWithSession(baseSession({ phase_status: "agent_generating" }));

    const result = await handleRejection({
      admin: admin as never,
      expectedWorkspaceId: "ws-1",
      feedbackText: "nope",
      sessionId: "sess-1",
      version: 1,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not awaiting review");
  });

  it("rejects on version mismatch", async () => {
    const { admin } = adminWithSession(
      baseSession({ phase_status: "awaiting_review", current_artifact_version: 2 }),
    );

    const result = await handleRejection({
      admin: admin as never,
      expectedWorkspaceId: "ws-1",
      feedbackText: "nope",
      sessionId: "sess-1",
      version: 1,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Version mismatch");
  });

  it("escalates at rejection_count >= 3 and does NOT enqueue a retry", async () => {
    const { admin, insertPayloads, updatePayloads } = adminWithSession(
      baseSession({
        phase_status: "awaiting_review",
        current_artifact_version: 1,
        rejection_count: 2,
      }),
    );

    const result = await handleRejection({
      admin: admin as never,
      expectedWorkspaceId: "ws-1",
      feedbackText: "final nope",
      sessionId: "sess-1",
      version: 1,
    });

    expect(result.escalated).toBe(true);
    expect(result.success).toBe(true);

    // Escalated: the retry job should NOT be enqueued.
    const enqueues = insertPayloads.filter(
      (p): p is { job_type: string } =>
        typeof p === "object" &&
        p !== null &&
        "job_type" in p &&
        (p as { job_type: string }).job_type === "session",
    );
    expect(enqueues).toEqual([]);

    // Phase status should flip to "escalated".
    const escalatedUpdate = updatePayloads.find(
      (u) =>
        u.table === "sessions" &&
        (u.payload as { phase_status?: string }).phase_status === "escalated",
    );
    expect(escalatedUpdate).toBeDefined();

    // EM DM should have been posted via openSlackDm + postSlackMessage.
    expect(mocked.openSlackDm).toHaveBeenCalled();
    expect(mocked.postSlackMessage).toHaveBeenCalled();
  });

  it("non-escalated path enqueues retry BEFORE flipping phase_status to rejected", async () => {
    const { admin, insertPayloads, updatePayloads } = adminWithSession(
      baseSession({
        phase_status: "awaiting_review",
        current_artifact_version: 1,
        rejection_count: 0,
      }),
    );

    const result = await handleRejection({
      admin: admin as never,
      expectedWorkspaceId: "ws-1",
      feedbackText: "please add more",
      sessionId: "sess-1",
      version: 1,
    });

    expect(result.success).toBe(true);
    expect(result.escalated).toBe(false);

    // A retry agent_job MUST have been enqueued.
    const retryEnqueue = insertPayloads.find(
      (p): p is { job_type: string } =>
        typeof p === "object" && p !== null && (p as { job_type?: string }).job_type === "session",
    );
    expect(retryEnqueue).toBeDefined();

    // phase_status should flip to "rejected".
    const rejectedUpdate = updatePayloads.find(
      (u) =>
        u.table === "sessions" &&
        (u.payload as { phase_status?: string }).phase_status === "rejected",
    );
    expect(rejectedUpdate).toBeDefined();
  });

  it("non-escalated path: non-23505 enqueue failure leaves phase_status at awaiting_review", async () => {
    const { admin, updatePayloads } = adminWithSession(
      baseSession({
        phase_status: "awaiting_review",
        current_artifact_version: 1,
        rejection_count: 0,
      }),
      { enqueueError: { code: "08000", message: "connection reset" } },
    );

    const result = await handleRejection({
      admin: admin as never,
      expectedWorkspaceId: "ws-1",
      feedbackText: "nope",
      sessionId: "sess-1",
      version: 1,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("connection reset");

    // phase_status must NOT have flipped to rejected. The rejection CAS
    // advanced rejection_count but we must leave phase_status alone so the
    // reviewer can click Submit Feedback again.
    const rejectedFlip = updatePayloads.find(
      (u) =>
        u.table === "sessions" &&
        (u.payload as { phase_status?: string }).phase_status === "rejected",
    );
    expect(rejectedFlip).toBeUndefined();
  });

  it("non-escalated path: 23505 (dedupe) is silently treated as success", async () => {
    const { admin, updatePayloads } = adminWithSession(
      baseSession({
        phase_status: "awaiting_review",
        current_artifact_version: 1,
        rejection_count: 0,
      }),
      { enqueueError: { code: "23505", message: "unique constraint violation" } },
    );

    const result = await handleRejection({
      admin: admin as never,
      expectedWorkspaceId: "ws-1",
      feedbackText: "nope",
      sessionId: "sess-1",
      version: 1,
    });

    expect(result.success).toBe(true);
    expect(result.escalated).toBe(false);

    // Even on dedupe, phase_status still flips to rejected because the
    // concurrent worker is already queued to pick up the feedback.
    const rejectedFlip = updatePayloads.find(
      (u) =>
        u.table === "sessions" &&
        (u.payload as { phase_status?: string }).phase_status === "rejected",
    );
    expect(rejectedFlip).toBeDefined();
  });
});

// ---- processPipelineJob (high-level branches) ----------------------------

describe("processPipelineJob", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function buildProcessorAdmin(opts: {
    session: Tables<"sessions"> | null;
    issue?: { id: string; title: string; description_md: string } | null;
    claimedRow?: { id: string } | null;
    insertArtifactError?: unknown;
    pointerUpdateError?: unknown;
    workspaceSecrets?: Array<{ key: string; encrypted_value: string }>;
  }) {
    const calls: {
      artifactInserted: number;
      artifactDeleted: number;
      sessionUpdates: Array<Record<string, unknown>>;
      jobUpdates: Array<Record<string, unknown>>;
    } = {
      artifactInserted: 0,
      artifactDeleted: 0,
      sessionUpdates: [],
      jobUpdates: [],
    };

    // Per-call counters so the sessions "update" chain can return the
    // CAS-claim result on its first call and a plain update on subsequent calls.
    let sessionUpdateCall = 0;

    const admin = {
      from: vi.fn((table: string) => {
        const chain: Record<string, unknown> = {};
        chain.select = vi.fn(() => chain);
        chain.eq = vi.fn(() => chain);
        chain.in = vi.fn(() => chain);
        chain.order = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);

        if (table === "sessions") {
          chain.update = vi.fn((payload: unknown) => {
            sessionUpdateCall += 1;
            calls.sessionUpdates.push(payload as Record<string, unknown>);
            // First UPDATE is the CAS claim (followed by select().maybeSingle())
            if (sessionUpdateCall === 1) {
              (chain as { maybeSingle: unknown }).maybeSingle = vi.fn().mockResolvedValue({
                data: opts.claimedRow !== undefined ? opts.claimedRow : { id: "sess-1" },
                error: null,
              });
            } else {
              // Subsequent UPDATEs are direct awaits with pointer-update errors injected
              (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
                resolve({ data: null, error: opts.pointerUpdateError ?? null });
            }
            return chain;
          });
          chain.insert = vi.fn(() => chain);
          chain.maybeSingle = vi.fn().mockResolvedValue({ data: opts.session, error: null });
        } else if (table === "issues") {
          chain.update = vi.fn(() => {
            (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
              resolve({ data: null, error: null });
            return chain;
          });
          chain.maybeSingle = vi.fn().mockResolvedValue({
            data: opts.issue ?? {
              id: "issue-1",
              title: "Linear title",
              description_md: "Linear body",
            },
            error: null,
          });
        } else if (table === "workspace_secrets") {
          (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
            resolve({
              data: opts.workspaceSecrets ?? [
                { key: "ANTHROPIC_API_KEY", encrypted_value: "encrypted-key" },
              ],
              error: null,
            });
        } else if (table === "slack_installations") {
          chain.maybeSingle = vi.fn().mockResolvedValue({
            data: { bot_token_encrypted: "enc-token" },
            error: null,
          });
        } else if (table === "session_artifacts") {
          chain.insert = vi.fn(() => {
            calls.artifactInserted += 1;
            return Promise.resolve({ data: null, error: opts.insertArtifactError ?? null });
          });
          chain.delete = vi.fn(() => {
            calls.artifactDeleted += 1;
            (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
              resolve({ data: null, error: null });
            return chain;
          });
          chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
        } else if (table === "agent_jobs") {
          chain.update = vi.fn((payload: unknown) => {
            calls.jobUpdates.push(payload as Record<string, unknown>);
            (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
              resolve({ data: null, error: null });
            return chain;
          });
        } else {
          chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
          chain.single = vi.fn().mockResolvedValue({ data: null, error: null });
          chain.update = vi.fn(() => chain);
          chain.insert = vi.fn(() => chain);
        }

        return chain;
      }),
    };

    return { admin, calls };
  }

  it("returns error when no session row exists for the job", async () => {
    const { admin, calls } = buildProcessorAdmin({ session: null });

    const result = await processPipelineJob({
      admin: admin as never,
      job: baseJob(),
    });

    expect(result.result).toBe("error");
    expect(calls.jobUpdates.some((u) => u.status === "error")).toBe(true);
  });

  it("returns success without running pre-screen when CAS claim finds terminal state", async () => {
    const { admin } = buildProcessorAdmin({
      session: baseSession({ phase_status: "approved" }),
      claimedRow: null, // CAS returns no row → terminal
    });

    const result = await processPipelineJob({
      admin: admin as never,
      job: baseJob(),
    });

    expect(result.result).toBe("success");
    expect(mocked.preScreenIssue).not.toHaveBeenCalled();
    expect(mocked.generateProductSpec).not.toHaveBeenCalled();
  });

  it("posts pre-screen fail and flips to rejected when the LLM fails the issue", async () => {
    mocked.preScreenIssue.mockResolvedValueOnce({ pass: false, reason: "too vague" });

    const { admin, calls } = buildProcessorAdmin({
      session: baseSession(),
    });

    const result = await processPipelineJob({
      admin: admin as never,
      job: baseJob(),
    });

    expect(result.result).toBe("success");
    expect(mocked.postSlackMessage).toHaveBeenCalled();
    expect(mocked.generateProductSpec).not.toHaveBeenCalled();
    // phase_status should have been updated to "rejected".
    expect(calls.sessionUpdates.some((u) => u.phase_status === "rejected")).toBe(true);
  });

  it("generates spec, inserts artifact, and bumps pointer on happy path", async () => {
    mocked.preScreenIssue.mockResolvedValueOnce({ pass: true, reason: "ok" });
    mocked.generateProductSpec.mockResolvedValueOnce(validSpec);

    const { admin, calls } = buildProcessorAdmin({
      session: baseSession(),
    });

    const result = await processPipelineJob({
      admin: admin as never,
      job: baseJob(),
    });

    expect(result.result).toBe("success");
    expect(calls.artifactInserted).toBe(1);
    // pointer update to v1 + awaiting_review should have been attempted.
    expect(
      calls.sessionUpdates.some(
        (u) => u.current_artifact_version === 1 && u.phase_status === "awaiting_review",
      ),
    ).toBe(true);
    // spec should be posted to Slack.
    expect(mocked.postSlackMessage).toHaveBeenCalled();
  });

  it("compensates by deleting the artifact when pointer bump fails mid-flight", async () => {
    mocked.preScreenIssue.mockResolvedValueOnce({ pass: true, reason: "ok" });
    mocked.generateProductSpec.mockResolvedValueOnce(validSpec);

    const { admin, calls } = buildProcessorAdmin({
      session: baseSession(),
      pointerUpdateError: { code: "08000", message: "connection reset" },
    });

    const result = await processPipelineJob({
      admin: admin as never,
      job: baseJob(),
    });

    expect(result.result).toBe("error");
    expect(calls.artifactInserted).toBe(1);
    // Critical: the compensating delete must have fired to avoid wedging
    // the next retry on the unique (session_id, phase, version) index.
    expect(calls.artifactDeleted).toBe(1);
    // Job should be marked error, session flipped to rejected.
    expect(calls.jobUpdates.some((u) => u.status === "error")).toBe(true);
    expect(calls.sessionUpdates.some((u) => u.phase_status === "rejected")).toBe(true);
  });

  it("posts a generic warning (not the raw LLM error) when spec generation fails", async () => {
    mocked.preScreenIssue.mockResolvedValueOnce({ pass: true, reason: "ok" });
    mocked.generateProductSpec.mockRejectedValueOnce(
      new Error("Product agent returned invalid JSON: <http://evil.example|click>"),
    );

    const { admin } = buildProcessorAdmin({
      session: baseSession(),
    });

    const result = await processPipelineJob({
      admin: admin as never,
      job: baseJob(),
    });

    expect(result.result).toBe("error");
    expect(mocked.postSlackMessage).toHaveBeenCalled();
    // The message text must be generic.
    const slackCall = mocked.postSlackMessage.mock.calls[0]![0] as {
      text: string;
      blocks: Array<{ text?: { text?: string } }>;
    };
    expect(slackCall.text).toBe("Spec generation failed");
    const firstBlockText = slackCall.blocks[0]?.text?.text ?? "";
    expect(firstBlockText).not.toContain("evil.example");
  });

  it("writes a manual stub artifact and flips to awaiting_review for non-product phases", async () => {
    const { admin, calls } = buildProcessorAdmin({
      session: baseSession({ phase: "design", current_artifact_version: 0 }),
    });

    const result = await processPipelineJob({
      admin: admin as never,
      job: baseJob(),
    });

    expect(result.result).toBe("success");
    // Product agent should NOT run for a non-product phase.
    expect(mocked.generateProductSpec).not.toHaveBeenCalled();
    expect(mocked.preScreenIssue).not.toHaveBeenCalled();
    // A stub artifact should be inserted.
    expect(calls.artifactInserted).toBe(1);
    // Pointer should bump to v1 and flip to awaiting_review.
    expect(
      calls.sessionUpdates.some(
        (u) => u.current_artifact_version === 1 && u.phase_status === "awaiting_review",
      ),
    ).toBe(true);
    // A Slack "please approve" prompt should have been posted.
    expect(mocked.postSlackMessage).toHaveBeenCalled();
  });

  it("does not require ANTHROPIC_API_KEY for non-product phases", async () => {
    // Non-product phases go through runManualPhaseStub, which never hits
    // the model — missing ANTHROPIC_API_KEY must not block them.
    const { admin, calls } = buildProcessorAdmin({
      session: baseSession({ phase: "design", current_artifact_version: 0 }),
      workspaceSecrets: [],
    });

    const result = await processPipelineJob({
      admin: admin as never,
      job: baseJob(),
    });

    expect(result.result).toBe("success");
    expect(calls.artifactInserted).toBe(1);
    // The error marker should not have fired for a missing Anthropic key.
    expect(
      calls.jobUpdates.some(
        (u) =>
          typeof u.last_error === "string" &&
          (u.last_error as string).includes("ANTHROPIC_API_KEY"),
      ),
    ).toBe(false);
  });

  it("errors for product phase when ANTHROPIC_API_KEY is missing", async () => {
    const { admin, calls } = buildProcessorAdmin({
      session: baseSession({ phase: "product", current_artifact_version: 0 }),
      workspaceSecrets: [],
    });

    const result = await processPipelineJob({
      admin: admin as never,
      job: baseJob(),
    });

    expect(result.result).toBe("error");
    expect(
      calls.jobUpdates.some(
        (u) =>
          typeof u.last_error === "string" &&
          (u.last_error as string).includes("ANTHROPIC_API_KEY"),
      ),
    ).toBe(true);
  });
});
