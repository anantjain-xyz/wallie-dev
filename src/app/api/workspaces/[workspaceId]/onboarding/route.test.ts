import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceOnboardingData } from "@/features/onboarding/data";
import { DEFAULT_LINEAR_ROUTING_CONFIG } from "@/lib/linear-routing/contracts";
import type {
  WorkspaceOnboardingMutationAction,
  WorkspaceOnboardingMutationDelta,
  WorkspaceOnboardingStep,
} from "@/lib/onboarding/contracts";

const mocked = vi.hoisted(() => ({
  loadWorkspaceOnboardingData: vi.fn(),
  updateWorkspaceOnboardingData: vi.fn(),
}));

vi.mock("@/features/onboarding/data", () => ({
  loadWorkspaceOnboardingData: mocked.loadWorkspaceOnboardingData,
  updateWorkspaceOnboardingData: mocked.updateWorkspaceOnboardingData,
}));

import { GET, PATCH } from "./route";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

const onboardingData: WorkspaceOnboardingData = {
  agentConfig: {
    agent_model: "gpt-5.5",
    agent_provider: "codex",
  },
  canManage: true,
  currentMember: {
    id: "member-1",
    role: "owner",
  },
  github: {
    installation: null,
    missingAppKeys: [],
    missingWebhookKeys: [],
    primaryProfile: null,
    repositories: [],
  },
  linearRouting: DEFAULT_LINEAR_ROUTING_CONFIG,
  linearSecret: {
    createdAt: "2026-05-16T18:00:00.000Z",
    createdByMemberId: "member-1",
    id: "secret-1",
    key: "LINEAR_API_KEY",
    updatedAt: "2026-05-16T18:00:00.000Z",
    valuePreview: "••••1234",
    workspaceId: WORKSPACE_ID,
  },
  onboarding: {
    completedAt: null,
    completedSteps: ["github"],
    createdAt: "2026-05-16T18:00:00.000Z",
    currentStep: "repository",
    dismissedAt: null,
    id: "onboarding-1",
    selectedGithubRepositoryId: null,
    skippedSteps: [],
    status: "in_progress",
    updatedAt: "2026-05-16T18:00:00.000Z",
    workspaceId: WORKSPACE_ID,
  },
  pipeline: {
    id: "pipeline-1",
    isDefault: true,
    name: "Default",
    operatingRulesMd: "",
    stages: [
      {
        approverMemberIds: [],
        description: "Product",
        id: "stage-1",
        name: "Product",
        pipelineId: "pipeline-1",
        position: 1,
        promptTemplateMd: "Product prompt",
        slug: "product",
      },
    ],
  },
  setupHealth: {
    agentConfig: {
      configured: true,
      configuredKeys: ["agent_model", "agent_provider"],
      status: "present",
      values: {
        agent_model: "gpt-5.5",
        agent_provider: "codex",
      },
    },
    codexConnection: {
      accountEmail: null,
      checkedAt: "2026-05-16T18:00:01.000Z",
      connected: true,
      credentialType: "codex_access_token",
      expiresAt: "2026-05-16T20:00:00.000Z",
      reconnectReason: null,
      reconnectRequired: false,
      status: "connected",
      updatedAt: "2026-05-16T18:00:00.000Z",
    },
    claudeCodeConnection: {
      checkedAt: "2026-05-16T18:00:01.000Z",
      connected: false,
      status: "missing",
      updatedAt: null,
    },
    defaultPipeline: {
      configured: true,
      pipelineId: "pipeline-1",
      stageCount: 6,
      status: "ready",
    },
    githubInstallation: {
      connected: true,
      installationId: 123,
      status: "present",
      suspended: false,
      targetName: "wallie",
      updatedAt: "2026-05-16T18:00:00.000Z",
    },
    latestSandboxCapabilityCheck: null,
    vercelSandboxConnection: {
      connected: true,
      lastValidationError: null,
      projectId: "prj_123",
      projectName: "wallie-sandboxes",
      status: "connected",
      teamId: "team_123",
      updatedAt: "2026-05-16T18:00:00.000Z",
    },
    selectedRepository: {
      configured: false,
      fullName: null,
      repositoryId: null,
      status: "missing",
    },
    linearKey: {
      configured: true,
      status: "present",
      updatedAt: "2026-05-16T18:00:00.000Z",
    },
    linearRouting: {
      configured: true,
      status: "present",
      updatedAt: "2026-05-16T18:00:00.000Z",
    },
    workspaceSecrets: {
      configuredKeys: ["LINEAR_API_KEY"],
    },
    primaryRepositoryProfile: {
      configured: false,
      fullName: null,
      repositoryId: null,
      status: "missing",
    },
    repositorySetup: {
      configured: false,
      repositoryId: null,
      status: "placeholder",
    },
  },
  vercelSandboxConnection: {
    lastValidatedAt: "2026-05-16T18:00:00.000Z",
    lastValidationError: null,
    projectId: "prj_123",
    projectName: "wallie-sandboxes",
    status: "connected",
    teamId: "team_123",
    tokenPreview: "vca_...123",
    updatedAt: "2026-05-16T18:00:00.000Z",
    workspaceId: WORKSPACE_ID,
  },
  workspace: {
    id: WORKSPACE_ID,
    name: "Wallie",
    slug: "wallie",
  },
  workspaceMembers: [
    {
      email: "owner@example.com",
      fullName: "Owner",
      id: "member-1",
      role: "owner",
    },
  ],
  workspaceSecrets: [
    {
      createdAt: "2026-05-16T18:00:00.000Z",
      createdByMemberId: "member-1",
      id: "secret-1",
      key: "LINEAR_API_KEY",
      updatedAt: "2026-05-16T18:00:00.000Z",
      valuePreview: "••••1234",
      workspaceId: WORKSPACE_ID,
    },
  ],
};

