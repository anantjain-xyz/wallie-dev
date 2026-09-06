import type { WorkspaceGitHubRepository } from "@/features/github/data";
import type { WorkspaceOnboardingData } from "@/features/onboarding/data";
import type { RepositoryProfileState } from "@/lib/repo-inference/contracts";
import { DEFAULT_LINEAR_ROUTING_CONFIG } from "@/lib/linear-routing/contracts";

export const configuredPipeline = {
  id: "pipeline-1",
  isDefault: true,
  name: "Default",
  operatingRulesMd: "",
  stages: [
    {
      anyoneCanApprove: false,
      approverMemberIds: [],
      description: "Product",
      id: "stage-product",
      name: "Product",
      pipelineId: "pipeline-1",
      position: 1,
      promptTemplateMd: "Product prompt",
      slug: "product",
    },
  ],
};

export function repository(id: string, overrides: Partial<WorkspaceGitHubRepository> = {}) {
  return {
    defaultBranch: "main",
    defaultProgrammingLanguage: "TypeScript",
    description: null,
    fullName: `acme/${id}`,
    htmlUrl: `https://github.com/acme/${id}`,
    id,
    isArchived: false,
    isPrivate: false,
    name: id,
    onboarding: {
      conflictReport: [],
      githubRepositoryId: id,
      installedSkillHash: null,
      installedSkillVersion: null,
      lastError: null,
      setupBranchName: null,
      setupPrNumber: null,
      setupPrUrl: null,
      status: "not_set_up",
      updatedAt: null,
    },
    profile: null,
    repoId: 100,
    ...overrides,
  } satisfies WorkspaceGitHubRepository;
}

export function profile(
  githubRepositoryId: string,
  overrides: Partial<RepositoryProfileState> = {},
) {
  return {
    buildCommand: "pnpm build",
    createdAt: "2026-05-16T18:00:00.000Z",
    envKeySuggestions: [],
    frameworkHints: ["next"],
    githubRepositoryId,
    id: `profile-${githubRepositoryId}`,
    inferenceConfidence: "manual",
    inferenceSources: [{ path: "package.json", reason: "Read package metadata" }],
    installCommand: "pnpm install",
    isPrimary: true,
    languageHints: ["typescript"],
    packageManager: "pnpm",
    setupNotes: "",
    testCommand: "pnpm test",
    updatedAt: "2026-05-16T18:00:00.000Z",
    workspaceId: "workspace-1",
    ...overrides,
  } satisfies RepositoryProfileState;
}

export function workspaceSecret(
  key: string,
  overrides: Partial<WorkspaceOnboardingData["workspaceSecrets"][number]> = {},
) {
  return {
    createdAt: "2026-05-16T18:00:00.000Z",
    createdByMemberId: "member-1",
    id: `secret-${key.toLowerCase()}`,
    key,
    updatedAt: "2026-05-16T18:00:00.000Z",
    valuePreview: "...value",
    workspaceId: "workspace-1",
    ...overrides,
  } satisfies WorkspaceOnboardingData["workspaceSecrets"][number];
}

type OnboardingDataOverrides = Omit<
  Partial<WorkspaceOnboardingData>,
  "onboarding" | "setupHealth" | "workspace"
> & {
  onboarding?: Partial<WorkspaceOnboardingData["onboarding"]>;
  setupHealth?: Partial<WorkspaceOnboardingData["setupHealth"]>;
  workspace?: Partial<WorkspaceOnboardingData["workspace"]>;
};

