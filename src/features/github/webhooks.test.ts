import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  syncGitHubRepositoriesForWorkspace: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/features/github/service", () => ({
  syncGitHubRepositoriesForWorkspace: mocked.syncGitHubRepositoriesForWorkspace,
}));

import { handleGitHubPullRequestEvent } from "./webhooks";

interface UpdateCall {
  table: string;
  patch: Record<string, unknown>;
  filters: Array<{ column: string; value: unknown }>;
  affectedRows: Array<{ id: string }>;
}

interface AdminMockOptions {
  installation: { id: string; workspace_id: string } | null;
  repository?: { id: string } | null;
  matchingRowsByPr?: Array<{ id: string }>;
  matchingRowsByBranch?: Array<{ id: string }>;
}

function buildAdminMock(opts: AdminMockOptions) {
  const updates: UpdateCall[] = [];

  function makeUpdate(
    table: string,
    affectedFn: (filters: UpdateCall["filters"]) => Array<{ id: string }>,
  ) {
    return (patch: Record<string, unknown>) => {
      const filters: UpdateCall["filters"] = [];
      const chain = {
        eq(column: string, value: unknown) {
          filters.push({ column, value });
          return chain;
        },
        select() {
          const affected = affectedFn(filters);
          updates.push({ table, patch, filters: [...filters], affectedRows: affected });
          return Promise.resolve({ data: affected, error: null });
        },
        then(resolve: (v: { data: null; error: null }) => void) {
          const affected = affectedFn(filters);
          updates.push({ table, patch, filters: [...filters], affectedRows: affected });
          resolve({ data: null, error: null });
        },
      };
      return chain;
    };
  }

  const tables: Record<string, unknown> = {
    github_installations: {
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: opts.installation, error: null }),
        }),
      }),
    },
    github_repositories: {
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: opts.repository ?? null, error: null }),
          }),
        }),
      }),
    },
    session_pull_requests: {
      update: makeUpdate("session_pull_requests", (filters) => {
        const isPrMatch = filters.some((f) => f.column === "pull_request_number");
        if (isPrMatch) return opts.matchingRowsByPr ?? [];
        return opts.matchingRowsByBranch ?? [];
      }),
    },
  };

  return {
    admin: {
      from: (name: string) => tables[name] ?? {},
    } as unknown,
    updates,
  };
}

const env = {
  GITHUB_WEBHOOK_SECRET: "x",
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
};

function payload(action: string, overrides: Partial<{ ref: string; merged: boolean; state: "open" | "closed"; draft: boolean }> = {}) {
  return {
    action,
    installation: { id: 999 },
    pull_request: {
      draft: overrides.draft ?? false,
      head: { ref: overrides.ref ?? "wallie/product-sess-1" },
      html_url: "https://github.com/acme/app/pull/42",
      merged: overrides.merged ?? false,
      number: 42,
      state: overrides.state ?? "open",
    },
    repository: { id: 555 },
  };
}

describe("handleGitHubPullRequestEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ignores events for branches that aren't Wallie-managed", async () => {
    const { admin, updates } = buildAdminMock({ installation: null });
    mocked.createSupabaseAdminClient.mockReturnValue(admin);

    await handleGitHubPullRequestEvent(payload("opened", { ref: "feature/foo" }), env);

    expect(updates).toHaveLength(0);
  });

  it("ignores events whose action isn't tracked", async () => {
    const { admin, updates } = buildAdminMock({ installation: null });
    mocked.createSupabaseAdminClient.mockReturnValue(admin);

    await handleGitHubPullRequestEvent(payload("labeled"), env);

    expect(updates).toHaveLength(0);
  });

  it("updates session_pull_requests by (github_repository_id, pull_request_number) on opened", async () => {
    const { admin, updates } = buildAdminMock({
      installation: { id: "ghi-1", workspace_id: "ws-1" },
      repository: { id: "repo-1" },
      matchingRowsByPr: [{ id: "spr-1" }],
    });
    mocked.createSupabaseAdminClient.mockReturnValue(admin);

    await handleGitHubPullRequestEvent(payload("opened"), env);

    expect(updates).toHaveLength(1);
    expect(updates[0]!.table).toBe("session_pull_requests");
    expect(updates[0]!.patch).toEqual({
      github_repository_id: "repo-1",
      is_draft: false,
      pull_request_number: 42,
      pull_request_state: "open",
      pull_request_url: "https://github.com/acme/app/pull/42",
    });
    const filterMap = Object.fromEntries(updates[0]!.filters.map((f) => [f.column, f.value]));
    expect(filterMap).toEqual({
      workspace_id: "ws-1",
      github_repository_id: "repo-1",
      pull_request_number: 42,
    });
  });

  it("falls back to (workspace_id, branch_name) when no row matches by PR number yet", async () => {
    const { admin, updates } = buildAdminMock({
      installation: { id: "ghi-1", workspace_id: "ws-1" },
      repository: { id: "repo-1" },
      matchingRowsByPr: [],
      matchingRowsByBranch: [{ id: "spr-1" }],
    });
    mocked.createSupabaseAdminClient.mockReturnValue(admin);

    await handleGitHubPullRequestEvent(payload("synchronize"), env);

    expect(updates).toHaveLength(2);
    const branchUpdate = updates[1]!;
    const filterMap = Object.fromEntries(branchUpdate.filters.map((f) => [f.column, f.value]));
    expect(filterMap).toEqual({
      workspace_id: "ws-1",
      branch_name: "wallie/product-sess-1",
    });
  });

  it("marks the PR as merged when the close event sets merged=true", async () => {
    const { admin, updates } = buildAdminMock({
      installation: { id: "ghi-1", workspace_id: "ws-1" },
      repository: { id: "repo-1" },
      matchingRowsByPr: [{ id: "spr-1" }],
    });
    mocked.createSupabaseAdminClient.mockReturnValue(admin);

    await handleGitHubPullRequestEvent(payload("closed", { merged: true, state: "closed" }), env);

    expect(updates[0]!.patch.pull_request_state).toBe("merged");
  });

  it("falls back to branch lookup when the repo row is missing entirely", async () => {
    const { admin, updates } = buildAdminMock({
      installation: { id: "ghi-1", workspace_id: "ws-1" },
      repository: null,
      matchingRowsByBranch: [{ id: "spr-1" }],
    });
    mocked.createSupabaseAdminClient.mockReturnValue(admin);

    await handleGitHubPullRequestEvent(payload("reopened"), env);

    expect(updates).toHaveLength(1);
    expect(updates[0]!.patch.github_repository_id).toBeNull();
    const filterMap = Object.fromEntries(updates[0]!.filters.map((f) => [f.column, f.value]));
    expect(filterMap).toEqual({
      workspace_id: "ws-1",
      branch_name: "wallie/product-sess-1",
    });
  });
});
