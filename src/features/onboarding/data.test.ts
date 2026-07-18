import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  admin: { from: vi.fn() },
  github: vi.fn(),
  vercel: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => mocked.admin,
}));

vi.mock("@/features/github/data", () => ({
  loadWorkspaceGitHubData: mocked.github,
}));

vi.mock("@/lib/vercel-sandbox/server", () => ({
  loadVercelSandboxConnectionPreview: mocked.vercel,
}));

import {
  buildWorkspaceOnboardingUpdatePayload,
  loadWorkspaceOnboardingDataForContext,
  normalizeWorkspaceOnboardingUpdatePayload,
} from "@/features/onboarding/data";

const NOW = "2026-07-17T12:00:00.000Z";
const workspace = {
  avatar_path: null,
  id: "workspace-1",
  name: "Northwind",
  slug: "northwind",
};
const user = { id: "user-1" };

type QueryResult = { data: unknown; error: null };

function query(result: QueryResult, onStart?: () => void, onLimit?: (count: number) => void) {
  onStart?.();
  const promise = Promise.resolve(result);
  const builder = {
    eq: vi.fn(() => builder),
    in: vi.fn(() => builder),
    limit: vi.fn((count: number) => {
      onLimit?.(count);
      return builder;
    }),
    maybeSingle: vi.fn(() => promise),
    order: vi.fn(() => builder),
    select: vi.fn(() => builder),
    single: vi.fn(() => promise),
    then: promise.then.bind(promise),
  };
  return builder;
}

function onboardingRow() {
  return {
    completed_at: null,
    completed_steps: [],
    created_at: NOW,
    current_step: "github",
    dismissed_at: null,
    id: "onboarding-1",
    selected_github_repository_id: null,
    skipped_steps: [],
    status: "not_started",
    updated_at: NOW,
    workspace_id: workspace.id,
  };
}

function member(role: "member" | "owner") {
  return {
    email: `${role}@example.com`,
    full_name: role === "owner" ? "Owner" : "Member",
    id: `member-${role}`,
    is_active: true,
    kind: "human",
    role,
    user_id: user.id,
  };
}

function freshGithub() {
  return {
    installation: null,
    missingAppKeys: [],
    missingWebhookKeys: [],
    primaryProfile: null,
    repositories: [],
  };
}

function createFixture(options: {
  agentConfig?: unknown[];
  claudeCredentials?: unknown;
  codexCredentials?: unknown;
  memberRole?: "member" | "owner";
  memberRows?: unknown[];
  routing?: unknown;
  secrets?: unknown[];
}) {
  const counts = new Map<string, number>();
  const limits = new Map<string, number>();
  const increment = (table: string) => counts.set(table, (counts.get(table) ?? 0) + 1);
  const memberRow = member(options.memberRole ?? "owner");

  const userRows: Record<string, unknown> = {
    pipeline_stages: [],
    pipelines: null,
    workspace_members: options.memberRows ?? [memberRow],
    workspace_onboarding: onboardingRow(),
  };
  const adminRows: Record<string, unknown> = {
    sandbox_capability_checks: [],
    user_claude_code_credentials: options.claudeCredentials ?? null,
    user_codex_credentials: options.codexCredentials ?? null,
    workspace_agent_config: options.agentConfig ?? [],
    workspace_linear_routing: options.routing ?? null,
    workspace_secrets: options.secrets ?? [],
  };

  const supabase = {
    from: vi.fn((table: string) => {
      increment(table);
      return query({ data: userRows[table], error: null });
    }),
  };
  mocked.admin.from.mockImplementation((table: string) => {
    increment(table);
    return query({ data: adminRows[table], error: null }, undefined, (count) => {
      limits.set(table, count);
    });
  });

  return {
    context: { currentMember: memberRow, supabase, user, workspace },
    counts,
    limits,
  };
}

