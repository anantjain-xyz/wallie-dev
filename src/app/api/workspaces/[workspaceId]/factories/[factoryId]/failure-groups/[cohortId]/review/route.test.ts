import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolveScope: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/factories/route-context", () => ({
  factoryResponseHeaders: { "Cache-Control": "private, no-store" },
  resolveFactoryRouteContext: mocks.resolveScope,
}));

import { POST } from "./route";

const id = (slot: number) => `63400000-0000-4000-8000-${String(slot).padStart(12, "0")}`;
const workspaceId = id(1);
const factoryId = id(2);
const cohortId = id(3);
const command = { action: "label", expectedRevision: 4, requestId: id(4), label: "Build checks" };

function review(body: unknown) {
  return POST(
    new Request(
      `https://wallie.dev/api/workspaces/${workspaceId}/factories/${factoryId}/failure-groups/${cohortId}/review`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ workspaceId, factoryId, cohortId }) },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolveScope.mockResolvedValue({
    ok: true,
    workspaceId,
    factoryId,
    access: { supabase: { rpc: mocks.rpc } },
  });
});

it("saves and returns the reviewed label for the exact group", async () => {
  const saved = {
    review: { revision: 5, disposition: "open", label: "Build checks", can_review: true },
    split_cohort_ids: [],
  };
  mocks.rpc.mockResolvedValue({ data: { ...saved, internalAudit: "restricted" }, error: null });
  const response = await review(command);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual(saved);
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("review_factory_failure_cohort", {
    p_workspace_id: workspaceId,
    p_factory_id: factoryId,
    p_cohort_id: cohortId,
    p_expected_review_revision: 4,
    p_request_id: id(4),
    p_action: "label",
    p_label: "Build checks",
    p_selected_run_ids: undefined,
    p_expected_membership_digest: undefined,
  });
});

it.each([
  ["PT409", 409, "The failure group changed. Reload it before saving a review."],
  ["42501", 403, "You do not have permission to review this failure group."],
] as const)("returns the scoped review error for %s", async (code, status, message) => {
  mocks.rpc.mockResolvedValue({ data: null, error: { code, message: "private database detail" } });
  const response = await review(command);
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error: message });
});

it("rejects a repeated split run and a caller-supplied actor before writing", async () => {
  const duplicate = await review({
    action: "split",
    expectedRevision: 4,
    requestId: id(4),
    membershipDigest: "a".repeat(64),
    selectedRunIds: [id(5), id(5)],
  });
  const forged = await review({ ...command, actorUserId: id(6) });
  expect(duplicate.status).toBe(400);
  expect(forged.status).toBe(400);
  expect(mocks.rpc).not.toHaveBeenCalled();
});
