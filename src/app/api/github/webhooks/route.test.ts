import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  config: vi.fn(),
  verify: vi.fn(),
  installation: vi.fn(),
  repositories: vi.fn(),
  pullRequest: vi.fn(),
}));
vi.mock("@/features/github/config", () => ({ getGitHubConfigStatus: mocked.config }));
vi.mock("@/features/github/webhooks", () => ({
  verifyGitHubWebhookRequest: mocked.verify,
  handleGitHubInstallationEvent: mocked.installation,
  handleGitHubInstallationRepositoriesEvent: mocked.repositories,
  handleGitHubPullRequestEvent: mocked.pullRequest,
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
function request(body: unknown = payload, event = "pull_request") {
  return new Request("https://wallie.test/api/github/webhooks", {
    method: "POST",
    headers: { "x-github-event": event, "x-hub-signature-256": "signed" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
describe("GitHub webhook boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.config.mockReturnValue({ missingWebhookKeys: [] });
    mocked.verify.mockResolvedValue(true);
  });
  it("validates consumed fields and passes the source timestamp to reconciliation", async () => {
    const response = await POST(request({ ...payload, ignored: "extra" }));
    expect(response.status).toBe(200);
    expect(mocked.pullRequest).toHaveBeenCalledWith(payload);
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
  });
});
