import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  syncGitHubRepositoriesForWorkspace: vi.fn(),
  getInstallationOctokit: vi.fn(),
  request: vi.fn(),
}));

vi.mock("@octokit/app", () => ({
  App: class {
    getInstallationOctokit = mocked.getInstallationOctokit;
  },
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
  handleGitHubVerificationEvent,
  verifyGitHubWebhookRequest,
} from "./webhooks";

const env = {
  GITHUB_WEBHOOK_SECRET: "x",
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: "k",
  NEXT_PUBLIC_APP_URL: "https://wallie.example",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "service",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "anon",
  WALLIE_ENCRYPTION_KEY: "a".repeat(64),
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
  repository = { id: "repo-1", full_name: "acme/app" },
  epoch = {
    base_branch: "main",
    branch_name: canonicalBranch,
    pr_number: 42,
    github_repository_id: 555,
    repository_full_name: "acme/app",
  },
}: {
  installation?: { id: string; workspace_id: string } | null;
  repository?: { id: string; full_name: string } | null;
  epoch?: {
    base_branch: string;
    pr_number: number;
    branch_name?: string;
    github_repository_id?: number;
    repository_full_name?: string;
  } | null;
} = {}) {
  const rpc = vi.fn(async (name: string) => ({
    data: name === "begin_github_pull_request_observation" ? null : true,
    error: null as Error | null,
  }));
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
          data:
            table === "github_installations"
              ? installation
              : table === "session_pr_epochs"
                ? epoch
                : repository,
          error: null,
        }),
      };
      return query;
    },
  };
  mocked.createSupabaseAdminClient.mockReturnValue(admin);
  return { rpc, filters };
}

const canonicalSessionId = "49800000-0000-4000-8000-000000000001";
const canonicalEpochId = "49800000-0000-4000-8000-000000000002";
const canonicalBranch = `wallie/sessions/${canonicalSessionId}/${canonicalEpochId}`;
function canonicalPayload(action = "synchronize") {
  const event = payload(action);
  event.pull_request.head.ref = canonicalBranch;
  return event;
}
function canonicalSnapshot() {
  return {
    ...canonicalPayload().pull_request,
    head: { ref: canonicalBranch, sha: "a".repeat(40), repo: { id: 555 } },
    base: { ref: "main", repo: { id: 555 } },
  };
}

