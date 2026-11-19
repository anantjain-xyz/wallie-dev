import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveContext: vi.fn(),
  rpc: vi.fn(),
  verify: vi.fn(),
}));
vi.mock("@/lib/factories/route-context", () => ({
  factoryResponseHeaders: { "Cache-Control": "private, no-store" },
  resolveFactoryRouteContext: mocks.resolveContext,
}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/features/github/factory-revert-verification", () => ({
  verifyFactoryRevertPullRequest: mocks.verify,
}));

import { POST } from "./route";

const id = (slot: number) => `59600000-0000-4000-8000-${slot.toString().padStart(12, "0")}`;
const workspaceId = id(1);
const factoryId = id(2);
const actorUserId = id(3);
const target = {
  mergeId: id(4),
  observationId: id(5),
  repositoryId: id(6),
  repositoryNumericId: 456,
  repositoryFullName: "scope/project",
  installationId: 123,
  baseBranch: "main",
  pullRequestNumber: 42,
  mergeCommitSha: "a".repeat(40),
  mergedAt: "2026-01-01T00:00:00Z",
};
const proof = {
  repositoryNumericId: 456,
  baseBranch: "main",
  pullRequestNumber: 43,
  mergeCommitSha: "b".repeat(40),
  mergedAt: "2026-01-02T00:00:00Z",
  updatedAt: "2026-01-02T01:00:00Z",
};
const relationship = {
  action: "relationship",
  originalMergeId: target.mergeId,
  revertPrNumber: 43,
  expectedRevision: 2,
  requestId: id(7),
  status: "confirmed",
};
const relationshipReceipt = {
  id: id(20),
  originalMergeId: target.mergeId,
  originalObservationId: target.observationId,
  originalMergeSha: target.mergeCommitSha,
  originalMergedAt: target.mergedAt,
  revertPrNumber: proof.pullRequestNumber,
  revision: 3,
  status: "confirmed",
  revertMergeSha: proof.mergeCommitSha,
  revertMergedAt: proof.mergedAt,
  observedAt: "2026-01-02T02:00:00Z",
  actorMemberId: id(21),
};
const coverageReceipt = {
  id: id(8),
  repositoryId: target.repositoryId,
  baseBranch: target.baseBranch,
  from: "2026-01-01T00:00:00Z",
  through: "2026-02-01T00:00:00Z",
  recordedAt: "2026-02-02T00:00:00Z",
  withdrawnAt: null,
  actorMemberId: id(21),
};
const scope = {
  p_workspace_id: workspaceId,
  p_factory_id: factoryId,
  p_actor_user_id: actorUserId,
};

function request(body: unknown) {
  return POST(
    new Request(
      `https://wallie.dev/api/workspaces/${workspaceId}/factories/${factoryId}/outcome-reverts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ workspaceId, factoryId }) },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolveContext.mockResolvedValue({
    ok: true,
    workspaceId,
    factoryId,
    access: { user: { id: actorUserId } },
  });
  mocks.rpc.mockImplementation((name: string, args: { p_status?: string }) => {
    const data =
      name === "get_factory_revert_target"
        ? target
        : name === "save_factory_revert_relationship"
          ? {
              ...relationshipReceipt,
              status: args.p_status,
              ...(args.p_status === "candidate"
                ? { revertMergeSha: null, revertMergedAt: null }
                : {}),
              internalField: "private",
            }
          : {
              ...coverageReceipt,
              withdrawnAt:
                name === "withdraw_factory_revert_coverage" ? coverageReceipt.recordedAt : null,
              internalField: "private",
            };
    return { abortSignal: async () => ({ data, error: null }) };
  });
  mocks.verify.mockResolvedValue({ ok: true, proof });
});

it("preflights manager authority and binds verification to the original observation", async () => {
  const response = await request(relationship);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual(relationshipReceipt);
  expect(mocks.rpc).toHaveBeenNthCalledWith(1, "get_factory_revert_target", {
    ...scope,
    p_original_merge_id: target.mergeId,
  });
  expect(mocks.verify).toHaveBeenCalledExactlyOnceWith({
    target,
    revertPrNumber: 43,
    signal: expect.any(AbortSignal),
  });
  expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.verify.mock.invocationCallOrder[0],
  );
  expect(mocks.verify.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.rpc.mock.invocationCallOrder[1],
  );
  expect(mocks.rpc).toHaveBeenNthCalledWith(2, "save_factory_revert_relationship", {
    ...scope,
    p_original_merge_id: target.mergeId,
    p_revert_pr_number: 43,
    p_expected_revision: 2,
    p_request_id: id(7),
    p_status: "confirmed",
    p_original_observation_id: target.observationId,
    p_proof: proof,
  });
});

it.each(["candidate", "invalidated"])(
  "records %s evidence through the manager RPC alone",
  async (status) => {
    expect((await request({ ...relationship, status })).status).toBe(200);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("save_factory_revert_relationship", {
      ...scope,
      p_original_merge_id: target.mergeId,
      p_revert_pr_number: 43,
      p_expected_revision: 2,
      p_request_id: id(7),
      p_status: status,
    });
  },
);

it.each(["42501", "PT404"])(
  "does not reach GitHub when the preflight refuses scope with %s",
  async (code) => {
    mocks.rpc.mockReturnValue({ abortSignal: async () => ({ data: null, error: { code } }) });
    expect((await request(relationship)).status).toBe(code === "PT404" ? 404 : 403);
    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(mocks.verify).not.toHaveBeenCalled();
  },
);

it.each([
  ["unverified", 422],
  ["unavailable", 503],
] as const)("records no confirmation when GitHub returns %s", async (code, status) => {
  mocks.verify.mockResolvedValue({ ok: false, code });
  expect((await request(relationship)).status).toBe(status);
  expect(mocks.rpc).toHaveBeenCalledOnce();
});

it("rejects client-supplied proof before acting", async () => {
  expect((await request({ ...relationship, proof })).status).toBe(400);
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.verify).not.toHaveBeenCalled();
});

it("withholds a malformed database receipt", async () => {
  mocks.rpc.mockReturnValue({
    abortSignal: async () => ({ data: { internalField: "private" }, error: null }),
  });
  const response = await request({ ...relationship, status: "candidate" });
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "Could not read the revert evidence receipt." });
});

it("forwards coverage evidence and withdrawal through the exact manager scope", async () => {
  const { from, through } = coverageReceipt;
  const recorded = await request({
    action: "coverage",
    repositoryId: target.repositoryId,
    baseBranch: "main",
    from,
    through,
    requestId: id(7),
  });
  expect(recorded.status).toBe(200);
  expect(await recorded.json()).toEqual(coverageReceipt);
  const withdrawn = await request({ action: "withdrawCoverage", coverageId: id(8) });
  expect(withdrawn.status).toBe(200);
  expect(await withdrawn.json()).toEqual({
    ...coverageReceipt,
    withdrawnAt: coverageReceipt.recordedAt,
  });
  expect(mocks.rpc).toHaveBeenNthCalledWith(1, "record_factory_revert_coverage", {
    ...scope,
    p_repository_id: target.repositoryId,
    p_base_branch: "main",
    p_from: from,
    p_through: through,
    p_request_id: id(7),
  });
  expect(mocks.rpc).toHaveBeenNthCalledWith(2, "withdraw_factory_revert_coverage", {
    ...scope,
    p_coverage_id: id(8),
  });
  expect(mocks.verify).not.toHaveBeenCalled();
});
