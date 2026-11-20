import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

const mocks = vi.hoisted(() => ({ access: vi.fn(), admin: vi.fn() }));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: mocks.access }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));

import { GET } from "./route";

const workspaceId = "606a0000-0000-4000-8000-000000000001";
const factoryId = "606a0000-0000-4000-8000-000000000002";
const evaluationId = "606a0000-0000-4000-8000-000000000003";
const actorId = "606a0000-0000-4000-8000-000000000004";
const earlierAttemptId = "606a0000-0000-4000-8000-000000000005";
const latestAttemptId = "606a0000-0000-4000-8000-000000000006";
const evidenceId = "606a0000-0000-4000-8000-000000000007";
const scorerRevisionId = "606a0000-0000-4000-8000-000000000008";
const judgeRevisionId = "606a0000-0000-4000-8000-000000000009";
const finishTime = "2026-11-20T01:02:03.123456+00:00";
const path = `http://wallie.test/api/workspaces/${workspaceId}/factories/${factoryId}/evaluations/${evaluationId}`;
const target = { workspaceId, factoryId, evaluationId };
const success = {
  attempt_id: latestAttemptId,
  workspace_id: workspaceId,
  factory_id: factoryId,
  job_id: evaluationId,
  session_id: "606a0000-0000-4000-8000-000000000010",
  run_id: "606a0000-0000-4000-8000-000000000011",
  scorer_revision_id: scorerRevisionId,
  sample_receipt_id: "606a0000-0000-4000-8000-000000000012",
  target_commit_sha: "c".repeat(40),
  attempt_number: 2,
  attempt_outcome: "succeeded",
  profile_revision_id: judgeRevisionId,
  provider_model: "provider/model",
  provider_name: "Provider",
  provider_request_id: "provider-request",
  adapter_runtime: "openrouter-chat-v1",
  worker_runtime: "workerd",
  evidence_digest: "b".repeat(64),
  status: "pass",
  reason: null,
  score: { kind: "boolean", value: true },
  result: {
    schemaVersion: 1,
    status: "pass",
    score: { kind: "boolean", value: true },
    evidence: [{ kind: "artifact", id: evidenceId }],
  },
  explanation: "The retained artifact meets the rubric.",
  evidence_locations: [
    {
      reference: { kind: "artifact", id: evidenceId },
      location: { kind: "lines", startLine: 1, endLine: 2 },
    },
  ],
  claimed_at: "2026-11-20T01:01:03.123456+00:00",
  started_at: "2026-11-20T01:01:10.123456+00:00",
  finished_at: finishTime,
  latency_ms: 60_000,
  input_tokens: 400,
  output_tokens: 20,
  token_provenance: "measured",
  cost_usd: 0,
  cost_provenance: "measured",
  estimation_revision: null,
  evidence_availability: "available",
};

const withheld = {
  evidence_availability: "withheld",
  evidence_digest: null,
  evidence_locations: null,
  explanation: null,
  result: null,
};

const expired = {
  ...success,
  ...withheld,
  attempt_id: earlierAttemptId,
  attempt_number: 1,
  attempt_outcome: "lease_expired",
  evidence_availability: "unavailable",
  provider_request_id: null,
  score: null,
  status: "error",
  reason: "lease_expired",
  claimed_at: "2026-11-20T00:00:00+00:00",
  started_at: "2026-11-20T00:00:07+00:00",
  finished_at: "2026-11-20T00:01:30+00:00",
  latency_ms: 90_000,
  input_tokens: null,
  output_tokens: null,
  token_provenance: "unavailable",
  cost_usd: null,
  cost_provenance: "unavailable",
};

const oneAttemptUsage = {
  attempt_count: 1,
  input_tokens: 400,
  output_tokens: 20,
  token_unavailable_count: 0,
  token_estimated_count: 0,
  cost_usd: 0,
  cost_unavailable_count: 0,
  cost_estimated_count: 0,
};

function page(receipts: unknown[], usage: unknown = oneAttemptUsage) {
  return Response.json({ receipts, usage, next_finished_at: null, next_attempt_id: null });
}

function fixture({ visible = true, response }: { visible?: boolean; response?: Response } = {}) {
  const readFactory = vi.fn<typeof fetch>(async () =>
    Response.json(visible ? { id: factoryId } : null),
  );
  const readReceipts = vi.fn<typeof fetch>(async () => response ?? page([success]));
  const client = createClient<Database>("http://supabase.test", "reader", {
    auth: { persistSession: false },
    global: { fetch: readFactory },
  });
  const admin = createClient<Database>("http://supabase.test", "service-fixture", {
    auth: { persistSession: false },
    global: { fetch: readReceipts },
  });
  mocks.access.mockResolvedValue({
    ok: true,
    context: { workspace: { id: workspaceId }, user: { id: actorId }, supabase: client },
  });
  mocks.admin.mockReturnValue(admin);
  return { readFactory, readReceipts };
}

