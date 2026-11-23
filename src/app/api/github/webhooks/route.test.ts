import { createHmac } from "node:crypto";

import { verify } from "@octokit/webhooks-methods";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  config: vi.fn(),
  verify: vi.fn(),
  installation: vi.fn(),
  repositories: vi.fn(),
  pullRequest: vi.fn(),
  verification: vi.fn(),
  automationRpc: vi.fn(),
  automationResult: vi.fn(),
}));
vi.mock("@/features/github/config", () => ({ getGitHubConfigStatus: mocked.config }));
vi.mock("@/features/github/webhooks", () => ({
  verifyGitHubWebhookRequest: mocked.verify,
  handleGitHubInstallationEvent: mocked.installation,
  handleGitHubInstallationRepositoriesEvent: mocked.repositories,
  handleGitHubPullRequestEvent: mocked.pullRequest,
  handleGitHubVerificationEvent: mocked.verification,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ rpc: mocked.automationRpc }),
}));
import { POST } from "./route";
const payload = {
  action: "opened",
  installation: { id: 123 },
  repository: { id: 456 },
  pull_request: {
    number: 42,
    html_url: "https://github.com/acme/app/pull/42",
    head: { ref: "wallie/build-1", repo: { id: 456 } },
    state: "open",
    merged: false,
    draft: false,
    updated_at: "2026-10-11T00:00:00Z",
  },
};
const deliveryId = "50600000-0000-4000-8000-000000000001";
function request(
  body: unknown = payload,
  event = "pull_request",
  delivery: string | null = deliveryId,
  signature = "signed",
) {
  return new Request("https://wallie.test/api/github/webhooks", {
    method: "POST",
    headers: {
      "x-github-event": event,
      "x-hub-signature-256": signature,
      ...(delivery === null ? {} : { "x-github-delivery": delivery }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
describe("GitHub webhook boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.config.mockReturnValue({ missingWebhookKeys: [] });
    mocked.verify.mockReset().mockResolvedValue(true);
    mocked.verification.mockReset().mockResolvedValue(undefined);
    mocked.pullRequest.mockReset().mockResolvedValue(undefined);
    mocked.automationRpc.mockReturnValue({ abortSignal: mocked.automationResult });
    mocked.automationResult.mockReset().mockResolvedValue({ data: null, error: null });
  });
  it("validates consumed fields and passes the source timestamp to reconciliation", async () => {
    const response = await POST(request({ ...payload, ignored: "extra" }));
    expect(response.status).toBe(200);
    expect(mocked.pullRequest).toHaveBeenCalledWith(payload);
    expect(mocked.verification).toHaveBeenCalledWith(
      { installationId: 123, repositoryId: 456, prNumbers: [42] },
      deliveryId,
    );
  });
  const automationPayload = {
    ...payload,
    pull_request: {
      ...payload.pull_request,
      id: 157,
      base: { ref: "main", repo: { id: 456 } },
      head: { ...payload.pull_request.head, sha: "a".repeat(40) },
      title: "Untrusted event title",
      body: "Untrusted pull request description",
    },
  };

  it("records only a scoped automation event from correctly signed GitHub bytes", async () => {
    const secret = "synthetic-github-signing-key";
    mocked.verify.mockImplementation((body: string, signature: string) =>
      verify(secret, body, signature),
    );
    const event = {
      ...automationPayload,
      action: "closed",
      pull_request: {
        ...automationPayload.pull_request,
        state: "closed",
        merged: true,
        merge_commit_sha: "b".repeat(40),
      },
    };
    const bytes = JSON.stringify(event);
    const signature = "sha256=" + createHmac("sha256", secret).update(bytes).digest("hex");

    expect((await POST(request(bytes, "pull_request", deliveryId, signature))).status).toBe(200);
    expect(mocked.automationRpc).toHaveBeenCalledWith("ingest_factory_github_automation_pr", {
      p_installation_id: 123,
      p_github_repository_id: 456,
      p_delivery_id: deliveryId,
      p_pull_request_id: 157,
      p_pull_request_number: 42,
      p_action: "merged",
      p_state: "merged",
      p_draft: false,
      p_provider_updated_at: automationPayload.pull_request.updated_at,
      p_base_branch: "main",
      p_head_branch: "wallie/build-1",
      p_head_sha: "a".repeat(40),
      p_head_repository_id: 456,
      p_merge_commit_sha: "b".repeat(40),
    });
    expect(mocked.verification).toHaveBeenCalledOnce();
    expect(mocked.pullRequest).toHaveBeenCalledOnce();

    expect((await POST(request(bytes + " ", "pull_request", deliveryId, signature))).status).toBe(
      401,
    );
    expect(mocked.automationRpc).toHaveBeenCalledOnce();
  });

  it("keeps both PR reconciliation paths independent of automation recording", async () => {
    mocked.automationResult.mockResolvedValueOnce({ error: { code: "PT409" } });
    await expect(POST(request(automationPayload))).rejects.toThrow(
      "Could not capture the GitHub pull request automation event.",
    );
    expect(mocked.verification).toHaveBeenCalledOnce();
    expect(mocked.pullRequest).toHaveBeenCalledOnce();

    mocked.pullRequest.mockRejectedValueOnce(new Error("CANONICAL_REFRESH_FAILED"));
    await expect(POST(request(automationPayload))).rejects.toThrow("CANONICAL_REFRESH_FAILED");
    expect(mocked.automationRpc).toHaveBeenCalledTimes(2);
    expect(mocked.verification).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...automationPayload, action: "edited" },
    {
      ...automationPayload,
      pull_request: { ...automationPayload.pull_request, base: { ref: "main", repo: { id: 789 } } },
    },
    {
      ...automationPayload,
      action: "closed",
      pull_request: { ...automationPayload.pull_request, state: "closed", merged: true },
    },
  ])("preserves verification for payloads ineligible for automation", async (event) => {
    expect((await POST(request(event))).status).toBe(200);
    expect(mocked.verification).toHaveBeenCalledOnce();
    expect(mocked.pullRequest).toHaveBeenCalledOnce();
    expect(mocked.automationRpc).not.toHaveBeenCalled();
  });

  it.each([
    "{bad json",
    null,
    [],
    {},
    { ...payload, repository: { id: "456" } },
    { ...payload, installation: { id: -1 } },
    { ...payload, pull_request: { ...payload.pull_request, head: null } },
    { ...payload, pull_request: { ...payload.pull_request, updated_at: "yesterday" } },
    { ...payload, pull_request: { ...payload.pull_request, number: 0 } },
    { ...payload, pull_request: { ...payload.pull_request, state: "merged" } },
    { ...payload, pull_request: { ...payload.pull_request, merged: "false" } },
    { ...payload, pull_request: { ...payload.pull_request, html_url: "javascript:alert(1)" } },
  ])("returns400 for malformed signed payload %j", async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mocked.pullRequest).not.toHaveBeenCalled();
    expect(mocked.verification).not.toHaveBeenCalled();
  });
  it.each([undefined, null, { id: 987 }])(
    "preserves optional head repository evidence for known PR updates: %j",
    async (repo) => {
      const event = {
        ...payload,
        pull_request: { ...payload.pull_request, head: { ...payload.pull_request.head, repo } },
      };
      expect((await POST(request(event))).status).toBe(200);
      expect(mocked.pullRequest).toHaveBeenCalledWith(event);
    },
  );

  it("verifies the original bytes before parsing untrusted JSON", async () => {
    mocked.verify.mockResolvedValue(false);
    expect((await POST(request("not JSON"))).status).toBe(401);
    expect(mocked.verify).toHaveBeenCalledWith("not JSON", "signed");
    expect(mocked.pullRequest).not.toHaveBeenCalled();
    expect(mocked.verification).not.toHaveBeenCalled();
  });
  it.each(["installation", "installation_repositories"])("validates %s identity", async (event) => {
    expect(
      (await POST(request({ action: "deleted", installation: { id: "bad" } }, event))).status,
    ).toBe(400);
    expect(mocked.installation).not.toHaveBeenCalled();
    expect(mocked.repositories).not.toHaveBeenCalled();
    expect(
      (await POST(request({ action: "deleted", installation: { id: 123 } }, event))).status,
    ).toBe(200);
    expect(
      event === "installation" ? mocked.installation : mocked.repositories,
    ).toHaveBeenCalledWith({ action: "deleted", installation: { id: 123 } });
  });
  it("acknowledges unrelated valid events without attempting a PR mutation", async () => {
    expect((await POST(request({ zen: "hello" }, "ping"))).status).toBe(200);
    expect(mocked.pullRequest).not.toHaveBeenCalled();
    expect(mocked.verification).not.toHaveBeenCalled();
  });
  it.each(["check_run", "check_suite"])(
    "enqueues signed %s identities and ignores payload conclusions",
    async (event) => {
      const sha = "a".repeat(40);
      const body = {
        installation: payload.installation,
        repository: payload.repository,
        [event]: {
          head_sha: sha,
          pull_requests: [{ number: 42 }, { number: 43 }],
          conclusion: "success",
        },
      };
      expect((await POST(request(body, event))).status).toBe(200);
      expect(mocked.verification).toHaveBeenCalledWith(
        { installationId: 123, repositoryId: 456, headSha: sha, prNumbers: [42, 43] },
        deliveryId,
      );
      expect(mocked.pullRequest).not.toHaveBeenCalled();
    },
  );
  it.each(["pull_request_review", "pull_request_review_comment", "pull_request_review_thread"])(
    "enqueues %s without accepting review text as evidence",
    async (event) => {
      expect(
        (await POST(request({ ...payload, review: { state: "approved" } }, event))).status,
      ).toBe(200);
      expect(mocked.verification).toHaveBeenCalledWith(
        { installationId: 123, repositoryId: 456, prNumbers: [42] },
        deliveryId,
      );
    },
  );
  it("queues old and new status events as wake-ups with no success interpretation", async () => {
    for (const sha of ["b".repeat(40), "a".repeat(40), "b".repeat(40)]) {
      expect(
        (
          await POST(
            request(
              {
                installation: payload.installation,
                repository: payload.repository,
                sha,
                state: "success",
              },
              "status",
            ),
          )
        ).status,
      ).toBe(200);
    }
    expect(mocked.verification.mock.calls.map(([signal]) => signal.headSha)).toEqual([
      "b".repeat(40),
      "a".repeat(40),
      "b".repeat(40),
    ]);
    expect(mocked.verification.mock.calls.every(([, id]) => id === deliveryId)).toBe(true);
  });
  it("enqueues branch pushes so base changes invalidate prior observations", async () => {
    expect(
      (
        await POST(
          request(
            {
              installation: payload.installation,
              repository: payload.repository,
              ref: "refs/heads/release/v1",
            },
            "push",
          ),
        )
      ).status,
    ).toBe(200);
    expect(mocked.verification).toHaveBeenCalledWith(
      { installationId: 123, repositoryId: 456, baseBranch: "release/v1" },
      deliveryId,
    );
  });
  it.each([null, "not-a-delivery-id"])(
    "rejects verification wake-ups without stable delivery identity %j",
    async (delivery) => {
      expect((await POST(request(payload, "pull_request", delivery))).status).toBe(400);
      expect(mocked.verification).not.toHaveBeenCalled();
      expect(mocked.pullRequest).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["status", { sha: "bad" }],
    ["check_run", { check_run: { head_sha: "a".repeat(40), pull_requests: [{ number: 0 }] } }],
    ["pull_request_review", { pull_request: { number: "42" } }],
    ["push", { ref: null }],
  ])("rejects malformed %s identity before queueing", async (event, extra) => {
    const body = { installation: payload.installation, repository: payload.repository, ...extra };
    expect((await POST(request(body, event))).status).toBe(400);
    expect(mocked.verification).not.toHaveBeenCalled();
  });
  it("queues canonical refresh before a failed legacy lifecycle read", async () => {
    mocked.pullRequest.mockRejectedValueOnce(new Error("GitHub unavailable"));
    await expect(POST(request())).rejects.toThrow("GitHub unavailable");
    expect(mocked.verification).toHaveBeenCalledOnce();
    expect(mocked.verification.mock.invocationCallOrder[0]).toBeLessThan(
      mocked.pullRequest.mock.invocationCallOrder[0],
    );
  });
});