describe("canonical onboarding snapshot", () => {
  beforeEach(() => {
    mocked.github.mockResolvedValue(freshGithub());
    mocked.vercel.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("queries every onboarding source once for an owner and derives partial provider state", async () => {
    const linearSecret = {
      created_at: NOW,
      created_by_member_id: "member-owner",
      id: "secret-1",
      key: "LINEAR_API_KEY",
      updated_at: NOW,
      value_preview: "lin_…1234",
      workspace_id: workspace.id,
    };
    const fixture = createFixture({
      agentConfig: [{ key: "agent_provider", value_json: "codex" }],
      codexCredentials: {
        access_token_expires_at: "2099-01-01T00:00:00.000Z",
        auth_reconnect_required: false,
        credential_type: "platform_api_key",
        updated_at: NOW,
      },
      memberRole: "owner",
      secrets: [linearSecret],
    });

    const result = await loadWorkspaceOnboardingDataForContext(fixture.context as never);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.canManage).toBe(true);
    expect(result.data.linearSecret?.valuePreview).toBe("lin_…1234");
    expect(result.data.workspaceSecrets).toHaveLength(1);
    expect(result.data.setupHealth.agentConfig.status).toBe("present");
    expect(result.data.setupHealth.codexConnection.status).toBe("connected");
    expect(result.data.setupHealth.claudeCodeConnection.status).toBe("missing");

    for (const table of [
      "workspace_onboarding",
      "pipelines",
      "pipeline_stages",
      "workspace_members",
      "workspace_secrets",
      "workspace_linear_routing",
      "workspace_agent_config",
      "user_codex_credentials",
      "user_claude_code_credentials",
      "sandbox_capability_checks",
    ]) {
      expect(fixture.counts.get(table), table).toBe(1);
    }
    expect(mocked.github).toHaveBeenCalledTimes(1);
    expect(mocked.vercel).toHaveBeenCalledTimes(1);
    expect(fixture.limits.get("sandbox_capability_checks")).toBe(1);
  });

  it("uses authenticated member access even when the capped display list omits that member", async () => {
    const fixture = createFixture({
      memberRole: "member",
      memberRows: [
        {
          ...member("owner"),
          user_id: "another-user",
        },
      ],
    });

    const result = await loadWorkspaceOnboardingDataForContext(fixture.context as never);

    expect(result).toMatchObject({
      data: {
        canManage: false,
        currentMember: { id: "member-member", role: "member" },
        workspaceMembers: [{ id: "member-owner" }],
      },
      ok: true,
    });
    expect(fixture.counts.get("workspace_members")).toBe(1);
  });

  it("preserves fresh workspace and missing-credential semantics for a member", async () => {
    const fixture = createFixture({
      memberRole: "member",
      secrets: [
        {
          created_at: NOW,
          created_by_member_id: "member-owner",
          id: "secret-1",
          key: "LINEAR_API_KEY",
          updated_at: NOW,
          value_preview: "lin_…1234",
          workspace_id: workspace.id,
        },
      ],
    });

    const result = await loadWorkspaceOnboardingDataForContext(fixture.context as never);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.canManage).toBe(false);
    expect(result.data.linearSecret).toBeNull();
    expect(result.data.workspaceSecrets).toEqual([]);
    expect(result.data.setupHealth.linearKey.status).toBe("present");
    expect(result.data.setupHealth.workspaceSecrets.configuredKeys).toEqual([]);
    expect(result.data.setupHealth.defaultPipeline.status).toBe("missing");
    expect(result.data.setupHealth.githubInstallation.status).toBe("missing");
    expect(result.data.setupHealth.codexConnection.status).toBe("missing");
    expect(result.data.setupHealth.claudeCodeConnection.status).toBe("missing");
  });

  it("starts independent snapshot sources before GitHub resolves", async () => {
    let resolveGithub: ((value: ReturnType<typeof freshGithub>) => void) | undefined;
    mocked.github.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGithub = resolve;
        }),
    );
    const fixture = createFixture({ memberRole: "owner" });

    const pending = loadWorkspaceOnboardingDataForContext(fixture.context as never);
    await Promise.resolve();

    expect(fixture.counts.get("pipelines")).toBe(1);
    expect(fixture.counts.get("workspace_secrets")).toBe(1);
    expect(fixture.counts.get("sandbox_capability_checks")).toBe(1);
    expect(mocked.vercel).toHaveBeenCalledTimes(1);

    resolveGithub?.(freshGithub());
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it("reports named snapshot phases around one concurrent critical path", async () => {
    const previousTimingLogs = process.env.WALLIE_TIMING_LOGS;
    process.env.WALLIE_TIMING_LOGS = "1";
    const timingLog = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fixture = createFixture({ memberRole: "owner" });

    try {
      await loadWorkspaceOnboardingDataForContext(fixture.context as never);
    } finally {
      if (previousTimingLogs === undefined) delete process.env.WALLIE_TIMING_LOGS;
      else process.env.WALLIE_TIMING_LOGS = previousTimingLogs;
    }

    const snapshotLog = timingLog.mock.calls
      .map((call) => call[1] as { name?: string; segments?: Array<{ name: string }> })
      .find((entry) => entry.name === "onboarding.snapshot");
    expect(snapshotLog?.segments?.map((segment) => segment.name)).toEqual(
      expect.arrayContaining([
        "snapshot.onboarding",
        "snapshot.github",
        "snapshot.pipeline",
        "snapshot.stages",
        "snapshot.secrets",
        "snapshot.routing",
        "snapshot.agent-config",
        "snapshot.providers",
        "snapshot.sandbox",
        "snapshot.vercel",
        "snapshot.members",
      ]),
    );
  });
});

