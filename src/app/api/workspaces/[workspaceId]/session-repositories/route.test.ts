import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  loadActiveFactoryExecution: vi.fn(),
  loadBrowserSessionFactories: vi.fn(),
  loadDefaultPipelineForWorkspace: vi.fn(),
  loadSessionRepositoryOptionsWithPrimary: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
}));

vi.mock("@/lib/factory-definitions/runtime-definition", () => ({
  loadActiveFactoryExecution: mocked.loadActiveFactoryExecution,
}));

vi.mock("@/lib/sessions/browser-factory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sessions/browser-factory")>()),
  loadBrowserSessionFactories: mocked.loadBrowserSessionFactories,
}));

vi.mock("@/features/sessions/repository-options", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/sessions/repository-options")>();
  return {
    ...actual,
    loadSessionRepositoryOptionsWithPrimary: mocked.loadSessionRepositoryOptionsWithPrimary,
  };
});

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

vi.mock("@/lib/pipeline/stages", () => ({
  loadDefaultPipelineForWorkspace: mocked.loadDefaultPipelineForWorkspace,
}));

import { GET } from "./route";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const DEFAULT_FACTORY_ID = "00000000-0000-4000-8000-000000000009";
const BENCH_FACTORY_ID = "00000000-0000-4000-8000-000000000010";

function routeContext(workspaceId = WORKSPACE_ID) {
  return { params: Promise.resolve({ workspaceId }) };
}

function grantAccess(
  selectedGithubRepositoryId: string | null = "repo-selected",
  role: "admin" | "member" = "member",
) {
  const onboardingQuery = {
    eq: vi.fn(() => onboardingQuery),
    maybeSingle: vi.fn(async () => ({
      data: { selected_github_repository_id: selectedGithubRepositoryId },
      error: null,
    })),
    select: vi.fn(() => onboardingQuery),
  };
  const supabase = { from: vi.fn<(table: string) => unknown>(() => onboardingQuery) };
  mocked.requireWorkspaceAccessById.mockResolvedValue({
    context: {
      currentMember: { id: "member-id", kind: "human", is_active: true, role },
      supabase,
      user: { id: "user-1" },
      workspace: { id: WORKSPACE_ID, name: "Wallie", slug: "wallie" },
    },
    ok: true,
  });
  return supabase;
}

