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

const env = {
  GITHUB_WEBHOOK_SECRET: "x",
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
};
function payload(action = "opened") {
  return {
    action,
    installation: { id: 999 },
    repository: { id: 555 },
    pull_request: {
      draft: false,
      head: { ref: "wallie/product-sess-1", repo: { id: 555 } },
      html_url: "https://github.com/acme/app/pull/42",
      merged: false,
      number: 42,
      state: "open" as "open" | "closed",
      updated_at: "2026-10-11T00:00:00Z",
    },
  };
}
function buildPrAdmin({
  installation = { id: "ghi-1", workspace_id: "ws-1" },
  repository = { id: "repo-1" },
}: {
  installation?: { id: string; workspace_id: string } | null;
  repository?: { id: string } | null;
} = {}) {
  const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
  const filters: Array<[string, string, unknown]> = [];
  const admin = {
    rpc,
    from(table: string) {
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          filters.push([table, column, value]);
          return query;
        },
        maybeSingle: async () => ({
          data: table === "github_installations" ? installation : repository,
          error: null,
        }),
      };
      return query;
    },
  };
  mocked.createSupabaseAdminClient.mockReturnValue(admin);
  return { rpc, filters };
}

describe("handleGitHubPullRequestEvent", () => {
  beforeEach(() => vi.clearAllMocks());
  it("resolves installation and repository identity before applying the provider snapshot atomically", async () => {
    const { rpc, filters } = buildPrAdmin();
    await handleGitHubPullRequestEvent(payload(), env);
    expect(filters).toEqual([
      ["github_installations", "installation_id", 999],
      ["github_repositories", "github_installation_id", "ghi-1"],
      ["github_repositories", "repo_id", 555],
    ]);
    expect(rpc).toHaveBeenCalledWith("apply_github_pull_request_event", {
      target_workspace_id: "ws-1",
      target_repository_id: "repo-1",
      target_branch_name: "wallie/product-sess-1",
      source_pull_request_number: 42,
      source_pull_request_url: "https://github.com/acme/app/pull/42",
      source_pull_request_state: "open",
      source_is_draft: false,
      source_updated_at: "2026-10-11T00:00:00Z",
      source_head_repository_matches: true,
    });
  });
  it.each(["wallie/product-sess-1", "wallie/setup-app-abc"])(
    "preserves merged state for %s",
    async (branch) => {
      const { rpc } = buildPrAdmin();
      const event = payload("closed");
      event.pull_request = {
        ...event.pull_request,
        merged: true,
        state: "closed",
        head: { ...event.pull_request.head, ref: branch },
      };
      await handleGitHubPullRequestEvent(event, env);
      expect(rpc).toHaveBeenCalledWith(
        "apply_github_pull_request_event",
        expect.objectContaining({
          source_pull_request_state: "merged",
          target_branch_name: branch,
        }),
      );
    },
  );
  it.each([undefined, null, { id: 777 }])(
    "disables branch fallback when the head repository is not positively the base repository: %j",
    async (headRepository) => {
      const { rpc } = buildPrAdmin();
      const event = payload();
      await handleGitHubPullRequestEvent(
        {
          ...event,
          pull_request: {
            ...event.pull_request,
            head: { ...event.pull_request.head, repo: headRepository },
          },
        },
        env,
      );
      expect(rpc).toHaveBeenCalledWith(
        "apply_github_pull_request_event",
        expect.objectContaining({
          source_head_repository_matches: false,
          source_pull_request_number: 42,
          target_repository_id: "repo-1",
        }),
      );
    },
  );

  it.each([{ installation: null }, { repository: null }])(
    "never guesses a repository from the branch when identity is missing: %j",
    async (missing) => {
      const { rpc } = buildPrAdmin(missing);
      await handleGitHubPullRequestEvent(payload(), env);
      expect(rpc).not.toHaveBeenCalled();
    },
  );
  it.each(["untracked action", "unmanaged branch", "missing installation"])(
    "ignores %s",
    async (reason) => {
      const { rpc } = buildPrAdmin();
      const event = {
        ...payload(),
        installation: reason === "missing installation" ? undefined : { id: 999 },
      };
      if (reason === "untracked action") event.action = "labeled";
      if (reason === "unmanaged branch") event.pull_request.head.ref = "feature/example";
      await handleGitHubPullRequestEvent(event, env);
      expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
    },
  );
  it("propagates reconciliation failure so GitHub can retry the delivery", async () => {
    const { rpc } = buildPrAdmin();
    const error = new Error("database unavailable");
    rpc.mockResolvedValue({ data: null, error });
    await expect(handleGitHubPullRequestEvent(payload(), env)).rejects.toBe(error);
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
