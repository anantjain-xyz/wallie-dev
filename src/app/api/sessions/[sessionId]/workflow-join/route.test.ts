import { beforeEach, expect, it, vi } from "vitest";

import { GET, POST } from "./route";

const { admin, authorizedConflict, rateLimit, rpc, session, user, userClient } = vi.hoisted(() => {
  const rpc = vi.fn();
  const admin = vi.fn(() => ({ rpc, storage: {} }));
  const session = vi.fn();
  return {
    admin,
    authorizedConflict: vi.fn(),
    rateLimit: vi.fn(),
    rpc,
    session,
    user: vi.fn(),
    userClient: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: session }) }) }) },
  };
});

vi.mock("@/lib/factory-workflows/join-authorized-conflict", () => ({
  readAuthorizedJoinConflict: authorizedConflict,
}));
vi.mock("@/lib/rate-limit", () => ({ enforceRateLimit: rateLimit }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: admin }));
vi.mock("@/lib/supabase/auth", () => ({ getSupabaseUserOrNull: user }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: () => userClient }));

const id = (slot: number) => `6520abcd-0000-4000-8000-${String(slot).padStart(12, "0")}`;
const scope = { id: id(1), workspace_id: id(2), factory_id: id(3) };
const actor = id(4);
const params = { params: Promise.resolve({ sessionId: scope.id }) };
const endpoint = `https://wallie.test/api/sessions/${scope.id}/workflow-join`;
const intent = {
  requestId: id(5),
  expectedGeneration: 3,
  branchGroupId: id(6),
  expectedHeadRunId: id(7),
  selectedOutcomeIds: [id(8), id(9)],
};
const receipt = {
  joinId: id(10),
  occurrenceId: id(11),
  jobId: id(12),
  runId: id(13),
  created: true,
};
const conflictUrl = `${endpoint}?joinId=${receipt.joinId}&runId=${id(13)}`;

function post(body: object = intent) {
  return new Request(endpoint, { method: "POST", body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  user.mockResolvedValue({ id: actor });
  session.mockResolvedValue({ data: scope, error: null });
  rateLimit.mockResolvedValue({});
  rpc.mockReturnValue({
    abortSignal: async () => ({ data: { ...receipt, ownershipToken: "private" }, error: null }),
  });
  authorizedConflict.mockResolvedValue(null);
});

it("enqueues the exact named outputs through the authenticated manager command", async () => {
  const response = await POST(post(), params);
  expect(response.status).toBe(202);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual(receipt);
  expect(rateLimit).toHaveBeenCalledWith("phaseAction", `${scope.workspace_id}:${actor}`);
  expect(rpc).toHaveBeenCalledExactlyOnceWith("enqueue_factory_workflow_join_for_user", {
    p_root_session_id: scope.id,
    p_workspace_id: scope.workspace_id,
    p_factory_id: scope.factory_id,
    p_actor_user_id: actor,
    p_expected_generation: intent.expectedGeneration,
    p_request_id: intent.requestId,
    p_branch_group_id: intent.branchGroupId,
    p_expected_head_run_id: intent.expectedHeadRunId,
    p_selected_outcome_ids: intent.selectedOutcomeIds,
  });
});

it("returns the exact prior join on request replay", async () => {
  const replay = { ...receipt, created: false };
  rpc.mockReturnValue({ abortSignal: async () => ({ data: replay, error: null }) });
  const response = await POST(post(), params);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(replay);
});

it.each([
  { ...intent, actorUserId: id(99) },
  { ...intent, selectedOutcomeIds: [id(8), id(8)] },
  { ...intent, selectedOutcomeIds: [] },
])(
  "rejects malformed or caller-scoped join intent before using service authority",
  async (body) => {
    expect((await POST(post(body), params)).status).toBe(400);
    expect(admin).not.toHaveBeenCalled();
  },
);

it.each([
  ["42501", 403],
  ["PT404", 404],
  ["PT409", 409],
  ["PT422", 422],
])("maps a native %s denial without returning its details", async (code, status) => {
  rpc.mockReturnValue({
    abortSignal: async () => ({ data: null, error: { code, message: "Private details" } }),
  });
  const response = await POST(post(), params);
  expect(response.status).toBe(status);
  expect(await response.text()).not.toContain("Private details");
});

it.each(["canonical", "uppercase"] as const)(
  "lists exact join inputs for the %s branch group ID without exposing the private workflow projection",
  async (spelling) => {
    rpc.mockImplementation((name: string) => ({
      abortSignal: async () => ({
        data:
          name === "read_factory_workflow_execution"
            ? { execution: { generation: intent.expectedGeneration, ownership_token: "private" } }
            : {
                manifest: {
                  group_id: intent.branchGroupId,
                  source_checkpoint_run_id: intent.expectedHeadRunId,
                },
                joinStatus: "optional_failure",
                slots: [
                  {
                    slot: { branch_edge_id: "run.required", required: true },
                    admissionBlocker: null,
                    outcome: {
                      outcome_id: id(8),
                      outcome: "succeeded",
                      checkpoint_run_id: id(14),
                      retained_ref: "private",
                    },
                  },
                  {
                    slot: { branch_edge_id: "run.optional", required: false },
                    admissionBlocker: "workflow_child_limit",
                    outcome: null,
                  },
                ],
              },
        error: null,
      }),
    }));
    const response = await GET(
      new Request(
        `${endpoint}?branchGroupId=${
          spelling === "uppercase" ? intent.branchGroupId.toUpperCase() : intent.branchGroupId
        }`,
      ),
      params,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      branchGroupId: intent.branchGroupId,
      expectedGeneration: intent.expectedGeneration,
      expectedHeadRunId: intent.expectedHeadRunId,
      joinStatus: "optional_failure",
      maxValidationPackBytes: 48 * 1024 * 1024,
      slots: [
        {
          branchEdgeId: "run.required",
          required: true,
          status: "succeeded",
          outcomeId: id(8),
          checkpointRunId: id(14),
          admissionBlocker: null,
        },
        {
          branchEdgeId: "run.optional",
          required: false,
          status: "blocked",
          outcomeId: null,
          checkpointRunId: null,
          admissionBlocker: "workflow_child_limit",
        },
      ],
    });
    expect(rpc).toHaveBeenCalledWith("read_factory_workflow_branch_group", {
      p_root_session_id: scope.id,
      p_workspace_id: scope.workspace_id,
      p_factory_id: scope.factory_id,
      p_group_id: intent.branchGroupId,
    });
  },
);

