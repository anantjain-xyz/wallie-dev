import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AgentConfigSection } from "@/features/settings/agent-config-section";
import type { SettingsPageData } from "@/features/settings/data";
import { LinearConfigurationSection } from "@/features/settings/linear-configuration-section";
import { PipelineEditor } from "@/features/settings/pipeline-editor";
import {
  markSandboxCapabilityCheckPollingFailed,
  resolveSandboxRepositorySelection,
  SandboxCapabilitySection,
} from "@/features/settings/sandbox-capability-section";
import { resolveLegacySettingsAnchorHash } from "@/features/settings/settings-anchor-nav";
import {
  applyLinearRoutingToSettingsData,
  SettingsPageClient,
} from "@/features/settings/settings-page-client";
import { applyAgentConfigDraftChange } from "@/lib/agent-config/drafts";
import { DEFAULT_LINEAR_ROUTING_CONFIG } from "@/lib/linear-routing/contracts";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const pipeline = {
  id: "pipeline-1",
  isDefault: true,
  name: "Default",
  stages: [
    {
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

function settingsData(overrides: Partial<SettingsPageData> = {}): SettingsPageData {
  const agentConfig = {
    agent_model: "gpt-5-codex",
    agent_provider: "codex",
    concurrency_limit: 1,
    max_retries: 3,
    stall_timeout_ms: 300000,
  };

  return {
    agentConfig,
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
    latestSandboxCapabilityCheck: null,
    linearSecret: null,
    linearRouting: DEFAULT_LINEAR_ROUTING_CONFIG,
    onboarding: {
      completedAt: null,
      completedSteps: [],
      createdAt: "2026-05-16T18:00:00.000Z",
      currentStep: "github",
      dismissedAt: null,
      id: "onboarding-1",
      selectedGithubRepositoryId: null,
      skippedSteps: [],
      status: "in_progress",
      updatedAt: "2026-05-16T18:00:00.000Z",
      workspaceId,
    },
    pipeline,
    rateLimits: [],
    usage: {
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalRuns: 0,
    },
    setupHealth: {
      agentConfig: {
        configured: true,
        configuredKeys: [
          "agent_provider",
          "agent_model",
          "concurrency_limit",
          "stall_timeout_ms",
          "max_retries",
        ],
        status: "present",
        values: agentConfig,
      },
      claudeCodeConnection: {
        connected: false,
        status: "missing",
        updatedAt: null,
      },
      codexConnection: {
        connected: false,
        credentialType: null,
        expiresAt: null,
        status: "missing",
        updatedAt: null,
      },
      defaultPipeline: {
        configured: true,
        pipelineId: "pipeline-1",
        stageCount: 1,
        status: "ready",
      },
      githubInstallation: {
        connected: false,
        installationId: null,
        status: "missing",
        suspended: null,
        targetName: null,
        updatedAt: null,
      },
      latestSandboxCapabilityCheck: null,
      linearKey: {
        configured: false,
        status: "missing",
        updatedAt: null,
      },
      linearRouting: {
        configured: false,
        status: "missing",
        updatedAt: null,
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
      selectedRepository: {
        configured: false,
        fullName: null,
        repositoryId: null,
        status: "missing",
      },
      workspaceSecrets: {
        configuredKeys: [],
      },
    },
    workspace: {
      avatarPath: null,
      avatarUrl: null,
      id: workspaceId,
      name: "Acme",
      slug: "acme",
    },
    workspaceMembers: [],
    workspaceSecrets: [],
    ...overrides,
  };
}

describe("Settings integration sections", () => {
  it("smoke-renders the Settings pipeline editor wrapper after extraction", () => {
    const html = renderToStaticMarkup(
      createElement(PipelineEditor, {
        canManage: true,
        pipeline,
        workspaceId,
        workspaceMembers: [],
      }),
    );

    expect(html).toContain("Pipeline name");
    expect(html).toContain("Product");
    expect(html).toContain("Save pipeline");
  });

  it("smoke-renders the Settings Linear configuration section", () => {
    const html = renderToStaticMarkup(
      createElement(LinearConfigurationSection, {
        canManage: true,
        isLoadingSecrets: false,
        linearSecret: {
          createdAt: "2026-05-16T18:00:00.000Z",
          createdByMemberId: "member-1",
          id: "secret-1",
          key: "LINEAR_API_KEY",
          updatedAt: "2026-05-16T18:00:00.000Z",
          valuePreview: "••••1234",
          workspaceId,
        },
        routing: DEFAULT_LINEAR_ROUTING_CONFIG,
        setFlashMessage: vi.fn(),
        setSecrets: vi.fn(),
        stages: pipeline.stages,
        workspaceId,
      }),
    );

    expect(html).toContain("Configure Linear");
    expect(html).toContain("Linear API key");
    expect(html).toContain("Linear routing");
    expect(html).toContain("••••1234");
    expect(html).toContain("Test connection");
  });

  it("renders Settings agent config selects with the shared combobox", () => {
    const html = renderToStaticMarkup(
      createElement(AgentConfigSection, {
        canManage: true,
        initialAgentConfig: {
          agent_model: "gpt-5.5",
          agent_provider: "codex",
          concurrency_limit: 1,
          max_retries: 3,
          stall_timeout_ms: 300000,
        },
        setFlashMessage: vi.fn(),
        workspaceId,
      }),
    );

    expect(html).toContain("Agent provider");
    expect(html).toContain("Codex");
    expect(html).not.toContain(">codex<");
    expect(html).toContain("Provider access");
    expect(html).toContain("Sessions run with the Codex credential saved by the session creator");
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).not.toContain("<select");
    expect(html).not.toContain("Connect yours below");
  });

  it("renders Settings anchors in onboarding order with usage at the bottom", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsPageClient, {
        initialData: settingsData(),
        searchState: {
          codexStatus: null,
          githubStatus: null,
        },
      }),
    );

    const labels = [
      "Workspace",
      "Connect GitHub",
      "Analyze repositories",
      "Review pipeline",
      "Configure Linear",
      "Verify runtime",
      "Verify setup",
      "Usage",
      "Rate limits",
    ];
    let lastIndex = -1;
    for (const label of labels) {
      const index = html.indexOf(`>${label}</`);
      expect(index).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
    expect(html).not.toContain('href="#secrets"');
    expect(html).not.toContain('href="#linear-routing"');
    expect(html).not.toContain('href="#coding-agent"');
    expect(html).not.toContain('href="#cloud-execution"');
  });

  it("preserves legacy Settings hashes through onboarding-aligned anchors", () => {
    const redirects = {
      "cloud-execution": "verify",
      "coding-agent": "runtime",
      "linear-routing": "linear",
      secrets: "runtime",
    };

    expect(resolveLegacySettingsAnchorHash("#linear-routing", redirects)).toBe("linear");
    expect(resolveLegacySettingsAnchorHash("#coding-agent", redirects)).toBe("runtime");
    expect(resolveLegacySettingsAnchorHash("#cloud-execution", redirects)).toBe("verify");
    expect(resolveLegacySettingsAnchorHash("#secrets", redirects)).toBe("runtime");
    expect(resolveLegacySettingsAnchorHash("#usage", redirects)).toBeNull();
  });

  it("uses setup health, not onboarding step flags, for Settings verification", () => {
    const base = settingsData();
    const html = renderToStaticMarkup(
      createElement(SettingsPageClient, {
        initialData: settingsData({
          canManage: false,
          onboarding: {
            ...base.onboarding,
            completedSteps: [],
            skippedSteps: [],
          },
          setupHealth: {
            ...base.setupHealth,
            codexConnection: {
              connected: true,
              credentialType: "codex_access_token",
              expiresAt: "2026-05-16T20:00:00.000Z",
              status: "connected",
              updatedAt: "2026-05-16T18:00:00.000Z",
            },
            defaultPipeline: {
              configured: true,
              pipelineId: "pipeline-1",
              stageCount: 1,
              status: "ready",
            },
            githubInstallation: {
              connected: true,
              installationId: 123,
              status: "present",
              suspended: false,
              targetName: "acme-corp",
              updatedAt: "2026-05-16T18:00:00.000Z",
            },
            latestSandboxCapabilityCheck: {
              capabilities: {},
              checkedAt: "2026-05-16T18:00:00.000Z",
              errorText: null,
              githubRepositoryId: "11111111-1111-4111-8111-111111111111",
              id: "check-1",
              status: "success",
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
            primaryRepositoryProfile: {
              configured: true,
              fullName: "acme/app",
              repositoryId: "11111111-1111-4111-8111-111111111111",
              status: "ready",
            },
            repositorySetup: {
              configured: true,
              repositoryId: "11111111-1111-4111-8111-111111111111",
              status: "ready",
            },
            selectedRepository: {
              configured: true,
              fullName: "acme/app",
              repositoryId: "11111111-1111-4111-8111-111111111111",
              status: "ready",
            },
          },
          workspaceSecrets: [],
        }),
        searchState: {
          codexStatus: null,
          githubStatus: null,
        },
      }),
    );

    expect(html).toContain("Pipeline configured");
    expect(html).toContain("Linear configured");
    expect(html).toContain("Runtime configured");
    expect(html).toContain("Linear API key and routing are configured.");
    expect(html).not.toContain("Complete the pipeline step.");
    expect(html).not.toContain("Complete the Linear step.");
  });

  it("updates Settings health when Linear routing saves", () => {
    const data = settingsData({
      setupHealth: {
        ...settingsData().setupHealth,
        linearRouting: {
          configured: false,
          status: "missing",
          updatedAt: null,
        },
      },
    });
    const updated = applyLinearRoutingToSettingsData(
      data,
      DEFAULT_LINEAR_ROUTING_CONFIG,
      "2026-05-20T04:10:00.000Z",
    );

    expect(updated.linearRouting).toEqual(DEFAULT_LINEAR_ROUTING_CONFIG);
    expect(updated.setupHealth.linearRouting).toEqual({
      configured: true,
      status: "present",
      updatedAt: "2026-05-20T04:10:00.000Z",
    });
  });

  it("renders the onboarding-aligned Settings sections", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsPageClient, {
        initialData: settingsData(),
        searchState: {
          codexStatus: null,
          githubStatus: null,
        },
      }),
    );

    expect(html).toContain('id="repository"');
    expect(html).toContain("Analyze repositories");
    expect(html).toContain('id="linear"');
    expect(html).toContain("Configure Linear");
    expect(html).toContain('id="runtime"');
    expect(html).toContain("Workspace secrets");
    expect(html).toContain('id="verify"');
    expect(html).toContain("Verify setup");
  });

  it("renders repository setup actions inside Settings Analyze repositories", () => {
    const repository: SettingsPageData["github"]["repositories"][number] = {
      defaultBranch: "main",
      defaultProgrammingLanguage: "TypeScript",
      description: null,
      fullName: "acme/app",
      htmlUrl: "https://github.com/acme/app",
      id: "11111111-1111-4111-8111-111111111111",
      isArchived: false,
      isPrivate: true,
      name: "app",
      onboarding: {
        conflictReport: [],
        githubRepositoryId: "11111111-1111-4111-8111-111111111111",
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
      repoId: 1,
    };
    const html = renderToStaticMarkup(
      createElement(SettingsPageClient, {
        initialData: settingsData({
          github: {
            installation: {
              appId: 123,
              id: "installation-1",
              installationId: 456,
              installationUrl: "https://github.com/settings/installations/456",
              permissions: {},
              suspended: false,
              targetName: "acme",
              targetType: "Organization",
              updatedAt: "2026-05-16T18:00:00.000Z",
            },
            missingAppKeys: [],
            missingWebhookKeys: [],
            primaryProfile: null,
            repositories: [repository],
          },
          onboarding: {
            ...settingsData().onboarding,
            selectedGithubRepositoryId: repository.id,
          },
        }),
        searchState: {
          codexStatus: null,
          githubStatus: null,
        },
      }),
    );

    expect(html).toContain("Analyze repositories");
    expect(html).toContain("Install skills");
    expect(html).toContain("Mark skills as installed");
    expect(html).toContain(">Analyze repository</button>");
  });

  it("renders repository analysis only after skills are ready", () => {
    const repository: SettingsPageData["github"]["repositories"][number] = {
      defaultBranch: "main",
      defaultProgrammingLanguage: "TypeScript",
      description: null,
      fullName: "acme/app",
      htmlUrl: "https://github.com/acme/app",
      id: "11111111-1111-4111-8111-111111111111",
      isArchived: false,
      isPrivate: true,
      name: "app",
      onboarding: {
        conflictReport: [],
        githubRepositoryId: "11111111-1111-4111-8111-111111111111",
        installedSkillHash: "hash-1",
        installedSkillVersion: 1,
        lastError: null,
        setupBranchName: null,
        setupPrNumber: null,
        setupPrUrl: null,
        status: "ready",
        updatedAt: null,
      },
      profile: null,
      repoId: 1,
    };
    const html = renderToStaticMarkup(
      createElement(SettingsPageClient, {
        initialData: settingsData({
          github: {
            installation: {
              appId: 123,
              id: "installation-1",
              installationId: 456,
              installationUrl: "https://github.com/settings/installations/456",
              permissions: {},
              suspended: false,
              targetName: "acme",
              targetType: "Organization",
              updatedAt: "2026-05-16T18:00:00.000Z",
            },
            missingAppKeys: [],
            missingWebhookKeys: [],
            primaryProfile: null,
            repositories: [repository],
          },
          onboarding: {
            ...settingsData().onboarding,
            selectedGithubRepositoryId: repository.id,
          },
        }),
        searchState: {
          codexStatus: null,
          githubStatus: null,
        },
      }),
    );

    expect(html).toContain(">Analyze repository</button>");
    expect(html).not.toContain("Install skills");
    expect(html).not.toContain("Mark skills as installed");
  });

  it("renders provider access inside Verify runtime instead of a standalone Codex section", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsPageClient, {
        initialData: settingsData(),
        searchState: {
          codexStatus: null,
          githubStatus: null,
        },
      }),
    );

    expect(html).toContain('id="runtime"');
    expect(html).toContain("Verify runtime");
    expect(html).toContain("Provider access");
    expect(html).toContain("Checking connection");
    expect(html).not.toContain('id="codex"');
    expect(html).not.toContain('id="coding-agent"');
    expect(html).not.toContain('href="#codex"');
  });

  it("keeps provider access visible to non-admin workspace members", () => {
    const html = renderToStaticMarkup(
      createElement(AgentConfigSection, {
        canManage: false,
        initialAgentConfig: {
          agent_model: "gpt-5-codex",
          agent_provider: "codex",
          concurrency_limit: 1,
          max_retries: 3,
          stall_timeout_ms: 300000,
        },
        setFlashMessage: vi.fn(),
        workspaceId,
      }),
    );

    expect(html).toContain("Workspace admins can configure coding agent settings");
    expect(html).toContain("Provider access");
    expect(html).toContain("Sessions run with the Codex credential saved by the session creator");
    expect(html).toContain("Checking connection");
  });

  it("updates the sandbox repository target when the preferred repository changes", () => {
    const repositories: SettingsPageData["github"]["repositories"] = [
      {
        defaultBranch: "main",
        defaultProgrammingLanguage: "TypeScript",
        description: null,
        fullName: "acme/api",
        htmlUrl: "https://github.com/acme/api",
        id: "11111111-1111-4111-8111-111111111111",
        isArchived: false,
        isPrivate: true,
        name: "api",
        onboarding: {
          conflictReport: [],
          githubRepositoryId: "11111111-1111-4111-8111-111111111111",
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
        repoId: 1,
      },
      {
        defaultBranch: "main",
        defaultProgrammingLanguage: "TypeScript",
        description: null,
        fullName: "acme/web",
        htmlUrl: "https://github.com/acme/web",
        id: "22222222-2222-4222-8222-222222222222",
        isArchived: false,
        isPrivate: true,
        name: "web",
        onboarding: {
          conflictReport: [],
          githubRepositoryId: "22222222-2222-4222-8222-222222222222",
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
        repoId: 2,
      },
    ];

    expect(
      resolveSandboxRepositorySelection({
        currentRepositoryId: "11111111-1111-4111-8111-111111111111",
        preferredRepositoryId: "22222222-2222-4222-8222-222222222222",
        repositories,
      }),
    ).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("turns sandbox polling failures into a parent-syncable error check", () => {
    const failed = markSandboxCapabilityCheckPollingFailed(
      {
        capabilities: {},
        checkedAt: "2026-05-20T04:00:00.000Z",
        errorText: null,
        githubRepositoryId: "11111111-1111-4111-8111-111111111111",
        id: "check-1",
        status: "running",
      },
      "Capability check polling failed.",
      "2026-05-20T04:11:00.000Z",
    );

    expect(failed).toMatchObject({
      checkedAt: "2026-05-20T04:11:00.000Z",
      errorText: "Capability check polling failed.",
      status: "error",
    });
  });

  it("pairs Settings provider changes with the provider's recommended model", () => {
    const currentDrafts = {
      agent_model: "gpt-5.5",
      agent_provider: "codex",
      concurrency_limit: "1",
      max_retries: "3",
      stall_timeout_ms: "300000",
    };

    expect(
      applyAgentConfigDraftChange(currentDrafts, "agent_provider", "claude-code"),
    ).toMatchObject({
      agent_model: "claude-opus-4-7[1m]",
      agent_provider: "claude-code",
    });
    expect(applyAgentConfigDraftChange(currentDrafts, "agent_provider", "codex")).toMatchObject({
      agent_model: "gpt-5.5",
      agent_provider: "codex",
    });
  });

  it("renders the sandbox repository picker with the shared combobox", () => {
    const html = renderToStaticMarkup(
      createElement(SandboxCapabilitySection, {
        canManage: true,
        initialCheck: null,
        repositories: [
          {
            defaultBranch: "main",
            defaultProgrammingLanguage: "TypeScript",
            description: null,
            fullName: "acme/repo-a",
            htmlUrl: "https://github.com/acme/repo-a",
            id: "repo-a",
            isArchived: false,
            isPrivate: false,
            name: "repo-a",
            onboarding: {
              conflictReport: [],
              githubRepositoryId: "repo-a",
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
            repoId: 1,
          },
        ],
        setFlashMessage: vi.fn(),
        workspaceId,
      }),
    );

    expect(html).toContain("Repository");
    expect(html).toContain("acme/repo-a");
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).not.toContain("<select");
  });
});
