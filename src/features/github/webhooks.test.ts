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

import {
  handleGitHubInstallationEvent,
  handleGitHubInstallationRepositoriesEvent,
  handleGitHubPullRequestEvent,
} from "./webhooks";

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
  matchingRowsByOnboarding?: Array<{ id: string }>;
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
    repository_onboarding_status: {
      update: makeUpdate("repository_onboarding_status", () => opts.matchingRowsByOnboarding ?? []),
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

function payload(
  action: string,
  overrides: Partial<{
    ref: string;
    merged: boolean;
    state: "open" | "closed";
    draft: boolean;
  }> = {},
) {
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

  it("marks Wallie setup PR onboarding ready when the setup PR merges", async () => {
    const { admin, updates } = buildAdminMock({
      installation: { id: "ghi-1", workspace_id: "ws-1" },
      matchingRowsByOnboarding: [{ id: "onboarding-1" }],
      repository: { id: "repo-1" },
    });
    mocked.createSupabaseAdminClient.mockReturnValue(admin);

    await handleGitHubPullRequestEvent(
      payload("closed", { merged: true, ref: "wallie/setup-app-abc", state: "closed" }),
      env,
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]!.table).toBe("repository_onboarding_status");
    expect(updates[0]!.patch).toEqual({
      conflict_report: [],
      last_error: null,
      setup_pr_number: 42,
      setup_pr_url: "https://github.com/acme/app/pull/42",
      status: "ready",
    });
    const filterMap = Object.fromEntries(updates[0]!.filters.map((f) => [f.column, f.value]));
    expect(filterMap).toEqual({
      workspace_id: "ws-1",
      github_repository_id: "repo-1",
      setup_branch_name: "wallie/setup-app-abc",
    });
  });

  it("marks Wallie setup PR onboarding errored when the setup PR closes unmerged", async () => {
    const { admin, updates } = buildAdminMock({
      installation: { id: "ghi-1", workspace_id: "ws-1" },
      matchingRowsByOnboarding: [{ id: "onboarding-1" }],
      repository: { id: "repo-1" },
    });
    mocked.createSupabaseAdminClient.mockReturnValue(admin);

    await handleGitHubPullRequestEvent(
      payload("closed", { merged: false, ref: "wallie/setup-app-abc", state: "closed" }),
      env,
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]!.table).toBe("repository_onboarding_status");
    expect(updates[0]!.patch).toEqual({
      last_error: "Setup PR was closed without merging.",
      setup_pr_number: 42,
      setup_pr_url: "https://github.com/acme/app/pull/42",
      status: "error",
    });
  });

  it("falls through to session PR handling when no setup onboarding row matches", async () => {
    const { admin, updates } = buildAdminMock({
      installation: { id: "ghi-1", workspace_id: "ws-1" },
      matchingRowsByBranch: [{ id: "spr-1" }],
      matchingRowsByOnboarding: [],
      matchingRowsByPr: [],
      repository: { id: "repo-1" },
    });
    mocked.createSupabaseAdminClient.mockReturnValue(admin);

    await handleGitHubPullRequestEvent(payload("opened", { ref: "wallie/setup-sess-1" }), env);

    expect(updates.map((update) => update.table)).toEqual([
      "repository_onboarding_status",
      "session_pull_requests",
      "session_pull_requests",
    ]);
    expect(updates[2]!.filters).toEqual([
      { column: "workspace_id", value: "ws-1" },
      { column: "branch_name", value: "wallie/setup-sess-1" },
    ]);
  });
});

// ---- installation lifecycle ---------------------------------------------

interface InstallationCall {
  type: "delete" | "update";
  filters: Record<string, unknown>;
  patch?: Record<string, unknown>;
}

function buildInstallationsAdmin(opts: { error?: { message: string } | null } = {}) {
  const calls: InstallationCall[] = [];
  return {
    calls,
    admin: {
      from(table: string) {
        if (table !== "github_installations") {
          throw new Error(`unexpected table ${table}`);
        }
        return {
          delete() {
            const filters: Record<string, unknown> = {};
            const chain = {
              eq(column: string, value: unknown) {
                filters[column] = value;
                return chain;
              },
              then(resolve: (value: { data: null; error: unknown }) => void) {
                calls.push({ type: "delete", filters });
                resolve({ data: null, error: opts.error ?? null });
              },
            };
            return chain;
          },
          update(patch: Record<string, unknown>) {
            const filters: Record<string, unknown> = {};
            const chain = {
              eq(column: string, value: unknown) {
                filters[column] = value;
                return chain;
              },
              then(resolve: (value: { data: null; error: unknown }) => void) {
                calls.push({ type: "update", filters, patch });
                resolve({ data: null, error: opts.error ?? null });
              },
            };
            return chain;
          },
        };
      },
    } as unknown,
  };
}