const mutationDelta: WorkspaceOnboardingMutationDelta = {
  action: "continue",
  kind: "onboarding-mutation",
  onboarding: {
    completedAt: null,
    completedSteps: ["github", "repository"],
    currentStep: "pipeline",
    dismissedAt: null,
    selectedGithubRepositoryId: null,
    skippedSteps: [],
    status: "in_progress",
  },
  setupHealth: {},
  step: "repository",
  updatedAt: "2026-05-16T18:01:00.000Z",
  validationErrors: [],
};

function routeContext(workspaceId = WORKSPACE_ID) {
  return {
    params: Promise.resolve({ workspaceId }),
  };
}

function patchRequest(
  changes: unknown,
  options: {
    action?: WorkspaceOnboardingMutationAction;
    expectedUpdatedAt?: string;
    step?: WorkspaceOnboardingStep;
  } = {},
) {
  return new Request(`http://localhost/api/workspaces/${WORKSPACE_ID}/onboarding`, {
    body:
      typeof changes === "string"
        ? changes
        : JSON.stringify({
            action: options.action ?? "continue",
            changes,
            expectedUpdatedAt: options.expectedUpdatedAt ?? "2026-05-16T18:00:00.000Z",
            step: options.step ?? "repository",
          }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
}

describe("workspace onboarding route", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns onboarding state and setup health", async () => {
    mocked.loadWorkspaceOnboardingData.mockResolvedValue({ data: onboardingData, ok: true });

    const response = await GET(new Request("http://localhost"), routeContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(onboardingData);
    expect(mocked.loadWorkspaceOnboardingData).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it("rejects malformed workspace ids before loading onboarding state", async () => {
    const response = await GET(new Request("http://localhost"), routeContext("not-a-uuid"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Workspace id must be a valid UUID.",
    });
    expect(mocked.loadWorkspaceOnboardingData).not.toHaveBeenCalled();
  });

  it("updates onboarding state with a valid patch", async () => {
    mocked.updateWorkspaceOnboardingData.mockResolvedValue({ data: mutationDelta, ok: true });

    const response = await PATCH(
      patchRequest({
        completedSteps: ["github", "repository"],
        currentStep: "pipeline",
        skippedSteps: [],
        status: "in_progress",
      }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual(mutationDelta);
    expect(mocked.updateWorkspaceOnboardingData).toHaveBeenCalledWith(WORKSPACE_ID, {
      action: "continue",
      changes: {
        completedSteps: ["github", "repository"],
        currentStep: "pipeline",
        skippedSteps: [],
        status: "in_progress",
      },
      expectedUpdatedAt: "2026-05-16T18:00:00.000Z",
      step: "repository",
    });

    expect(payload).not.toHaveProperty("github");
    expect(payload).not.toHaveProperty("linearSecret");
    expect(payload).not.toHaveProperty("pipeline");
    expect(payload).not.toHaveProperty("workspaceMembers");
    expect(payload).not.toHaveProperty("workspaceSecrets");
  });

  it("accepts selected repository updates", async () => {
    const repositoryDelta = {
      ...mutationDelta,
      action: "repository-selection" as const,
      step: "repository" as const,
    };
    mocked.updateWorkspaceOnboardingData.mockResolvedValue({ data: repositoryDelta, ok: true });

    const repositoryId = "11111111-1111-4111-8111-111111111111";
    const response = await PATCH(
      patchRequest(
        {
          selectedGithubRepositoryId: repositoryId,
          status: "in_progress",
        },
        { action: "repository-selection", step: "repository" },
      ),
      routeContext(),
    );

    expect(response.status).toBe(200);
    expect(mocked.updateWorkspaceOnboardingData).toHaveBeenCalledWith(WORKSPACE_ID, {
      action: "repository-selection",
      changes: {
        selectedGithubRepositoryId: repositoryId,
        status: "in_progress",
      },
      expectedUpdatedAt: "2026-05-16T18:00:00.000Z",
      step: "repository",
    });
  });

  it("returns the authoritative version and retryable message for stale updates", async () => {
    const conflict = {
      action: "continue" as const,
      authoritative: {
        onboarding: mutationDelta.onboarding,
        setupHealth: {},
        updatedAt: mutationDelta.updatedAt,
      },
      error:
        "Onboarding changed in another session. Latest progress was restored; retry your action.",
      kind: "onboarding-conflict" as const,
      retryable: true as const,
      step: "repository" as const,
      validationErrors: [],
    };
    mocked.updateWorkspaceOnboardingData.mockResolvedValue({
      conflict,
      error: conflict.error,
      ok: false,
      status: 409,
    });

    const response = await PATCH(patchRequest({ currentStep: "pipeline" }), routeContext());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(conflict);
  });

  it("rejects malformed workspace ids before updating onboarding state", async () => {
    const response = await PATCH(patchRequest({ status: "dismissed" }), routeContext("not-a-uuid"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      action: null,
      error: "Workspace id must be a valid UUID.",
      kind: "onboarding-mutation-error",
      retryable: false,
      step: null,
      validationErrors: [{ field: "workspaceId", message: "Workspace id must be a valid UUID." }],
    });
    expect(mocked.updateWorkspaceOnboardingData).not.toHaveBeenCalled();
  });

  it("rejects updates from non-managers", async () => {
    mocked.updateWorkspaceOnboardingData.mockResolvedValue({
      error: "Workspace admin access is required for this action.",
      ok: false,
      status: 403,
    });

    const response = await PATCH(patchRequest({ status: "dismissed" }), routeContext());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      action: "continue",
      error: "Workspace admin access is required for this action.",
      kind: "onboarding-mutation-error",
      retryable: false,
      step: "repository",
      validationErrors: [],
    });
  });

  it("rejects invalid statuses", async () => {
    const response = await PATCH(patchRequest({ status: "paused" }), routeContext());

    expect(response.status).toBe(400);
    expect(mocked.updateWorkspaceOnboardingData).not.toHaveBeenCalled();
  });

  it("rejects invalid current steps", async () => {
    const response = await PATCH(patchRequest({ currentStep: "billing" }), routeContext());

    expect(response.status).toBe(400);
    expect(mocked.updateWorkspaceOnboardingData).not.toHaveBeenCalled();
  });

  it("rejects invalid completed step arrays", async () => {
    const response = await PATCH(
      patchRequest({ completedSteps: ["github", "billing"] }),
      routeContext(),
    );

    expect(response.status).toBe(400);
    expect(mocked.updateWorkspaceOnboardingData).not.toHaveBeenCalled();
  });

  it("rejects invalid skipped step arrays", async () => {
    const response = await PATCH(
      patchRequest({ skippedSteps: ["runtime", "billing"] }),
      routeContext(),
    );

    expect(response.status).toBe(400);
    expect(mocked.updateWorkspaceOnboardingData).not.toHaveBeenCalled();
  });

  it("rejects invalid selected repository ids", async () => {
    const response = await PATCH(
      patchRequest({ selectedGithubRepositoryId: "not-a-uuid" }),
      routeContext(),
    );

    expect(response.status).toBe(400);
    expect(mocked.updateWorkspaceOnboardingData).not.toHaveBeenCalled();
  });
});
