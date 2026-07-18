import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  createWorkspaceOnboardingSnapshot: vi.fn(),
  loadAuthenticatedWorkspaceContext: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("not-found");
  }),
  timingNames: [] as string[],
}));

vi.mock("next/navigation", () => ({ notFound: mocked.notFound }));

vi.mock("@/features/onboarding/data", () => ({
  createWorkspaceOnboardingSnapshot: mocked.createWorkspaceOnboardingSnapshot,
}));

vi.mock("@/features/workspaces/authenticated-context", () => ({
  loadAuthenticatedWorkspaceContext: mocked.loadAuthenticatedWorkspaceContext,
}));

vi.mock("@/lib/rate-limit", () => ({
  describeRateLimits: () => [
    { description: "Paid calls", endpoint: "agent", max: 4, windowMs: 60_000 },
  ],
}));

vi.mock("@/lib/server-timing", () => ({
  approximatePayloadSizeBytes: () => 1,
  withServerTiming: async (
    name: string,
    _metadata: unknown,
    operation: (timing: {
      segment<T>(segmentName: string, segmentOperation: () => PromiseLike<T> | T): Promise<T>;
    }) => Promise<unknown>,
  ) => {
    mocked.timingNames.push(name);
    return operation({
      async segment<T>(_segmentName: string, segmentOperation: () => PromiseLike<T> | T) {
        return segmentOperation();
      },
    });
  },
}));