describe("session repositories route", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  beforeEach(() => {
    mocked.loadActiveFactoryExecution.mockResolvedValue(null);
    mocked.loadBrowserSessionFactories
      .mockReset()
      .mockResolvedValue([
        { id: DEFAULT_FACTORY_ID, isDefault: true, name: "Default factory", status: "active" },
      ]);
    mocked.loadDefaultPipelineForWorkspace.mockResolvedValue({
      id: "pipeline-1",
      isDefault: true,
      name: "Default",
      operatingRulesMd: "",
      stages: [
        {
          anyoneCanApprove: true,
          approverMemberIds: [],
          description: "Plan the work",
          id: "stage-1",
          name: "Plan",
          pipelineId: "pipeline-1",
          position: 1,
          promptTemplateMd: "",
          slug: "plan",
        },
      ],
    });
  });

  it("returns options and derives the default without another repository lookup", async () => {
    const supabase = grantAccess();
    mocked.loadSessionRepositoryOptionsWithPrimary.mockResolvedValue({
      primaryGithubRepositoryId: "repo-primary",
      repositoryOptions: [
        { fullName: "acme/primary", id: "repo-primary" },
        { fullName: "acme/selected", id: "repo-selected" },
      ],
    });

    const response = await GET(new Request("http://localhost"), routeContext());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      defaultGithubRepositoryId: "repo-primary",
      pipelineId: "pipeline-1",
      repositoryOptions: [
        { fullName: "acme/primary", id: "repo-primary" },
        { fullName: "acme/selected", id: "repo-selected" },
      ],
      stageOptions: [{ description: "Plan the work", id: "stage-1", name: "Plan", position: 1 }],
    });
    expect(mocked.loadSessionRepositoryOptionsWithPrimary).toHaveBeenCalledTimes(1);
    expect(mocked.loadSessionRepositoryOptionsWithPrimary).toHaveBeenCalledWith({
      factoryId: DEFAULT_FACTORY_ID,
      supabase,
      workspaceId: WORKSPACE_ID,
    });
  });

  it("does not use legacy options when the requested factory needs publication", async () => {
    const supabase = grantAccess(null, "admin");
    mocked.loadBrowserSessionFactories.mockResolvedValueOnce([
      { id: BENCH_FACTORY_ID, isDefault: false, name: "Bench factory", status: "active" },
    ]);
    const response = await GET(
      new Request(`http://localhost?factoryId=${BENCH_FACTORY_ID}`),
      routeContext(),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "Publish a factory definition before starting a session here.",
      setupHref: `/w/wallie/settings/factory-definition?factory=${BENCH_FACTORY_ID}#factory-setup`,
    });
    expect(mocked.loadActiveFactoryExecution).toHaveBeenCalledExactlyOnceWith(
      supabase,
      WORKSPACE_ID,
      BENCH_FACTORY_ID,
    );
    expect(mocked.loadSessionRepositoryOptionsWithPrimary).not.toHaveBeenCalled();
    expect(mocked.loadDefaultPipelineForWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    ["all", 400],
    [`${BENCH_FACTORY_ID}&factoryId=${DEFAULT_FACTORY_ID}`, 400],
    [BENCH_FACTORY_ID, 404],
  ])(
    "rejects invalid or inaccessible factory scope %s without fetching options",
    async (query, status) => {
      grantAccess();
      mocked.loadBrowserSessionFactories.mockResolvedValueOnce([]);
      const response = await GET(
        new Request(`http://localhost?factoryId=${query}`),
        routeContext(),
      );
      expect(response.status).toBe(status);
      expect(mocked.loadActiveFactoryExecution).not.toHaveBeenCalled();
      expect(mocked.loadSessionRepositoryOptionsWithPrimary).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      [
        { id: "repo-alternate", full_name: "acme/alternate" },
        { id: "repo-pinned", full_name: "acme/pinned" },
      ],
    ],
    [[{ id: "repo-alternate", full_name: "acme/alternate" }]],
    [[]],
  ])("projects only the active writable repository rows %j", async (repositories) => {
    const supabase = grantAccess();
    const pinnedQuery = {
      select: vi.fn(() => pinnedQuery),
      eq: vi.fn(() => pinnedQuery),
      in: vi.fn(() => pinnedQuery),
      order: vi.fn(async () => ({ data: repositories, error: null })),
    };
    supabase.from.mockReturnValue(pinnedQuery);
    mocked.loadActiveFactoryExecution.mockResolvedValueOnce({
      canonicalDigest: "a".repeat(64),
      factoryId: "factory-1",
      implementationAgent: { agentId: "configured-agent" },
      pipelineId: "compiled-pipeline",
      repositoryId: "repo-pinned",
      writableRepositoryIds: ["repo-alternate"],
      readContextRepositoryIds: ["repo-context"],
      stages: [
        { id: "stage-2", name: "Compile", description: "First compiled stage" },
        { id: "stage-1", name: "Ship", description: "Second compiled stage" },
      ],
    });

    const response = await GET(new Request("http://localhost"), routeContext());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      canDraftSpecification: true,
      defaultGithubRepositoryId: "repo-pinned",
      factoryDefinitionDigest: "a".repeat(64),
      pipelineId: "compiled-pipeline",
      repositoryOptions: repositories.map(({ id, full_name }) => ({ id, fullName: full_name })),
      stageOptions: [
        { id: "stage-2", name: "Compile", description: "First compiled stage", position: 1 },
        { id: "stage-1", name: "Ship", description: "Second compiled stage", position: 2 },
      ],
    });
    expect(mocked.loadActiveFactoryExecution).toHaveBeenCalledExactlyOnceWith(
      supabase,
      WORKSPACE_ID,
    );
    expect(mocked.loadSessionRepositoryOptionsWithPrimary).not.toHaveBeenCalled();
    expect(mocked.loadDefaultPipelineForWorkspace).not.toHaveBeenCalled();
    expect(supabase.from).toHaveBeenCalledExactlyOnceWith("github_repositories");
    expect(pinnedQuery.eq.mock.calls).toEqual([
      ["workspace_id", WORKSPACE_ID],
      ["factory_id", "factory-1"],
      ["is_archived", false],
      ["github_installations.workspace_id", WORKSPACE_ID],
      ["github_installations.suspended", false],
    ]);
    expect(pinnedQuery.select).toHaveBeenCalledWith(
      "id, full_name, github_installations!inner(id)",
    );
    expect(pinnedQuery.in).toHaveBeenCalledWith("id", ["repo-pinned", "repo-alternate"]);
  });

  it.each(["admin", "member"] as const)(
    "exposes reviewed stage choices only for an authorized %s",
    async (role) => {
      const supabase = grantAccess("repo-pinned", role);
      const stageId = "00000000-0000-4000-8000-000000000005";
      const classId = "00000000-0000-4000-8000-000000000006";
      const ruleId = "00000000-0000-4000-8000-000000000007";
      const configuration = {
        agentId: "00000000-0000-4000-8000-000000000008",
        qualificationId: "00000000-0000-4000-8000-000000000009",
        definitionRevisionId: "00000000-0000-4000-8000-000000000010",
        experimentId: "00000000-0000-4000-8000-000000000011",
        modelKey: "openai/gpt-4.1",
        workerRuntime: "node",
        harness: "codex",
      };
      const repos = {
        select: vi.fn(() => repos),
        eq: vi.fn(() => repos),
        in: vi.fn(() => repos),
        order: vi.fn(async () => ({ data: [], error: null })),
      };
      const review = {
        select: vi.fn(() => review),
        eq: vi.fn(() => review),
        maybeSingle: vi.fn(async () => ({
          data: {
            reviewed_targets: [
              { ruleId, target: "primary", configuration },
              { ruleId: null, target: "unmatched_fallback", configuration },
            ],
          },
          error: null,
        })),
      };
      const canary = {
        select: vi.fn(() => canary),
        eq: vi.fn(() => canary),
        maybeSingle: vi.fn(async () => ({ data: null, error: null })),
      };
      supabase.from.mockImplementation((table) => {
        if (table === "factory_routing_activations") return review;
        if (table === "factory_routing_canaries") return canary;
        return repos;
      });
      mocked.loadActiveFactoryExecution.mockResolvedValueOnce({
        activationNumber: 7,
        canonicalDigest: "a".repeat(64),
        factoryId: "factory-1",
        pipelineId: "compiled-pipeline",
        repositoryId: "repo-pinned",
        stages: [{ id: stageId, slug: "compile", name: "Compile", description: "" }],
        modelRouting: {
          taskClasses: [{ id: classId, slug: "compile", name: "Compile task" }],
          rules: [{ id: ruleId, taskClassId: classId }],
        },
      });

      const response = await GET(new Request("http://localhost"), routeContext());
      expect(response.status).toBe(200);
      const body = await response.json();
      if (role === "admin") {
        expect(review.eq.mock.calls).toEqual([
          ["workspace_id", WORKSPACE_ID],
          ["factory_id", "factory-1"],
          ["activation_number", 7],
        ]);
        expect(body.routingOverrideOptions).toEqual({
          activationNumber: 7,
          targets: [
            {
              stageId,
              ruleId,
              target: "primary",
              modelKey: "openai/gpt-4.1",
              workerRuntime: "node",
              harness: "codex",
            },
          ],
        });
      } else {
        expect(review.select).not.toHaveBeenCalled();
        expect(body.routingOverrideOptions).toBeUndefined();
      }
    },
  );

  it("returns the authorized empty option set", async () => {
    grantAccess(null);
    mocked.loadSessionRepositoryOptionsWithPrimary.mockResolvedValue({
      primaryGithubRepositoryId: null,
      repositoryOptions: [],
    });

    const response = await GET(new Request("http://localhost"), routeContext());

    await expect(response.json()).resolves.toEqual({
      defaultGithubRepositoryId: null,
      pipelineId: "pipeline-1",
      repositoryOptions: [],
      stageOptions: [{ description: "Plan the work", id: "stage-1", name: "Plan", position: 1 }],
    });
  });

  it("returns an empty stage set when the workspace has no default pipeline", async () => {
    grantAccess(null);
    mocked.loadDefaultPipelineForWorkspace.mockResolvedValue(null);
    mocked.loadSessionRepositoryOptionsWithPrimary.mockResolvedValue({
      primaryGithubRepositoryId: null,
      repositoryOptions: [],
    });

    const response = await GET(new Request("http://localhost"), routeContext());

    await expect(response.json()).resolves.toEqual({
      defaultGithubRepositoryId: null,
      pipelineId: null,
      repositoryOptions: [],
      stageOptions: [],
    });
  });

  it("requires workspace access before loading repositories", async () => {
    mocked.requireWorkspaceAccessById.mockResolvedValue({
      error: "Workspace not found.",
      ok: false,
      status: 404,
    });

    const response = await GET(new Request("http://localhost"), routeContext());

    expect(response.status).toBe(404);
    expect(mocked.loadSessionRepositoryOptionsWithPrimary).not.toHaveBeenCalled();
  });
});