export function onboardingData(overrides: OnboardingDataOverrides = {}): WorkspaceOnboardingData {
  const pipeline = overrides.pipeline === undefined ? configuredPipeline : overrides.pipeline;
  const {
    onboarding: onboardingOverride,
    setupHealth: setupHealthOverride,
    workspace: workspaceOverride,
    ...topLevelOverrides
  } = overrides;

  return {
    agentConfig: {
      agent_model: "gpt-5.6-sol",
      agent_provider: "codex",
    },
    canManage: true,
    currentMember: { id: "member-1", role: "owner" },
    github: {
      installation: null,
      missingAppKeys: [],
      missingWebhookKeys: [],
      primaryProfile: null,
      repositories: [],
    },
    linearRouting: DEFAULT_LINEAR_ROUTING_CONFIG,
    linearSecret: null,
    onboarding: {
      completedAt: null,
      completedSteps: ["github", "repository"],
      createdAt: "2026-05-16T18:00:00.000Z",
      currentStep: "pipeline",
      dismissedAt: null,
      id: "onboarding-1",
      selectedGithubRepositoryId: null,
      skippedSteps: [],
      status: "in_progress",
      updatedAt: "2026-05-16T18:00:00.000Z",
      workspaceId: "workspace-1",
      ...onboardingOverride,
    },
    pipeline,
    setupHealth: {
      agentConfig: {
        configured: true,
        configuredKeys: ["agent_model", "agent_provider"],
        status: "present",
        values: {
          agent_model: "gpt-5.6-sol",
          agent_provider: "codex",
        },
      },
      codexConnection: {
        accountEmail: null,
        checkedAt: "2026-05-16T18:00:01.000Z",
        connected: false,
        credentialType: null,
        expiresAt: null,
        reconnectReason: null,
        reconnectRequired: false,
        status: "missing",
        updatedAt: null,
      },
      claudeCodeConnection: {
        checkedAt: "2026-05-16T18:00:01.000Z",
        connected: false,
        status: "missing",
        updatedAt: null,
      },
      openCodeConnection: {
        checkedAt: "2026-05-16T18:00:01.000Z",
        connected: false,
        providers: [],
        status: "missing",
        updatedAt: null,
      },
      defaultPipeline: pipeline
        ? {
            configured: true,
            pipelineId: pipeline.id,
            stageCount: pipeline.stages.length,
            status: "ready",
          }
        : {
            configured: false,
            pipelineId: null,
            stageCount: 0,
            status: "missing",
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
      linearKey: { configured: false, status: "missing", updatedAt: null },
      linearRouting: { configured: false, status: "missing", updatedAt: null },
      workspaceSecrets: { configuredKeys: [] },
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
      ...setupHealthOverride,
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
      workspaceId: "workspace-1",
    },
    workspace: { id: "workspace-1", name: "Northwind", slug: "northwind", ...workspaceOverride },
    workspaceMembers: [],
    workspaceSecrets: [],
    ...topLevelOverrides,
  };
}

export function verificationData(): WorkspaceOnboardingData {
  const data = onboardingData({
    onboarding: {
      completedSteps: ["github", "repository", "pipeline", "sandbox", "runtime"],
      currentStep: "verify",
      selectedGithubRepositoryId: "repo-a",
      skippedSteps: ["linear"],
    },
  });
  const repositoryProfile = profile("repo-a");
  const repo = repository("repo-a", { profile: repositoryProfile });
  repo.onboarding.status = "ready";
  data.github.primaryProfile = repositoryProfile;
  data.github.repositories = [repo];
  data.setupHealth.codexConnection = {
    ...data.setupHealth.codexConnection,
    connected: true,
    credentialType: "codex_access_token",
    status: "connected",
  };
  data.setupHealth.primaryRepositoryProfile = {
    configured: true,
    fullName: repo.fullName,
    repositoryId: repo.id,
    status: "ready",
  };
  data.setupHealth.selectedRepository = { ...data.setupHealth.primaryRepositoryProfile };
  data.setupHealth.repositorySetup = {
    configured: true,
    repositoryId: repo.id,
    status: "ready",
  };
  return data;
}

export function verificationCheck(status: "running" | "success" | "error" = "success") {
  return {
    agentModel: "gpt-5.6-sol",
    agentProvider: "codex",
    capabilities: {
      git: { ok: true, detail: "Repository is accessible." },
      agentCli: {
        ok: status !== "error",
        detail:
          status === "error"
            ? "Agent sign-in expired. Reconnect your agent and try again."
            : "Agent is available.",
      },
      chromium: { ok: true, detail: "Browser is available." },
    },
    checkedAt: "2026-09-06T19:00:00.000Z",
    errorText:
      status === "error" ? "Agent sign-in expired. Reconnect your agent and try again." : null,
    githubRepositoryId: "repo-a",
    id: "check-1",
    sandboxProvider: "vercel" as const,
    sandboxVercelProjectId: "prj_123",
    sandboxVercelTeamId: "team_123",
    status,
  };
}