it("uses the signed-in client and exact visible scope to read a private conflict", async () => {
  const report = { paths: ["src/app.ts"], reportSha256: "a".repeat(64) };
  authorizedConflict.mockResolvedValue(report);
  const response = await GET(new Request(conflictUrl), params);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual(report);
  expect(authorizedConflict).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      user: userClient,
      storage: expect.objectContaining({ storage: {} }),
      signal: expect.any(AbortSignal),
      scope: {
        workspaceId: scope.workspace_id,
        rootSessionId: scope.id,
        joinId: receipt.joinId,
        runId: id(13),
      },
    }),
  );
});

it("conceals a conflict whose signed-in reader has no matching receipt", async () => {
  const response = await GET(new Request(conflictUrl), params);
  expect(response.status).toBe(404);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
});

it("rejects invisible roots and unsigned-in users before opening the conflict reader", async () => {
  session.mockResolvedValueOnce({ data: null, error: null });
  expect((await GET(new Request(conflictUrl), params)).status).toBe(404);
  user.mockResolvedValueOnce(null);
  expect((await POST(post(), params)).status).toBe(401);
  expect(authorizedConflict).not.toHaveBeenCalled();
  expect(admin).not.toHaveBeenCalled();
});

it("returns visible partial delivery without disclosing a repository lease or bundle", async () => {
  const delivery = {
    status: "partial",
    primaryRepositoryId: id(15),
    primaryOutcome: "adopted",
    lifecycleStatus: "running",
    repositories: [
      {
        repositoryId: id(16),
        repositoryName: "fixture/component",
        status: "pending",
        blocker: "publication_unavailable",
        attempts: 1,
        baseSha: "a".repeat(40),
        outputSha: "b".repeat(40),
        validationTreeSha: "c".repeat(40),
        validationRunId: id(17),
        expectedHeadReceiptId: id(18),
        acceptedHeadReceiptId: null,
        remoteReconciliationRequired: true,
      },
    ],
  };
  rpc.mockReturnValue({
    abortSignal: async () => ({
      data: {
        ...delivery,
        ownershipToken: "private",
        repositories: [{ ...delivery.repositories[0], lease: "private", bundleBytes: "private" }],
      },
      error: null,
    }),
  });
  const response = await GET(new Request(`${endpoint}?joinId=${receipt.joinId}`), params);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ joinId: receipt.joinId, ...delivery });
  expect(rpc).toHaveBeenCalledExactlyOnceWith("read_factory_workflow_repository_delivery", {
    p_root_session_id: scope.id,
    p_workspace_id: scope.workspace_id,
    p_factory_id: scope.factory_id,
    p_join_id: receipt.joinId,
  });
  expect(authorizedConflict).not.toHaveBeenCalled();
});