vi.mock("@/lib/storage/workspace-avatar", () => ({
  getWorkspaceAvatarUrl: (path: string | null) => (path ? `https://cdn.example.com/${path}` : null),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

import { loadSettingsPageData, mapWorkspaceUsageRow } from "@/features/settings/data";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const user = { id: "user-1" };
const workspace = {
  avatar_path: "workspace/avatar.png",
  id: "workspace-1",
  name: "Northwind",
  slug: "northwind",
};
const github = {
  installation: null,
  missingAppKeys: [],
  missingWebhookKeys: [],
  primaryProfile: null,
  repositories: [],
};

function onboardingData(role: "admin" | "member" | "owner") {
  return {
    agentConfig: {},
    canManage: role === "admin" || role === "owner",
    currentMember: { id: "member-1", role },
    github,
    latestSandboxCapabilityCheck: null,
    linearRouting: {},
    linearSecret: null,
    onboarding: {},
    pipeline: null,
    setupHealth: { latestSandboxCapabilityCheck: null },
    vercelSandboxConnection: null,
    workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
    workspaceMembers: [],
    workspaceSecrets: [],
  } as never;
}

function buildSupabase(input: {
  member: {
    id: string;
    is_active: boolean;
    kind: "human" | "system";
    role: "admin" | "member" | "owner";
  } | null;
  usageResult: Promise<{ data: unknown; error: unknown }>;
}) {
  const usageMaybeSingle = vi.fn(() => input.usageResult);
  const supabase = {
    from: vi.fn((table: string) => {
      throw new Error(`Unexpected duplicate Settings query: ${table}`);
    }),
    rpc: vi.fn(() => ({ maybeSingle: usageMaybeSingle })),
  };

  return { currentMember: input.member, supabase, usageMaybeSingle };
}

function buildAdmin(invitationResult: Promise<{ data: unknown[]; error: unknown }>) {
  return {
    from: vi.fn((table: string) => {
      if (table !== "workspace_invitations") throw new Error(`Unexpected table: ${table}`);
      return {
        eq() {
          return this;
        },
        order: vi.fn(() => invitationResult),
        select() {
          return this;
        },
      };
    }),
  };
}

describe("loadSettingsPageData", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocked.timingNames.length = 0;
  });

  it("reuses one authenticated access context and lets the first section resolve independently", async () => {
    const githubResult = deferred<typeof github>();
    const setupResult = deferred<ReturnType<typeof onboardingData>>();
    const usageResult = deferred<{ data: unknown; error: unknown }>();
    const invitationResult = deferred<{ data: unknown[]; error: unknown }>();
    const { currentMember, supabase } = buildSupabase({
      member: { id: "member-1", is_active: true, kind: "human", role: "owner" },
      usageResult: usageResult.promise,
    });
    const admin = buildAdmin(invitationResult.promise);

    mocked.loadAuthenticatedWorkspaceContext.mockResolvedValue({
      currentMember,
      supabase,
      user,
      workspace,
    });
    mocked.createSupabaseAdminClient.mockReturnValue(admin);
    mocked.createWorkspaceOnboardingSnapshot.mockReturnValue({
      data: setupResult.promise,
      github: githubResult.promise,
    });

    const loader = await loadSettingsPageData(workspace.slug);
    let setupSettled = false;
    let usageSettled = false;
    let invitationsSettled = false;
    void loader.setupData.then(() => {
      setupSettled = true;
    });
    void loader.usage.then(() => {
      usageSettled = true;
    });
    void loader.workspaceInvitations.then(() => {
      invitationsSettled = true;
    });

    githubResult.resolve(github);

    await expect(loader.initialData).resolves.toMatchObject({
      canManage: true,
      currentMember: { id: "member-1", role: "owner" },
      github,
      workspace: { id: workspace.id, slug: workspace.slug },
    });
    expect(setupSettled).toBe(false);
    expect(usageSettled).toBe(false);
    expect(invitationsSettled).toBe(false);
    expect(mocked.loadAuthenticatedWorkspaceContext).toHaveBeenCalledTimes(1);
    expect(supabase.from).not.toHaveBeenCalled();
    expect(mocked.createWorkspaceOnboardingSnapshot).toHaveBeenCalledTimes(1);
    expect(mocked.createWorkspaceOnboardingSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ currentMember: expect.any(Object), supabase, user, workspace }),
    );
    expect(supabase.rpc).toHaveBeenCalledWith("get_workspace_usage", {
      target_workspace_id: workspace.id,
    });
    expect(mocked.timingNames).toEqual([
      "settings.loader",
      "settings.section.github",
      "settings.section.setup",
      "settings.section.usage",
      "settings.section.invitations",
    ]);

    setupResult.resolve(onboardingData("owner"));
    usageResult.resolve({
      data: {
        total_cost_usd: 1.25,
        total_input_tokens: 120,
        total_output_tokens: 30,
        total_runs: 2,
      },
      error: null,
    });
    invitationResult.resolve({ data: [], error: null });
    await Promise.all([loader.setupData, loader.usage, loader.workspaceInvitations]);
  });

  it("preserves member visibility by skipping privileged invitation loading", async () => {
    const { currentMember, supabase } = buildSupabase({
      member: { id: "member-1", is_active: true, kind: "human", role: "member" },
      usageResult: Promise.resolve({
        data: {
          total_cost_usd: 0,
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_runs: 0,
        },
        error: null,
      }),
    });
    mocked.loadAuthenticatedWorkspaceContext.mockResolvedValue({
      currentMember,
      supabase,
      user,
      workspace,
    });
    mocked.createWorkspaceOnboardingSnapshot.mockReturnValue({
      data: Promise.resolve(onboardingData("member")),
      github: Promise.resolve(github),
    });

    const loader = await loadSettingsPageData(workspace.slug);

    await expect(loader.workspaceInvitations).resolves.toEqual([]);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
    await Promise.all([loader.initialData, loader.setupData, loader.usage]);
  });

  it("observes below-fold failures before the above-fold section resolves", async () => {
    const githubResult = deferred<typeof github>();
    const usageResult = deferred<{ data: unknown; error: unknown }>();
    const { currentMember, supabase } = buildSupabase({
      member: { id: "member-1", is_active: true, kind: "human", role: "member" },
      usageResult: usageResult.promise,
    });
    mocked.loadAuthenticatedWorkspaceContext.mockResolvedValue({
      currentMember,
      supabase,
      user,
      workspace,
    });
    mocked.createWorkspaceOnboardingSnapshot.mockReturnValue({
      data: Promise.resolve(onboardingData("member")),
      github: githubResult.promise,
    });
    const unhandledRejection = vi.fn();
    process.on("unhandledRejection", unhandledRejection);

    try {
      const loader = await loadSettingsPageData(workspace.slug);
      usageResult.reject(new Error("usage unavailable"));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandledRejection).not.toHaveBeenCalled();

      githubResult.resolve(github);
      await expect(loader.initialData).resolves.toMatchObject({ github });
      await expect(loader.usage).rejects.toThrow("usage unavailable");
    } finally {
      process.off("unhandledRejection", unhandledRejection);
    }
  });

  it("rejects inactive memberships before starting setup or below-fold queries", async () => {
    const { currentMember, supabase } = buildSupabase({
      member: { id: "member-1", is_active: false, kind: "human", role: "member" },
      usageResult: Promise.resolve({ data: null, error: null }),
    });
    mocked.loadAuthenticatedWorkspaceContext.mockResolvedValue({
      currentMember,
      supabase,
      user,
      workspace,
    });

    await expect(loadSettingsPageData(workspace.slug)).rejects.toThrow("not-found");
    expect(mocked.createWorkspaceOnboardingSnapshot).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});

describe("mapWorkspaceUsageRow", () => {
  it("matches the previous JavaScript reduction totals", () => {
    const successfulRuns = [
      { input_tokens: 120, output_tokens: 30, total_cost_usd: 0.75 },
      { input_tokens: null, output_tokens: 20, total_cost_usd: null },
      { input_tokens: 80, output_tokens: null, total_cost_usd: 0.5 },
    ];
    const previousTotals = successfulRuns.reduce(
      (totals, run) => ({
        totalCostUsd: totals.totalCostUsd + (run.total_cost_usd ?? 0),
        totalInputTokens: totals.totalInputTokens + (run.input_tokens ?? 0),
        totalOutputTokens: totals.totalOutputTokens + (run.output_tokens ?? 0),
        totalRuns: totals.totalRuns + 1,
      }),
      { totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, totalRuns: 0 },
    );

    expect(
      mapWorkspaceUsageRow({
        total_cost_usd: 1.25,
        total_input_tokens: 200,
        total_output_tokens: 50,
        total_runs: 3,
      }),
    ).toEqual(previousTotals);
    expect(mapWorkspaceUsageRow(null)).toEqual({
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalRuns: 0,
    });
  });
});
