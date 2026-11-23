import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn(), config: vi.fn(() => ({})) }));
vi.mock("./config", () => ({ resolveGitHubAppConfig: mocks.config }));
vi.mock("@octokit/app", () => ({
  App: class {
    octokit = { request: mocks.request };
  },
}));

import { mintActionsDeliveryToken } from "./actions-delivery-auth";

const liveInstallation = {
  id: 123,
  app_slug: "wallie-fixture",
  suspended_at: null,
  permissions: { contents: "write", actions: "write", deployments: "write" },
};
const inputs = {
  installationId: 123,
  repositoryNumericId: 456,
  signal: new AbortController().signal,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.request.mockImplementation(async (route: string, payload: { permissions?: unknown }) => ({
    data: route.startsWith("GET")
      ? liveInstallation
      : { token: "fixture-token", permissions: payload.permissions },
  }));
});

it.each([
  ["dispatch", "write"],
  ["observe", "read"],
] as const)(
  "mints a purpose-scoped %s token for the exact numeric repository",
  async (mode, actions) => {
    const result = await mintActionsDeliveryToken({ ...inputs, mode });
    expect(result).toEqual({
      kind: "granted",
      token: "fixture-token",
      actorLogin: "wallie-fixture[bot]",
    });
    expect(mocks.request.mock.calls).toEqual([
      [
        "GET /app/installations/{installation_id}",
        {
          installation_id: 123,
          request: { redirect: "manual", signal: inputs.signal },
        },
      ],
      [
        "POST /app/installations/{installation_id}/access_tokens",
        {
          installation_id: 123,
          repository_ids: [456],
          permissions: { actions, contents: "read" },
          request: { redirect: "manual", signal: inputs.signal },
        },
      ],
    ]);
  },
);

it.each([
  [{ ...liveInstallation, suspended_at: "2026-11-23T20:00:00Z" }, "installation_unavailable"],
  [{ ...liveInstallation, id: 999 }, "installation_unavailable"],
  [
    { ...liveInstallation, permissions: { actions: "read", contents: "write" } },
    "permission_missing",
  ],
  [{ ...liveInstallation, permissions: { actions: "write" } }, "permission_missing"],
])("checks live installation and consent before minting", async (data, reason) => {
  mocks.request.mockResolvedValue({ data });
  await expect(mintActionsDeliveryToken({ ...inputs, mode: "dispatch" })).resolves.toEqual({
    kind: "blocked",
    reason,
  });
  expect(mocks.request).toHaveBeenCalledTimes(1);
});

it("stops if the exact repository is removed while minting", async () => {
  mocks.request
    .mockResolvedValueOnce({ data: liveInstallation })
    .mockRejectedValueOnce({ status: 422 });
  await expect(mintActionsDeliveryToken({ ...inputs, mode: "dispatch" })).resolves.toEqual({
    kind: "blocked",
    reason: "installation_unavailable",
  });
  expect(mocks.request).toHaveBeenCalledTimes(2);
});
