import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  access: vi.fn(),
  admin: { from: vi.fn(), rpc: vi.fn() },
  github: vi.fn(),
  sandboxCheck: vi.fn(),
  vercel: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => mocked.admin,
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.access,
}));

vi.mock("@/features/github/data", () => ({
  loadWorkspaceGitHubData: mocked.github,
}));

vi.mock("@/lib/vercel-sandbox/server", () => ({
  loadVercelSandboxConnectionPreview: mocked.vercel,
}));

vi.mock("@/lib/sandbox-capabilities/server", () => ({
  getLatestSandboxCapabilityCheck: mocked.sandboxCheck,
}));

import {
  buildWorkspaceOnboardingUpdatePayload,
  loadWorkspaceOnboardingDataForContext,
  normalizeWorkspaceOnboardingUpdatePayload,
  updateWorkspaceOnboardingData,
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

function query(
  result: QueryResult,
  onStart?: () => void,
  onEqual?: (column: string, value: unknown) => void,
) {
  onStart?.();
  const promise = Promise.resolve(result);
  const builder = {
    eq: vi.fn((column: string, value: unknown) => {
      onEqual?.(column, value);
      return builder;
    }),
    in: vi.fn(() => builder),
    limit: vi.fn(() => builder),
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
  pipeline?: unknown;
  routing?: unknown;
  sandboxChecks?: unknown[];
  secrets?: unknown[];
  stageRows?: unknown[];
}) {
  const counts = new Map<string, number>();
  const equalFilters = new Map<string, Array<[string, unknown]>>();
  const increment = (table: string) => counts.set(table, (counts.get(table) ?? 0) + 1);
  const recordEqual = (table: string, column: string, value: unknown) => {
    const filters = equalFilters.get(table) ?? [];
    filters.push([column, value]);
    equalFilters.set(table, filters);
  };
  const memberRow = member(options.memberRole ?? "owner");

  const userRows: Record<string, unknown> = {
    pipeline_stages: options.stageRows ?? [],
    pipelines: options.pipeline ?? null,
    workspace_members: options.memberRows ?? [memberRow],
    workspace_onboarding: onboardingRow(),
  };
  const adminRows: Record<string, unknown> = {
    user_claude_code_credentials: options.claudeCredentials ?? null,
    user_codex_credentials: options.codexCredentials ?? null,
    workspace_agent_config: options.agentConfig ?? [],
    workspace_linear_routing: options.routing ?? null,
  };
  const rpcRows: Record<string, unknown> = {
    load_workspace_onboarding_sandbox_checks: options.sandboxChecks ?? [],
    load_workspace_onboarding_secret_previews: {
      linear_secret:
        options.secrets?.find(
          (secret) =>
            typeof secret === "object" &&
            secret !== null &&
            "key" in secret &&
            secret.key === "LINEAR_API_KEY",
        ) ?? null,
      secret_rows: options.secrets?.slice(0, 1_000) ?? [],
    },
  };

  const supabase = {
    from: vi.fn((table: string) => {
      increment(table);
      return query({ data: userRows[table], error: null }, undefined, (column, value) =>
        recordEqual(table, column, value),
      );
    }),
  };
  mocked.admin.from.mockImplementation((table: string) => {
    increment(table);
    return query({ data: adminRows[table], error: null });
  });
  mocked.admin.rpc.mockImplementation(function (this: unknown, functionName: string) {
    if (this !== mocked.admin) throw new Error("Supabase RPC client receiver was lost.");
    increment(functionName);
    return Promise.resolve({ data: rpcRows[functionName], error: null });
  });

  return {
    context: { currentMember: memberRow, supabase, user, workspace },
    counts,
    equalFilters,
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
    const pipeline = {
      id: "pipeline-default",
      is_default: true,
      name: "Default",
      operating_rules_md: "",
    };
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
      pipeline,
      secrets: [linearSecret],
      stageRows: [
        {
          approver_member_ids: [],
          description: null,
          id: "stage-plan",
          name: "Plan",
          pipeline_id: pipeline.id,
          position: 1,
          prompt_template_md: "Plan {{session.title}}",
          slug: "plan",
        },
      ],
    });

    const result = await loadWorkspaceOnboardingDataForContext(fixture.context as never);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.canManage).toBe(true);
    expect(result.data.linearSecret?.valuePreview).toBe("lin_…1234");
    expect(result.data.workspaceSecrets).toHaveLength(1);
    expect(result.data.setupHealth.agentConfig.status).toBe("present");
    expect(result.data.setupHealth.defaultPipeline.status).toBe("ready");
    expect(result.data.setupHealth.codexConnection.status).toBe("connected");
    expect(result.data.setupHealth.claudeCodeConnection.status).toBe("missing");
    expect(result.data.setupHealth.codexConnection.checkedAt).toMatch(/Z$/);
    expect(result.data.setupHealth.claudeCodeConnection.checkedAt).toBe(
      result.data.setupHealth.codexConnection.checkedAt,
    );

    for (const table of [
      "workspace_onboarding",
      "pipelines",
      "pipeline_stages",
      "workspace_members",
      "workspace_linear_routing",
      "workspace_agent_config",
      "user_codex_credentials",
      "user_claude_code_credentials",
      "load_workspace_onboarding_secret_previews",
      "load_workspace_onboarding_sandbox_checks",
    ]) {
      expect(fixture.counts.get(table), table).toBe(1);
    }
    expect(mocked.github).toHaveBeenCalledTimes(1);
    expect(mocked.vercel).toHaveBeenCalledTimes(1);
  });

  it("uses the selected repository's latest bounded sandbox check", async () => {
    const selectedRepositoryId = "11111111-1111-4111-8111-111111111111";
    const otherRepositoryId = "22222222-2222-4222-8222-222222222222";
    const fixture = createFixture({
      memberRole: "owner",
      sandboxChecks: [
        {
          capabilities: {},
          checked_at: "2026-07-17T12:05:00.000Z",
          error_text: null,
          github_repository_id: otherRepositoryId,
          id: "check-other",
          sandbox_provider: "vercel",
          sandbox_vercel_project_id: "project-other",
          sandbox_vercel_team_id: "team-other",
          status: "success",
        },
        {
          capabilities: {},
          checked_at: "2026-07-17T12:00:00.000Z",
          error_text: null,
          github_repository_id: selectedRepositoryId,
          id: "check-selected",
          sandbox_provider: "vercel",
          sandbox_vercel_project_id: "project-selected",
          sandbox_vercel_team_id: "team-selected",
          status: "success",
        },
      ],
    });
    mocked.github.mockResolvedValue({
      ...freshGithub(),
      primaryProfile: {
        buildCommand: null,
        createdAt: NOW,
        envKeySuggestions: [],
        frameworkHints: [],
        githubRepositoryId: selectedRepositoryId,
        id: "profile-1",
        inferenceConfidence: "high",
        inferenceSources: [],
        installCommand: null,
        isPrimary: true,
        languageHints: [],
        packageManager: null,
        setupNotes: "",
        testCommand: null,
        updatedAt: NOW,
        workspaceId: workspace.id,
      },
      repositories: [
        {
          defaultBranch: "main",
          defaultProgrammingLanguage: "TypeScript",
          description: null,
          fullName: "northwind/app",
          htmlUrl: "https://github.com/northwind/app",
          id: selectedRepositoryId,
          isArchived: false,
          isPrivate: true,
          name: "app",
          onboarding: {
            conflictReport: [],
            githubRepositoryId: selectedRepositoryId,
            installedSkillHash: null,
            installedSkillVersion: null,
            lastError: null,
            setupBranchName: null,
            setupPrNumber: null,
            setupPrUrl: null,
            status: "ready",
            updatedAt: NOW,
          },
          profile: null,
          repoId: 1,
        },
      ],
    });

    const result = await loadWorkspaceOnboardingDataForContext(fixture.context as never);

    expect(result).toMatchObject({
      data: {
        setupHealth: {
          latestSandboxCapabilityCheck: {
            githubRepositoryId: selectedRepositoryId,
            id: "check-selected",
          },
        },
      },
      ok: true,
    });
    expect(fixture.counts.get("load_workspace_onboarding_sandbox_checks")).toBe(1);
  });

  it("scopes the stage snapshot to the default pipeline before the row cap", async () => {
    const pipeline = {
      id: "pipeline-default",
      is_default: true,
      name: "Default",
      operating_rules_md: "",
    };
    const fixture = createFixture({
      memberRole: "owner",
      pipeline,
      stageRows: [
        {
          approver_member_ids: [],
          description: null,
          id: "stage-plan",
          name: "Plan",
          pipeline_id: pipeline.id,
          position: 1,
          prompt_template_md: "Plan {{session.title}}",
          slug: "plan",
        },
      ],
    });

    const result = await loadWorkspaceOnboardingDataForContext(fixture.context as never);

    expect(result).toMatchObject({
      data: {
        pipeline: {
          id: pipeline.id,
          stages: [{ id: "stage-plan" }],
        },
        setupHealth: {
          defaultPipeline: { stageCount: 1, status: "ready" },
        },
      },
      ok: true,
    });
    expect(fixture.equalFilters.get("pipeline_stages")).toEqual([
      ["workspace_id", workspace.id],
      ["pipeline_id", pipeline.id],
    ]);
    expect(fixture.counts.get("pipeline_stages")).toBe(1);
  });

  it("keeps the targeted Linear secret beyond a normal PostgREST row cap", async () => {
    const linearSecret = {
      created_at: NOW,
      created_by_member_id: "member-owner",
      id: "secret-linear",
      key: "LINEAR_API_KEY",
      updated_at: NOW,
      value_preview: "lin_…1234",
      workspace_id: workspace.id,
    };
    const fixture = createFixture({
      memberRole: "owner",
      secrets: [
        ...Array.from({ length: 1_001 }, (_, index) => ({
          ...linearSecret,
          id: `secret-${index}`,
          key: `A_${String(index).padStart(4, "0")}`,
        })),
        linearSecret,
      ],
    });

    const result = await loadWorkspaceOnboardingDataForContext(fixture.context as never);

    expect(result).toMatchObject({
      data: {
        linearSecret: { id: "secret-linear" },
        setupHealth: { linearKey: { status: "present" } },
      },
      ok: true,
    });
    expect(fixture.counts.get("load_workspace_onboarding_secret_previews")).toBe(1);
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
    expect(fixture.equalFilters.get("pipeline_stages")).toContainEqual([
      "pipeline_id",
      "00000000-0000-0000-0000-000000000000",
    ]);
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
    expect(fixture.counts.get("load_workspace_onboarding_secret_previews")).toBe(1);
    expect(fixture.counts.get("load_workspace_onboarding_sandbox_checks")).toBe(1);
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

describe("updateWorkspaceOnboardingData", () => {
  beforeEach(() => {
    mocked.sandboxCheck.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns a minimal delta without rebuilding the workspace snapshot", async () => {
    const currentRow = onboardingRow();
    const updatedRow = {
      ...currentRow,
      completed_steps: ["github"],
      current_step: "repository",
      status: "in_progress",
      updated_at: "2026-07-17T12:01:00.000Z",
    };
    const readQuery = {
      eq() {
        return this;
      },
      select() {
        return this;
      },
      single: async () => ({ data: currentRow, error: null }),
    };
    const updateQuery = {
      eq() {
        return this;
      },
      maybeSingle: async () => ({ data: updatedRow, error: null }),
      select() {
        return this;
      },
      update() {
        return this;
      },
    };
    const supabase = {
      from: vi.fn().mockReturnValueOnce(readQuery).mockReturnValueOnce(updateQuery),
    };
    mocked.access.mockResolvedValue({
      context: { supabase, workspace },
      ok: true,
    });

    const result = await updateWorkspaceOnboardingData(workspace.id, {
      action: "continue",
      changes: {
        completedSteps: ["github"],
        currentStep: "repository",
        status: "in_progress",
      },
      expectedUpdatedAt: NOW,
      step: "github",
    });

    expect(result).toEqual({
      data: {
        action: "continue",
        kind: "onboarding-mutation",
        onboarding: {
          completedAt: null,
          completedSteps: ["github"],
          currentStep: "repository",
          dismissedAt: null,
          selectedGithubRepositoryId: null,
          skippedSteps: [],
          status: "in_progress",
        },
        setupHealth: {},
        step: "github",
        updatedAt: "2026-07-17T12:01:00.000Z",
        validationErrors: [],
      },
      ok: true,
    });
    expect(mocked.github).not.toHaveBeenCalled();
    expect(mocked.admin.from).not.toHaveBeenCalled();
    expect(supabase.from).toHaveBeenCalledTimes(2);
  });

  it("rejects a stale expected version before updating", async () => {
    const currentRow = { ...onboardingRow(), updated_at: "2026-07-17T12:02:00.000Z" };
    const readQuery = {
      eq() {
        return this;
      },
      select() {
        return this;
      },
      single: async () => ({ data: currentRow, error: null }),
    };
    const supabase = { from: vi.fn(() => readQuery) };
    mocked.access.mockResolvedValue({ context: { supabase, workspace }, ok: true });

    const result = await updateWorkspaceOnboardingData(workspace.id, {
      action: "navigate",
      changes: { currentStep: "repository", status: "in_progress" },
      expectedUpdatedAt: NOW,
      step: "repository",
    });

    expect(result).toMatchObject({
      conflict: {
        authoritative: { updatedAt: "2026-07-17T12:02:00.000Z" },
        kind: "onboarding-conflict",
        retryable: true,
      },
      ok: false,
      status: 409,
    });
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it("restores authoritative repository health for a stale non-repository action", async () => {
    const selectedRepositoryId = "11111111-1111-4111-8111-111111111111";
    const currentRow = {
      ...onboardingRow(),
      selected_github_repository_id: selectedRepositoryId,
      updated_at: "2026-07-17T12:02:00.000Z",
    };
    const readQuery = {
      eq() {
        return this;
      },
      select() {
        return this;
      },
      single: async () => ({ data: currentRow, error: null }),
    };
    const supabase = { from: vi.fn(() => readQuery) };
    mocked.access.mockResolvedValue({ context: { supabase, workspace }, ok: true });
    mocked.admin.from.mockImplementation((table: string) => {
      if (table === "github_repositories") {
        return query({
          data: { full_name: "northwind/app", id: selectedRepositoryId, is_archived: false },
          error: null,
        });
      }
      if (table === "workspace_repository_profiles") {
        return query({ data: { github_repository_id: selectedRepositoryId }, error: null });
      }
      if (table === "repository_onboarding_status") {
        return query({
          data: { github_repository_id: selectedRepositoryId, status: "ready" },
          error: null,
        });
      }
      throw new Error(`Unexpected table: ${table}`);
    });
    mocked.sandboxCheck.mockResolvedValue({
      capabilities: {},
      checkedAt: "2026-07-17T11:00:00.000Z",
      errorText: null,
      githubRepositoryId: selectedRepositoryId,
      id: "check-selected",
      sandboxProvider: "vercel",
      sandboxVercelProjectId: "project-selected",
      sandboxVercelTeamId: "team-selected",
      status: "success",
    });

    const result = await updateWorkspaceOnboardingData(workspace.id, {
      action: "navigate",
      changes: { currentStep: "linear", status: "in_progress" },
      expectedUpdatedAt: NOW,
      step: "linear",
    });

    expect(result).toMatchObject({
      conflict: {
        action: "navigate",
        authoritative: {
          onboarding: { selectedGithubRepositoryId: selectedRepositoryId },
          setupHealth: {
            latestSandboxCapabilityCheck: { id: "check-selected" },
            primaryRepositoryProfile: { repositoryId: selectedRepositoryId, status: "ready" },
            repositorySetup: { repositoryId: selectedRepositoryId, status: "ready" },
            selectedRepository: { repositoryId: selectedRepositoryId, status: "ready" },
          },
        },
      },
      ok: false,
      status: 409,
    });
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