describe("handleGitHubInstallationEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes the installation row when GitHub reports the app was uninstalled", async () => {
    const { admin, calls } = buildInstallationsAdmin();
    mocked.createSupabaseAdminClient.mockReturnValue(admin);

    await handleGitHubInstallationEvent({ action: "deleted", installation: { id: 999 } }, env);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      type: "delete",
      filters: { installation_id: 999 },
    });
  });

  it("toggles the suspended flag on suspend and unsuspend events", async () => {
    const { admin, calls } = buildInstallationsAdmin();
    mocked.createSupabaseAdminClient.mockReturnValue(admin);

    await handleGitHubInstallationEvent({ action: "suspend", installation: { id: 999 } }, env);
    await handleGitHubInstallationEvent({ action: "unsuspend", installation: { id: 999 } }, env);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      type: "update",
      filters: { installation_id: 999 },
      patch: { suspended: true },
    });
    expect(calls[1]).toEqual({
      type: "update",
      filters: { installation_id: 999 },
      patch: { suspended: false },
    });
  });

  it("ignores actions that aren't lifecycle transitions (e.g. created)", async () => {
    const { admin, calls } = buildInstallationsAdmin();
    mocked.createSupabaseAdminClient.mockReturnValue(admin);

    await handleGitHubInstallationEvent({ action: "created", installation: { id: 999 } }, env);
    await handleGitHubInstallationEvent(
      { action: "new_permissions_accepted", installation: { id: 999 } },
      env,
    );

    expect(calls).toHaveLength(0);
  });

  it("propagates supabase errors so the webhook handler can return 5xx and trigger retry", async () => {
    const { admin } = buildInstallationsAdmin({ error: { message: "rls denied" } });
    mocked.createSupabaseAdminClient.mockReturnValue(admin);

    await expect(
      handleGitHubInstallationEvent({ action: "deleted", installation: { id: 999 } }, env),
    ).rejects.toMatchObject({ message: "rls denied" });
  });
});

describe("handleGitHubInstallationRepositoriesEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function buildLookupAdmin(opts: {
    installation: { workspace_id: string; installation_id: number } | null;
    error?: { message: string } | null;
  }) {
    return {
      from: (table: string) => {
        if (table !== "github_installations") {
          throw new Error(`unexpected table ${table}`);
        }
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: opts.installation,
                error: opts.error ?? null,
              }),
            }),
          }),
        };
      },
    } as unknown;
  }

  it("re-syncs the workspace's repositories when the installation is recognized", async () => {
    const admin = buildLookupAdmin({
      installation: { workspace_id: "ws-1", installation_id: 123 },
    });
    mocked.createSupabaseAdminClient.mockReturnValue(admin);

    await handleGitHubInstallationRepositoriesEvent(
      { action: "added", installation: { id: 123 } },
      env,
    );

    expect(mocked.syncGitHubRepositoriesForWorkspace).toHaveBeenCalledTimes(1);
    expect(mocked.syncGitHubRepositoriesForWorkspace).toHaveBeenCalledWith(
      { installationId: 123, workspaceId: "ws-1" },
      env,
    );
  });

  it("is a no-op when the installation isn't tracked locally (nothing to sync)", async () => {
    const admin = buildLookupAdmin({ installation: null });
    mocked.createSupabaseAdminClient.mockReturnValue(admin);

    await handleGitHubInstallationRepositoriesEvent(
      { action: "removed", installation: { id: 555 } },
      env,
    );

    expect(mocked.syncGitHubRepositoriesForWorkspace).not.toHaveBeenCalled();
  });

  it("propagates lookup errors so retries can surface", async () => {
    const admin = buildLookupAdmin({
      installation: null,
      error: { message: "lookup boom" },
    });
    mocked.createSupabaseAdminClient.mockReturnValue(admin);

    await expect(
      handleGitHubInstallationRepositoriesEvent(
        { action: "added", installation: { id: 123 } },
        env,
      ),
    ).rejects.toMatchObject({ message: "lookup boom" });

    expect(mocked.syncGitHubRepositoriesForWorkspace).not.toHaveBeenCalled();
  });
});
