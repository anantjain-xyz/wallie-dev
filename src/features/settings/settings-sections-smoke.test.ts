import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AgentConfigSection } from "@/features/settings/agent-config-section";
import { LinearKeySection } from "@/features/settings/linear-key-section";
import { PipelineEditor } from "@/features/settings/pipeline-editor";
import { SandboxCapabilitySection } from "@/features/settings/sandbox-capability-section";
import { applyAgentConfigDraftChange } from "@/lib/agent-config/drafts";

const workspaceId = "00000000-0000-4000-8000-000000000001";

describe("Settings integration sections", () => {
  it("smoke-renders the Settings pipeline editor wrapper after extraction", () => {
    const html = renderToStaticMarkup(
      createElement(PipelineEditor, {
        canManage: true,
        pipeline: {
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
        },
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
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).not.toContain("<select");
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