function read(params = target) {
  return GET(new Request(path), { params: Promise.resolve(params) });
}

describe("evaluation receipt API", () => {
  beforeEach(() => vi.resetAllMocks());

  it("loads the bounded history for the authorized job, preserving immutable IDs and unknown totals", async () => {
    const { readFactory, readReceipts } = fixture({
      response: page([{ ...success, lease_id: "private-field" }, expired], {
        ...oneAttemptUsage,
        attempt_count: 2,
        input_tokens: null,
        output_tokens: null,
        token_unavailable_count: 1,
        cost_usd: null,
        cost_unavailable_count: 1,
      }),
    });
    const response = await read({ ...target, evaluationId: evaluationId.toUpperCase() });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(String(readFactory.mock.calls[0]?.[0])).toContain(
      `/rest/v1/factories?select=id&workspace_id=eq.${workspaceId}&id=eq.${factoryId}`,
    );
    const [input, init] = readReceipts.mock.calls[0] ?? [];
    expect(String(input)).toMatch(/\/rest\/v1\/rpc\/list_factory_evaluation_receipts$/);
    expect(JSON.parse(String(init?.body))).toEqual({
      p_workspace_id: workspaceId,
      p_factory_id: factoryId,
      p_job_id: evaluationId,
      p_actor_user_id: actorId,
      p_limit: 6,
    });
    const body = await response.json();
    expect(body.evaluation).toMatchObject({
      id: evaluationId,
      receipts: [
        {
          attemptId: latestAttemptId,
          scorerRevisionId,
          profileRevisionId: judgeRevisionId,
          targetCommitSha: "c".repeat(40),
          evidenceAvailability: "available",
          evidenceLocations: success.evidence_locations,
          score: success.score,
          explanation: success.explanation,
          result: success.result,
          finishedAt: finishTime,
          usage: { costProvenance: "measured", costUsd: 0 },
        },
        {
          attemptId: earlierAttemptId,
          attemptOutcome: "lease_expired",
          reason: "lease_expired",
          usage: { costProvenance: "unavailable", costUsd: null },
        },
      ],
      usage: { attemptCount: 2, inputTokens: null, costUsd: null, costUnavailableCount: 1 },
    });
    expect(JSON.stringify(body)).not.toContain("private-field");
  });

  it("shows withheld provenance with only the retained score and usage", async () => {
    fixture({ response: page([{ ...success, ...withheld }]) });
    const response = await read();
    expect(response.status).toBe(200);
    expect((await response.json()).evaluation.receipts[0]).toMatchObject({
      score: success.score,
      evidenceAvailability: "withheld",
      evidenceDigest: null,
      evidenceLocations: null,
      result: null,
      explanation: null,
    });
  });

  it("keeps estimated token usage while both cost values are unavailable", async () => {
    fixture({
      response: page(
        [
          {
            ...success,
            token_provenance: "estimated",
            estimation_revision: "judge-usage-v1",
            cost_usd: null,
            cost_provenance: "unavailable",
          },
        ],
        { ...oneAttemptUsage, token_estimated_count: 1, cost_usd: null, cost_unavailable_count: 1 },
      ),
    });
    const response = await read();
    expect(response.status).toBe(200);
    expect((await response.json()).evaluation).toMatchObject({
      receipts: [
        {
          usage: {
            inputTokens: 400,
            outputTokens: 20,
            tokenProvenance: "estimated",
            estimationRevision: "judge-usage-v1",
            costUsd: null,
            costProvenance: "unavailable",
          },
        },
      ],
      usage: { inputTokens: 400, outputTokens: 20, tokenEstimatedCount: 1, costUsd: null },
    });
  });

  it("returns no records to an unauthenticated request or an inaccessible factory", async () => {
    mocks.access.mockResolvedValue({ ok: false, error: "Sign in.", status: 401 });
    expect((await read()).status).toBe(401);
    fixture({ visible: false });
    expect((await read()).status).toBe(404);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("does not authenticate or query an invalid evaluation ID", async () => {
    expect((await read({ ...target, evaluationId: "invalid" })).status).toBe(400);
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it.each(["42501", "P0002"])("masks the SQL denial %s as unavailable", async (code) => {
    fixture({
      response: Response.json({ code, message: "Private run information" }, { status: 400 }),
    });
    const response = await read();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Evaluation not found." });
  });

  it("returns an opaque 404 when the job has no visible terminal attempt", async () => {
    fixture({ response: page([], null) });
    const response = await read();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Evaluation not found." });
  });

  it.each([
    [{ ...success, job_id: actorId }, oneAttemptUsage],
    [{ ...success, evidence_availability: "withheld" }, oneAttemptUsage],
    [success, { ...oneAttemptUsage, cost_unavailable_count: 1 }],
  ])(
    "fails closed on wrong scope, unredacted receipts, or unknown costs represented as zero",
    async (receipt, usage) => {
      fixture({ response: page([receipt], usage) });
      const response = await read();
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Could not load the evaluation." });
    },
  );
});
