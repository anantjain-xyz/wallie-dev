import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ collect: vi.fn(), mint: vi.fn() }));
vi.mock("./pr-verification-auth", () => ({
  mintPrVerificationToken: mocks.mint,
  PrVerificationAuthError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));
vi.mock("./pr-verification-api", () => ({
  collectPrVerification: mocks.collect,
  PrVerificationApiError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));

import { PrVerificationApiError } from "./pr-verification-api";
import { reconcileGitHubPrVerification } from "./pr-verification-service";

const id = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const claim = {
  session_id: id,
  workspace_id: workspaceId,
  claim_token: "33333333-3333-4333-8333-333333333333",
  policy_revision_id: id,
  requirements: {
    version: 1,
    deliveryMode: "code",
    requiredChecks: [],
    minimumApprovals: 0,
    requireCodeOwnerReview: false,
    requireResolvedThreads: true,
    requiredEvidence: [],
    freshnessSeconds: 3600,
    requireArtifactApprovalForDelivery: true,
  },
  artifact_review_revision: 1,
  checkpoint_run_id: id,
  repository_id: id,
  repository_full_name: "anantjain-xyz/wallie-dev",
  github_repository_id: 1196742316,
  installation_id: 123,
  installation_suspended: false,
  repository_archived: false,
  pr_epoch_id: id,
  pr_number: 592,
  branch_name: "wallie/sessions/session/epoch",
  base_branch: "main",
};

function setup(options: { claims?: unknown[]; accepted?: boolean; enqueueError?: boolean } = {}) {
  const queue = [...(options.claims ?? [claim])];
  const rpc = vi.fn((name: string) => {
    let value: { data: unknown; error: unknown };
    if (name === "enqueue_due_github_pr_refreshes")
      value = { data: 1, error: options.enqueueError ? { message: "private" } : null };
    else if (name === "claim_github_pr_refresh")
      value = { data: queue.shift() ?? null, error: null };
    else if (name === "finish_github_pr_refresh")
      value = { data: options.accepted ?? true, error: null };
    else throw new Error(`Unexpected RPC ${name}`);
    return { abortSignal: vi.fn().mockResolvedValue(value) };
  });
  return { admin: { rpc } as never, rpc };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.mint.mockResolvedValue({
    token: "private-token",
    installationPermissions: { checks: "read" },
  });
  mocks.collect.mockResolvedValue({
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    payload: { version: 1 },
  });
});

describe("bounded GitHub PR reconciliation", () => {
  it("uses only leased repository identity and persists the exact snapshot through its fence", async () => {
    const { admin, rpc } = setup();
    expect(await reconcileGitHubPrVerification(admin, { workspaceId })).toEqual({
      checked: 1,
      refreshed: 1,
      failed: 0,
    });
    expect(mocks.mint).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: 123, repositoryNumericId: 1196742316 }),
    );
    expect(mocks.collect).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: claim.repository_full_name,
        repositoryNumericId: 1196742316,
        prNumber: 592,
        requirements: claim.requirements,
      }),
    );
    expect(rpc).toHaveBeenCalledWith("finish_github_pr_refresh", {
      p_session_id: id,
      p_claim_token: claim.claim_token,
      p_head_sha: "a".repeat(40),
      p_base_sha: "b".repeat(40),
      p_payload: { version: 1 },
    });
    expect(rpc).toHaveBeenCalledWith("claim_github_pr_refresh", { p_workspace_id: workspaceId });
  });

  it("persists fixed error codes without token, raw error text, or invented commit SHAs", async () => {
    const { admin, rpc } = setup();
    mocks.collect.mockRejectedValue(new PrVerificationApiError("github_permission_missing"));
    expect(await reconcileGitHubPrVerification(admin)).toEqual({
      checked: 1,
      refreshed: 0,
      failed: 1,
    });
    expect(rpc).toHaveBeenCalledWith("finish_github_pr_refresh", {
      p_session_id: id,
      p_claim_token: claim.claim_token,
      p_error_code: "github_permission_missing",
    });
    mocks.collect.mockRejectedValue(new Error("secret provider body"));
    const second = setup();
    await reconcileGitHubPrVerification(second.admin);
    expect(JSON.stringify(second.rpc.mock.calls)).not.toMatch(/secret provider body|private-token/);
    expect(second.rpc).toHaveBeenCalledWith(
      "finish_github_pr_refresh",
      expect.objectContaining({ p_error_code: "github_refresh_failed" }),
    );
  });

  it("does not report a stale lease or generation as a refreshed observation", async () => {
    const { admin } = setup({ accepted: false });
    expect(await reconcileGitHubPrVerification(admin)).toEqual({
      checked: 1,
      refreshed: 0,
      failed: 0,
    });
  });

  it("bounds each cycle even when work is continuously available", async () => {
    const { admin } = setup({ claims: Array(10).fill(claim) });
    expect(await reconcileGitHubPrVerification(admin)).toEqual({
      checked: 3,
      refreshed: 3,
      failed: 0,
    });
    expect(mocks.collect).toHaveBeenCalledTimes(3);
  });

  it("fails closed before provider requests if claims cross a workspace boundary", async () => {
    const { admin } = setup();
    await expect(reconcileGitHubPrVerification(admin, { workspaceId: id })).rejects.toThrow(
      "workspace boundary",
    );
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it("does not fetch archived repositories or suspended installations", async () => {
    const { admin } = setup({ claims: [{ ...claim, installation_suspended: true }] });
    expect(await reconcileGitHubPrVerification(admin)).toEqual({
      checked: 1,
      refreshed: 0,
      failed: 1,
    });
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it("does not continue after scheduling fails", async () => {
    const { admin, rpc } = setup({ enqueueError: true });
    await expect(reconcileGitHubPrVerification(admin)).rejects.toThrow("scheduling is unavailable");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(mocks.collect).not.toHaveBeenCalled();
  });
});
