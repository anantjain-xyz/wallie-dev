import { createElement, type ReactElement } from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/settings/settings-category-nav", () => ({
  SettingsCategoryNav: () => <p>Category navigation island</p>,
}));
vi.mock("@/features/settings/islands/integration-islands", () => ({
  GithubIntegrationIsland: () => <p>GitHub integration island</p>,
  LinearIntegrationIsland: () => <p>Linear integration island</p>,
  ProviderIntentLink: () => <p>Provider intent island</p>,
  RepositoryIntegrationIsland: () => <p>Repository integration island</p>,
  RuntimeIntegrationIsland: () => <p>Runtime integration island</p>,
  VercelIntegrationIsland: () => <p>Sandbox integration island</p>,
}));
vi.mock("@/features/settings/islands/pipeline-island", () => ({
  PipelineIsland: () => <p>Pipeline island</p>,
}));
vi.mock("@/features/settings/islands/advanced-islands", () => ({
  MaintenanceIsland: () => <p>Maintenance island</p>,
  VerifySetupIsland: () => <p>Verify setup island</p>,
}));
vi.mock("@/features/settings/islands/workspace-islands", () => ({
  DangerActionsIsland: () => <p>Danger zone island</p>,
  WorkspaceIdentityIsland: () => <p>Workspace identity island</p>,
  WorkspaceMembersIsland: () => <p>Workspace members island</p>,
}));

import {
  DEFAULT_SETTINGS_CATEGORY,
  parseSettingsCategory,
  type SettingsCategory,
} from "@/features/settings/settings-categories";
import {
  SettingsServerShell,
  SettingsSectionError,
  SettingsSectionFallback,
} from "@/features/settings/settings-server-shell";

async function renderStream(element: ReactElement) {
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return new Response(stream).text();
}

function renderSettingsCategory(category: SettingsCategory) {
  return renderStream(
    createElement(SettingsServerShell, {
      category,
      initialData: {
        canManage: true,
        currentMember: { id: "member-1", role: "owner" },
        github: null,
        workspace: { id: "workspace-1", name: "Acme", slug: "acme" },
      } as never,
      searchState: { codexStatus: null, githubStatus: null },
      setupData: Promise.resolve({
        agentConfig: { agent_provider: "codex" },
        rateLimits: [],
        workspaceMembers: [],
      } as never),
      usage: Promise.resolve({
        totalCostUsd: 1.25,
        totalInputTokens: 2_000,
        totalOutputTokens: 1_000,
        totalRuns: 3,
      }),
      workspaceInvitations: Promise.resolve([]),
    }),
  );
}

describe("Settings server shell", () => {
  it("selects exactly one supported category and falls back safely", () => {
    expect(parseSettingsCategory("integrations")).toBe("integrations");
    expect(parseSettingsCategory(["workspace", "advanced"])).toBe("workspace");
    expect(parseSettingsCategory("pipeline")).toBe(DEFAULT_SETTINGS_CATEGORY);
    expect(parseSettingsCategory("unknown")).toBe(DEFAULT_SETTINGS_CATEGORY);
    expect(parseSettingsCategory(undefined)).toBe(DEFAULT_SETTINGS_CATEGORY);
  });

  it("renders only the integrations category islands, including pipeline", async () => {
    const html = await renderSettingsCategory("integrations");

    expect(html).toContain("GitHub integration island");
    expect(html).toContain("Repository integration island");
    expect(html).toContain("Pipeline island");
    expect(html).toContain("Linear integration island");
    expect(html).toContain("Sandbox integration island");
    expect(html).toContain("Runtime integration island");
    expect(html).not.toContain("Workspace identity island");
    expect(html).not.toContain("Verify setup island");
  });

  it("renders only workspace, members, and danger-zone islands for workspace", async () => {
    const html = await renderSettingsCategory("workspace");

    expect(html).toContain("Workspace identity island");
    expect(html).toContain("Workspace members island");
    expect(html).toContain("Danger zone island");
    expect(html).not.toContain("GitHub integration island");
    expect(html).not.toContain("Verify setup island");
  });

  it("renders only setup, usage, and maintenance content for advanced", async () => {
    const html = await renderSettingsCategory("advanced");

    expect(html).toContain("Verify setup island");
    expect(html).toContain("Total runs");
    expect(html).toContain(">3<");
    expect(html).toContain("Maintenance island");
    expect(html).not.toContain("GitHub integration island");
    expect(html).not.toContain("Workspace identity island");
  });

  it("uses geometry-stable section loading and error states", () => {
    const loading = renderToStaticMarkup(
      createElement(SettingsSectionFallback, { label: "usage", minHeight: "min-h-72" }),
    );
    const error = renderToStaticMarkup(
      createElement(SettingsSectionError, { label: "Usage", minHeight: "min-h-72" }),
    );

    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain("min-h-72");
    expect(error).toContain('role="alert"');
    expect(error).toContain("min-h-72");
  });

  it("leaves the page-level main landmark to the authenticated app shell", async () => {
    const html = await renderSettingsCategory("integrations");

    expect(html).not.toContain("<main");
    expect(html).toContain('class="min-h-full"');
  });
});
