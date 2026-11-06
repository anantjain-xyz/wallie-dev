import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadReviewContext: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  mintPrVerificationToken: vi.fn(),
  loadPrDiff: vi.fn(),
}));

vi.mock("@/features/sessions/review/http", async () => ({
  ...(await vi.importActual("@/features/sessions/review/http")),
  loadReviewContext: mocks.loadReviewContext,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocks.createSupabaseAdminClient,
}));
vi.mock("@/features/github/pr-verification-auth", async () => {
  const actual = await vi.importActual<typeof import("@/features/github/pr-verification-auth")>(
    "@/features/github/pr-verification-auth",
  );
  return { ...actual, mintPrVerificationToken: mocks.mintPrVerificationToken };
});
vi.mock("@/features/github/pr-diff", async () => {
  const actual = await vi.importActual<typeof import("@/features/github/pr-diff")>(
    "@/features/github/pr-diff",
  );
  return { ...actual, loadPrDiff: mocks.loadPrDiff };
});

import { PrDiffApiError } from "@/features/github/pr-diff";
import { PrVerificationAuthError } from "@/features/github/pr-verification-auth";
import { GET } from "./route";

const sessionId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const epochId = "33333333-3333-4333-8333-333333333333";
const repositoryId = "44444444-4444-4444-8444-444444444444";
const installationId = "55555555-5555-4555-8555-555555555555";
const params = { params: Promise.resolve({ sessionId }) };

function table(data: unknown) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data, error: null }),
  };
  return builder;
}

function admin(tables: Record<string, unknown>) {
  return { from: (name: string) => tables[name] ?? table(null) };
}

const diff = {
  repositoryFullName: "acme/app",
  prNumber: 42,
  url: "https://github.com/acme/app/pull/42",
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  state: "open",
  draft: false,
  files: [],
  additions: 0,
  deletions: 0,
  hasMore: false,
  truncated: false,
  limits: { maxFiles: 100, maxPatchLines: 400, maxPatchCharacters: 24000 },
};

const repositoryRow = {
  id: repositoryId,
  full_name: "acme/app",
  repo_id: 123,
  is_archived: false,
  github_installation_id: installationId,
  workspace_id: workspaceId,
};
const installationRow = {
  id: installationId,
  installation_id: 456,
  suspended: false,
  workspace_id: workspaceId,
};
const tables = {
  session_pr_sync: table({ current_epoch_id: epochId }),
  session_pr_epochs: table({
    repository_id: repositoryId,
    repository_full_name: "acme/app",
    pr_number: 42,
    pr_url: "https://github.com/acme/app/pull/42",
  }),
  github_repositories: table(repositoryRow),
  github_installations: table(installationRow),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadReviewContext.mockResolvedValue({
    session: { id: sessionId, workspace_id: workspaceId },
    supabase: {},
  });
  mocks.createSupabaseAdminClient.mockReturnValue(admin(tables));
  mocks.mintPrVerificationToken.mockResolvedValue({
    token: "ghs_test",
    installationPermissions: {},
  });
  mocks.loadPrDiff.mockResolvedValue(diff);
});

it("loads the pinned canonical PR diff with a read-only installation token", async () => {
  const response = await GET(new Request("http://localhost"), params);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ diff });
  expect(mocks.mintPrVerificationToken).toHaveBeenCalledWith({
    installationId: 456,
    repositoryNumericId: 123,
    signal: expect.any(AbortSignal),
  });
  expect(mocks.loadPrDiff).toHaveBeenCalledWith({
    token: "ghs_test",
    installationPermissions: {},
    repositoryFullName: "acme/app",
    repositoryNumericId: 123,
    prNumber: 42,
    expectedUrl: "https://github.com/acme/app/pull/42",
    signal: expect.any(AbortSignal),
  });
});

it("returns a deterministic conflict before minting when no canonical PR exists", async () => {
  mocks.createSupabaseAdminClient.mockReturnValue(
    admin({ ...tables, session_pr_sync: table({ current_epoch_id: null }) }),
  );
  const response = await GET(new Request("http://localhost"), params);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "No canonical pull request is available." });
  expect(mocks.mintPrVerificationToken).not.toHaveBeenCalled();
});

it("refuses to read a diff for an archived repository", async () => {
  mocks.createSupabaseAdminClient.mockReturnValue(
    admin({
      ...tables,
      github_repositories: table({ ...repositoryRow, is_archived: true }),
    }),
  );
  const response = await GET(new Request("http://localhost"), params);
  expect(response.status).toBe(409);
  expect(mocks.loadPrDiff).not.toHaveBeenCalled();
});

it("maps a suspended installation and provider failures to fixed responses", async () => {
  mocks.createSupabaseAdminClient.mockReturnValue(
    admin({
      ...tables,
      github_installations: table({ ...installationRow, suspended: true }),
    }),
  );
  expect((await GET(new Request("http://localhost"), params)).status).toBe(409);

  mocks.createSupabaseAdminClient.mockReturnValue(admin(tables));
  mocks.loadPrDiff.mockRejectedValue(new PrDiffApiError("github_rate_limited", 429));
  const rateLimited = await GET(new Request("http://localhost"), params);
  expect(rateLimited.status).toBe(429);
  expect(await rateLimited.json()).toMatchObject({ code: "github_rate_limited" });

  mocks.loadPrDiff.mockRejectedValue(new PrVerificationAuthError("github_permission_missing"));
  const permission = await GET(new Request("http://localhost"), params);
  expect(permission.status).toBe(403);
  expect(await permission.json()).toMatchObject({ code: "github_permission_missing" });
});
