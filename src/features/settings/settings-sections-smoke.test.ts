import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AgentConfigSection } from "@/features/settings/agent-config-section";
import type { SettingsPageData } from "@/features/settings/data";
import { LinearKeySection } from "@/features/settings/linear-key-section";
import { PipelineEditor } from "@/features/settings/pipeline-editor";
import { SandboxCapabilitySection } from "@/features/settings/sandbox-capability-section";
import { SettingsPageClient } from "@/features/settings/settings-page-client";
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
  return {
    agentConfig: {
      agent_model: "gpt-5-codex",
      agent_provider: "codex",
      concurrency_limit: 1,
      max_retries: 3,
      stall_timeout_ms: 300000,
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
    latestSandboxCapabilityCheck: null,
    linearRouting: DEFAULT_LINEAR_ROUTING_CONFIG,
    onboarding: null,
    pipeline,
    rateLimits: [],
    usage: {
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalRuns: 0,
    },
    workspace: {
      avatarPath: null,
      avatarUrl: null,
      id: workspaceId,
      name: "Acme",
      slug: "acme",
    },
    workspaceMembers: [],
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

  it("smoke-renders the Settings Linear section wrapper after extraction", () => {
    const html = renderToStaticMarkup(
      createElement(LinearKeySection, {
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
        setFlashMessage: vi.fn(),
        setSecrets: vi.fn(),
        workspaceId,
      }),
    );

    expect(html).toContain("Linear");
    expect(html).toContain("••••1234");
    expect(html).toContain("Test connection");
  });

  it("renders Settings agent config selects with the shared combobox", () => {
    const html = renderToStaticMarkup(
      createElement(AgentConfigSection, {
        canManage: true,
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

    expect(html).toContain("Agent provider");
    expect(html).toContain("Provider access");
    expect(html).toContain("Sessions run with the Codex account connected by the session creator");
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).not.toContain("<select");
    expect(html).not.toContain("Connect yours below");
  });

  it("renders provider access inside Coding agent instead of a standalone Codex section", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsPageClient, {
        initialData: settingsData(),
        searchState: {
          codexStatus: null,
          githubStatus: null,
        },
      }),
    );

    expect(html).toContain('id="coding-agent"');
    expect(html).toContain("Provider access");
    expect(html).toContain("Checking connection");
    expect(html).not.toContain('id="codex"');
    expect(html).not.toContain('href="#codex"');
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
