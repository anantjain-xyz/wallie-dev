import { createElement, type ReactElement } from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceUsageData } from "@/features/settings/data";

vi.mock("@/features/settings/settings-category-nav", () => ({
  SettingsCategoryNav: () => <p>Category navigation island</p>,
}));
vi.mock("@/features/settings/islands/integration-islands", () => ({
  GithubIntegrationIsland: () => <p>GitHub integration island</p>,
  LinearIntegrationIsland: () => <p>Linear integration island</p>,
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

function renderSettingsCategory(
  category: SettingsCategory,
  canManage = true,
  usage: Partial<WorkspaceUsageData> = {},
) {
  return renderStream(
    createElement(SettingsServerShell, {
      category,
      initialData: {
        canManage,
        currentMember: { id: "member-1", role: canManage ? "owner" : "member" },
        github: null,
        workspace: { id: "workspace-1", name: "Acme", slug: "acme" },
      } as never,
      searchState: { codexStatus: null, githubStatus: null },
      setupData: Promise.resolve({
        agentConfig: { agent_provider: "codex" },
        rateLimits: [
          {
            endpoint: "POST /api/workspaces/:id/maintenance/tick",
            scope: "maintenance",
            max: 3,
            windowMs: 60_000,
          },
        ],
        workspaceMembers: [],
      } as never),
      usage: Promise.resolve({
        totalCostUsd: 1.25,
        totalInputTokens: 2_000,
        totalOutputTokens: 1_000,
        totalRuns: 3,
        tokensUnavailable: false,
        costUnavailable: false,
        hasEstimatedTokens: false,
        hasEstimatedCost: false,
        ...usage,
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
    expect(html).toContain("Verify setup island");
    expect(html).not.toContain("Workspace identity island");
  });

  it("renders only workspace, members, and danger-zone islands for workspace", async () => {
    const html = await renderSettingsCategory("workspace");

    expect(html).toContain("Workspace identity island");
    expect(html).toContain("Workspace members island");
    expect(html).toContain("Danger zone island");
    expect(html).not.toContain("GitHub integration island");
    expect(html).not.toContain("Verify setup island");
  });

  it("renders usage, run history, maintenance, and rate-limit content for advanced", async () => {
    const html = await renderSettingsCategory("advanced");

    expect(html).toContain("Runs started");
    expect(html).toContain(
      "All time · Runs that started in this workspace, including failed runs.",
    );
    expect(html).toContain("Run cost (USD)");
    expect(html).toContain(">3<");
    expect(html).toContain('id="maintenance"');
    expect(html).toContain(">Maintenance<");
    expect(html).toContain(">Run history<");
    expect(html).toContain("Recover stalled work and refresh linked Linear and GitHub state.");
    expect(html).toContain("Configured request caps are read-only.");
    expect(html).toContain("3 requests per minute per workspace member");
    expect(html).toContain("<summary");
    expect(html).toContain("POST /api/workspaces/:id/maintenance/tick");
    expect(html).toContain("Maintenance island");
    expect(html).not.toContain("Verify setup island");
    expect(html).not.toContain("GitHub integration island");
    expect(html).not.toContain("Workspace identity island");
  });

  it("omits private run controls and maintenance for ordinary members", async () => {
    const html = await renderSettingsCategory("advanced", false);

    expect(html).toContain("Runs started");
    expect(html).not.toContain('id="maintenance"');
    expect(html).not.toContain(">Maintenance<");
    expect(html).not.toContain(">Run history<");
    expect(html).not.toContain("Recover stalled work and refresh linked Linear and GitHub state.");
    expect(html).not.toContain("Maintenance island");
  });

  it("distinguishes zero started runs from unavailable or partial usage", async () => {
    const empty = await renderSettingsCategory("advanced", false, {
      totalRuns: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
    });
    expect(empty).toContain("No runs have started yet.");
    const partial = await renderSettingsCategory("advanced", false, {
      totalRuns: 3,
      totalCostUsd: null,
      costUnavailable: true,
      tokensUnavailable: true,
      hasEstimatedTokens: true,
    });
    expect(partial).not.toContain("No runs have started yet.");
    expect(partial).toContain("Provider did not report");
    expect(partial).toContain("Partial · includes estimates");
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