describe("canonical PR webhook observations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.getInstallationOctokit.mockResolvedValue({ request: mocked.request });
    mocked.request.mockResolvedValue({ data: canonicalSnapshot() });
  });
  function canonicalAdmin(options: Parameters<typeof buildPrAdmin>[0] = {}) {
    const result = buildPrAdmin(options);
    result.rpc.mockImplementation(
      async (name: string) =>
        ({
          data: name === "begin_session_pr_observation" ? "canonical-token" : true,
          error: null,
        }) as never,
    );
    return result;
  }
  it("dirties the exact pinned epoch before a fresh GET and finishes only its observation token", async () => {
    const { rpc, filters } = canonicalAdmin();
    const operations: string[] = [];
    rpc.mockImplementation(async (name: string) => {
      operations.push(name);
      return {
        data: name === "begin_session_pr_observation" ? "canonical-token" : true,
        error: null,
      } as never;
    });
    mocked.request.mockImplementation(async () => {
      operations.push("GitHub GET");
      return { data: canonicalSnapshot() };
    });
    await handleGitHubPullRequestEvent(canonicalPayload(), env);
    expect(operations).toEqual([
      "begin_session_pr_observation",
      "GitHub GET",
      "finish_session_pr_observation",
    ]);
    expect(rpc).toHaveBeenCalledWith("begin_session_pr_observation", {
      p_workspace_id: "ws-1",
      p_repository_id: "repo-1",
      p_branch_name: canonicalBranch,
      p_pr_number: 42,
    });
    expect(filters).toContainEqual(["session_pr_epochs", "id", canonicalEpochId]);
    expect(filters).toContainEqual(["session_pr_epochs", "session_id", canonicalSessionId]);
    expect(filters).toContainEqual(["session_pr_epochs", "workspace_id", "ws-1"]);
    expect(filters).toContainEqual(["session_pr_epochs", "repository_id", "repo-1"]);
    expect(filters).toContainEqual(["session_pr_epochs", "branch_name", canonicalBranch]);
    expect(rpc).toHaveBeenCalledWith("finish_session_pr_observation", {
      p_observation_id: "canonical-token",
      p_pr_url: "https://github.com/acme/app/pull/42",
      p_pr_state: "open",
      p_is_draft: false,
      p_pr_head_sha: "a".repeat(40),
      p_pr_updated_at: "2026-10-11T00:00:00Z",
    });
    expect(rpc).not.toHaveBeenCalledWith("apply_github_pull_request_event", expect.anything());
  });
  it("never falls back to legacy branch adoption for an unpinned canonical PR", async () => {
    const { rpc } = canonicalAdmin();
    rpc.mockResolvedValue({ data: null, error: null });
    await handleGitHubPullRequestEvent(canonicalPayload(), env);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(mocked.request).not.toHaveBeenCalled();
  });
  it.each([null, { base_branch: "main", pr_number: 99 }])(
    "leaves state dirty if its pinned epoch disappeared or changed",
    async (epoch) => {
      const { rpc } = canonicalAdmin({ epoch });
      await handleGitHubPullRequestEvent(canonicalPayload(), env);
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(mocked.request).not.toHaveBeenCalled();
    },
  );
  it.each([
    { github_repository_id: 999 },
    { repository_full_name: "acme/other" },
    { branch_name: "wallie/other" },
  ])(
    "does not observe an epoch whose immutable repository or branch identity drifted",
    async (change) => {
      const { rpc } = canonicalAdmin({
        epoch: {
          base_branch: "main",
          pr_number: 42,
          branch_name: canonicalBranch,
          github_repository_id: 555,
          repository_full_name: "acme/app",
          ...change,
        },
      });
      await expect(handleGitHubPullRequestEvent(canonicalPayload(), env)).rejects.toThrow();
      expect(mocked.request).not.toHaveBeenCalled();
      expect(rpc).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    ["different PR", () => ({ ...canonicalSnapshot(), number: 43 })],
    [
      "different base repository",
      () => ({ ...canonicalSnapshot(), base: { ref: "main", repo: { id: 999 } } }),
    ],
    [
      "different base branch",
      () => ({ ...canonicalSnapshot(), base: { ref: "other", repo: { id: 555 } } }),
    ],
    [
      "different head repository",
      () => ({ ...canonicalSnapshot(), head: { ...canonicalSnapshot().head, repo: { id: 999 } } }),
    ],
    [
      "missing open head repository",
      () => ({ ...canonicalSnapshot(), head: { ...canonicalSnapshot().head, repo: null } }),
    ],
    [
      "different head branch",
      () => ({
        ...canonicalSnapshot(),
        head: { ...canonicalSnapshot().head, ref: "wallie/other" },
      }),
    ],
    [
      "invalid head SHA",
      () => ({ ...canonicalSnapshot(), head: { ...canonicalSnapshot().head, sha: "bad" } }),
    ],
    [
      "different URL",
      () => ({ ...canonicalSnapshot(), html_url: "https://elsewhere.example/pull/42" }),
    ],
    [
      "different URL PR",
      () => ({ ...canonicalSnapshot(), html_url: "https://github.com/acme/app/pull/43" }),
    ],
    ["contradictory state", () => ({ ...canonicalSnapshot(), merged: true })],
  ] as const)("does not finish a canonical observation with %s", async (_label, snapshot) => {
    const { rpc } = canonicalAdmin();
    mocked.request.mockResolvedValue({ data: snapshot() });
    await expect(handleGitHubPullRequestEvent(canonicalPayload(), env)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalledWith("finish_session_pr_observation", expect.anything());
    expect(rpc).not.toHaveBeenCalledWith("apply_github_pull_request_event", expect.anything());
  });
  it("leaves an interrupted GET dirty for later reconciliation", async () => {
    const { rpc } = canonicalAdmin();
    mocked.request.mockRejectedValue(new Error("GitHub temporarily unavailable"));
    await expect(handleGitHubPullRequestEvent(canonicalPayload(), env)).rejects.toThrow();
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])(
    "records terminal state with a deleted head repository (merged: %s)",
    async (merged) => {
      const { rpc } = canonicalAdmin();
      mocked.request.mockResolvedValue({
        data: {
          ...canonicalSnapshot(),
          state: "closed",
          merged,
          head: { ...canonicalSnapshot().head, repo: null },
        },
      });
      await handleGitHubPullRequestEvent(canonicalPayload("closed"), env);
      expect(rpc).toHaveBeenCalledWith(
        "finish_session_pr_observation",
        expect.objectContaining({
          p_pr_state: merged ? "merged" : "closed",
          p_pr_head_sha: null,
        }),
      );
    },
  );
  it("lets the database discard a superseded observation without a second write", async () => {
    const { rpc } = canonicalAdmin();
    rpc.mockImplementation(
      async (name: string) =>
        ({
          data: name === "begin_session_pr_observation" ? "superseded-token" : false,
          error: null,
        }) as never,
    );
    await expect(handleGitHubPullRequestEvent(canonicalPayload(), env)).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});

describe("GitHub verification refresh wake-ups", () => {
  beforeEach(() => vi.clearAllMocks());
  const deliveryId = "50600000-0000-4000-8000-000000000001";
  it("forwards only scoped identities and a stable delivery key to the service-only queue", async () => {
    const { rpc } = buildPrAdmin();
    const signal = {
      installationId: 999,
      repositoryId: 555,
      prNumbers: [42, 43],
      headSha: "a".repeat(40),
    };
    await handleGitHubVerificationEvent(signal, deliveryId, env);
    await handleGitHubVerificationEvent(signal, deliveryId, env);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith("enqueue_github_pr_refresh_event", {
      p_installation_id: 999,
      p_github_repository_id: 555,
      p_delivery_id: deliveryId,
      p_pr_numbers: [42, 43],
      p_head_sha: "a".repeat(40),
    });
    expect(mocked.request).not.toHaveBeenCalled();
  });
  it("passes target-branch push identity without broadening it to the whole installation", async () => {
    const { rpc } = buildPrAdmin();
    await handleGitHubVerificationEvent(
      { installationId: 999, repositoryId: 555, baseBranch: "release/v1" },
      deliveryId,
      env,
    );
    expect(rpc).toHaveBeenCalledWith("enqueue_github_pr_refresh_event", {
      p_installation_id: 999,
      p_github_repository_id: 555,
      p_delivery_id: deliveryId,
      p_base_branch: "release/v1",
    });
  });
  it.each([
    { repositoryId: 555, prNumbers: [42] },
    { installationId: 999, repositoryId: 555 },
  ])("ignores uninstalled and tag-only events %j", async (signal) => {
    const { rpc } = buildPrAdmin();
    await handleGitHubVerificationEvent(signal, deliveryId, env);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("propagates queue persistence failure so GitHub retries the delivery", async () => {
    const { rpc } = buildPrAdmin();
    rpc.mockResolvedValue({ data: null, error: new Error("database unavailable") });
    await expect(
      handleGitHubVerificationEvent(
        { installationId: 999, repositoryId: 555, prNumbers: [42] },
        deliveryId,
        env,
      ),
    ).rejects.toThrow("database unavailable");
  });
  it("verifies exact bytes with a real HMAC rather than parsed payload data", async () => {
    const { createHmac } = await import("node:crypto");
    const raw = '{ "sha": "a" }';
    const signature = `sha256=${createHmac("sha256", env.GITHUB_WEBHOOK_SECRET).update(raw).digest("hex")}`;
    await expect(verifyGitHubWebhookRequest(raw, signature, env)).resolves.toBe(true);
    await expect(verifyGitHubWebhookRequest('{"sha":"a"}', signature, env)).resolves.toBe(false);
  });
});

describe("handleGitHubPullRequestEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.getInstallationOctokit.mockResolvedValue({ request: mocked.request });
  });
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
    expect(mocked.request).not.toHaveBeenCalled();
  });

  it.each([
    { label: "reopened", state: "open", draft: false },
    { label: "ready for review", state: "open", draft: false },
    { label: "closed", state: "closed", draft: true },
  ] as const)(
    "reconciles an ambiguous $label tie using a fenced authoritative read",
    async (next) => {
      const { rpc } = buildPrAdmin();
      const operations: string[] = [];
      rpc.mockImplementation(async (name: string) => {
        operations.push(name);
        return {
          data: name === "begin_github_pull_request_observation" ? "token-1" : true,
          error: null,
        } as never;
      });
      mocked.request.mockImplementation(async () => {
        operations.push("GitHub GET");
        return {
          data: {
            ...payload().pull_request,
            base: { repo: { id: 555 } },
            state: next.state,
            draft: next.draft,
          },
        };
      });
      await handleGitHubPullRequestEvent(payload("reopened"), env);
      expect(operations).toEqual([
        "apply_github_pull_request_event",
        "begin_github_pull_request_observation",
        "GitHub GET",
        "finish_github_pull_request_observation",
      ]);
      expect(mocked.getInstallationOctokit).toHaveBeenCalledWith(999);
      expect(mocked.request).toHaveBeenCalledWith("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner: "acme",
        repo: "app",
        pull_number: 42,
      });
      expect(rpc).toHaveBeenCalledWith("finish_github_pull_request_observation", {
        target_workspace_id: "ws-1",
        target_repository_id: "repo-1",
        target_branch_name: "wallie/product-sess-1",
        source_pull_request_number: 42,
        source_pull_request_url: "https://github.com/acme/app/pull/42",
        source_pull_request_state: next.state,
        source_is_draft: next.draft,
        source_updated_at: "2026-10-11T00:00:00Z",
        observation_token: "token-1",
      });
    },
  );

  it.each(["fetch failure", "invalid snapshot", "different PR", "different repository"])(
    "does not finish an observation after %s and propagates the failure for retry",
    async (failure) => {
      const { rpc } = buildPrAdmin();
      rpc.mockImplementation(
        async (name: string) =>
          ({
            data: name === "begin_github_pull_request_observation" ? "token-1" : true,
            error: null,
          }) as never,
      );
      mocked.request.mockImplementation(async () => {
        if (failure === "fetch failure") throw new Error("GitHub unavailable");
        return {
          data: {
            ...payload().pull_request,
            base: { repo: { id: failure === "different repository" ? 556 : 555 } },
            ...(failure === "different PR" ? { number: 43 } : {}),
            ...(failure === "invalid snapshot" ? { updated_at: null } : {}),
          },
        };
      });
      const expectedError =
        failure === "fetch failure"
          ? "GitHub unavailable"
          : failure === "different PR"
            ? "GitHub returned a different pull request."
            : failure === "different repository"
              ? "GitHub returned a different repository."
              : "updated_at";
      await expect(handleGitHubPullRequestEvent(payload("reopened"), env)).rejects.toThrow(
        expectedError,
      );
      expect(rpc.mock.calls.map(([name]) => name)).toEqual([
        "apply_github_pull_request_event",
        "begin_github_pull_request_observation",
      ]);
    },
  );
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