describe("buildWorkspaceOnboardingUpdatePayload", () => {
  const now = new Date("2026-05-16T18:00:00.000Z");

  it("sets completion metadata and clears dismissal metadata when completing setup", () => {
    expect(
      buildWorkspaceOnboardingUpdatePayload(
        {
          completedSteps: ["github", "repository", "pipeline", "linear", "runtime", "verify"],
          currentStep: "verify",
          status: "completed",
        },
        now,
      ),
    ).toEqual({
      completed_at: "2026-05-16T18:00:00.000Z",
      completed_steps: ["github", "repository", "pipeline", "linear", "runtime", "verify"],
      current_step: "verify",
      dismissed_at: null,
      status: "completed",
    });
  });

  it("clears dismissal metadata when resuming setup", () => {
    expect(buildWorkspaceOnboardingUpdatePayload({ status: "in_progress" }, now)).toEqual({
      dismissed_at: null,
      status: "in_progress",
    });
  });

  it("records dismissal metadata when dismissing setup", () => {
    expect(buildWorkspaceOnboardingUpdatePayload({ status: "dismissed" }, now)).toEqual({
      dismissed_at: "2026-05-16T18:00:00.000Z",
      status: "dismissed",
    });
  });

  it("persists selected repository changes", () => {
    expect(
      buildWorkspaceOnboardingUpdatePayload(
        { selectedGithubRepositoryId: "11111111-1111-4111-8111-111111111111" },
        now,
      ),
    ).toEqual({
      selected_github_repository_id: "11111111-1111-4111-8111-111111111111",
    });
  });
});

describe("normalizeWorkspaceOnboardingUpdatePayload", () => {
  function updateQuery(result: { data: unknown; error: unknown }) {
    return {
      eq() {
        return this;
      },
      maybeSingle: async () => result,
      select() {
        return this;
      },
    };
  }

  function adminWithPrimaryRepository(repositoryId: string) {
    return {
      from(table: string) {
        if (table === "github_repositories") {
          return updateQuery({ data: { id: repositoryId, is_archived: false }, error: null });
        }
        if (table === "workspace_repository_profiles") {
          return updateQuery({ data: { github_repository_id: repositoryId }, error: null });
        }
        throw new Error(`Unexpected table: ${table}`);
      },
    };
  }

  it("preserves dependent-step progress when selecting the effective fallback repository", async () => {
    const repositoryId = "11111111-1111-4111-8111-111111111111";
    const result = await normalizeWorkspaceOnboardingUpdatePayload({
      admin: adminWithPrimaryRepository(repositoryId) as never,
      currentRow: {
        completed_steps: ["github", "repository", "pipeline", "runtime", "verify"],
        selected_github_repository_id: null,
        skipped_steps: ["linear"],
        status: "completed",
      } as never,
      payload: {
        completedSteps: ["github", "pipeline"],
        selectedGithubRepositoryId: repositoryId,
        skippedSteps: [],
        status: "in_progress",
      },
      workspaceId: "workspace-1",
    });

    expect(result).toEqual({
      ok: true,
      payload: {
        completedSteps: ["github", "repository", "pipeline", "runtime", "verify"],
        selectedGithubRepositoryId: repositoryId,
        skippedSteps: ["linear"],
        status: "completed",
      },
    });
  });
});
