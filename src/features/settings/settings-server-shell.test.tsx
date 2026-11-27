import { createElement, type ComponentProps, type ReactElement } from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/settings/settings-category-nav", () => ({
  SettingsCategoryNav: () => <p>Category navigation island</p>,
}));
vi.mock("@/features/settings/islands/integration-islands", () => ({
  GithubIntegrationIsland: () => <p>GitHub integration island</p>,
  LinearIntegrationIsland: () => <p>Linear integration island</p>,
  RepositoryIntegrationIsland: () => <p>Repository integration island</p>,
  RuntimeIntegrationIsland: () => <p>Runtime integration island</p>,
  VercelIntegrationIsland: () => <p>Sandbox integration island</p>,
  WorkspaceSecretsIntegrationIsland: () => <p>Workspace secrets island</p>,
}));
vi.mock("@/features/settings/islands/pipeline-island", () => ({
  PipelineIsland: () => <p>Pipeline island</p>,
}));
vi.mock("@/features/settings/islands/advanced-islands", () => ({
  MaintenanceIsland: () => <p>Maintenance island</p>,
  RunHistoryIsland: () => <p>Run history island</p>,
  VerifySetupIsland: () => <p>Verify setup island</p>,
}));
vi.mock("@/features/settings/islands/workspace-islands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/settings/islands/workspace-islands")>()),
  DangerActionsIsland: () => <p>Danger zone island</p>,
  WorkspaceIdentityIsland: () => <p>Workspace identity island</p>,
}));
vi.mock("@/features/settings/workspace-members-section", () => ({
  WorkspaceMembersSection: () => <p>Workspace members island</p>,
}));
vi.mock("@/features/settings/workspace-profile-section", () => ({
  WorkspaceProfileSection: () => <button>Edit profile</button>,
}));
vi.mock("@/features/settings/workspace-settings-load-error", () => ({
  WorkspaceSettingsLoadError: ({ label }: { label: string }) => (
    <p role="alert">Could not load {label}.</p>
  ),
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
import type { SettingsSetupData, WorkspaceUsageData } from "@/features/settings/data";

async function renderStream(element: ReactElement) {
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return new Response(stream).text();
}

const workspaceUsage: WorkspaceUsageData = {
  totalCostUsd: 1.25,
  totalInputTokens: 2_000,
  totalOutputTokens: 1_000,
  totalRuns: 3,
  tokensUnavailable: false,
  costUnavailable: false,
  hasEstimatedTokens: false,
  hasEstimatedCost: false,
};

function settingsCategory(
  category: SettingsCategory,
  canManage = true,
  overrides?: Partial<ComponentProps<typeof SettingsServerShell>>,
) {
  return createElement(SettingsServerShell, {
    category,
    initialData: {
      canManage,
      currentMember: { id: "member-1", role: canManage ? "owner" : "member" },
      github: null,
      workspace: { id: "workspace-1", name: "Acme", slug: "acme" },
    } as never,
    searchState: { githubStatus: null },
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
    usage: Promise.resolve(workspaceUsage),
    workspaceInvitations: Promise.resolve({ asOf: 0, invitations: [] }),
    workspaceProfile: Promise.resolve({ avatarUrl: null, fullName: "Alex" }),
    ...overrides,
  });
}

function renderSettingsCategory(category: SettingsCategory, canManage = true) {
  return renderStream(settingsCategory(category, canManage));
}

function rejected(label: string) {
  const promise = Promise.reject(new Error(label));
  void promise.catch(() => undefined);
  return promise;
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
    expect(html).toContain("Workspace secrets island");
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

  it.each([
    [
      "pending invitations",
      "workspaceInvitations",
      ["Workspace members island", "Danger zone island"],
    ],
    ["active members", "setupData", ["No pending invitations.", "Danger zone island"]],
  ] as const)(
    "isolates failure of %s from the other workspace reads",
    async (label, key, healthy) => {
      const html = await renderStream(
        settingsCategory("workspace", true, { [key]: rejected(label) }),
      );
      expect(html).toContain('id="members"');
      expect(html).toContain(">Team access<");
      expect(html.replaceAll(/<!--.*?-->/g, "")).toContain(`Could not load ${label}.`);
      for (const text of healthy) expect(html).toContain(text);
      if (key === "workspaceInvitations") expect(html).not.toContain("No pending invitations.");
    },
  );

  it("keeps personal connections usable if the profile read fails", async () => {
    const html = await renderStream(
      settingsCategory("personal", false, {
        personalConnections: <p>Personal connected clients</p>,
        workspaceProfile: rejected("your profile"),
      }),
    );

    expect(html).toContain('id="profile"');
    expect(html.replaceAll(/<!--.*?-->/g, "")).toContain("Could not load your profile.");
    expect(html).toContain("Personal connected clients");
    expect(html).not.toContain("Workspace members island");
  });

  it("keeps the Members heading and anchor while the subsections load", async () => {
    const setup = Promise.withResolvers<SettingsSetupData>();
    const stream = await renderToReadableStream(
      settingsCategory("workspace", true, { setupData: setup.promise }),
    );
    const reader = stream.getReader();
    try {
      const chunk = await reader.read();
      const html = new TextDecoder().decode(chunk.value);
      expect(html).toContain('id="members"');
      expect(html).toContain(">Team access<");
      expect(html.replaceAll(/<!--.*?-->/g, "")).toContain("Loading active members…");
    } finally {
      setup.resolve(await settingsCategory("workspace").props.setupData);
      try {
        while (!(await reader.read()).done) continue;
      } finally {
        reader.releaseLock();
      }
    }
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
    expect(html).toContain(">Retention and exports<");
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
    expect(html).not.toContain(">Retention and exports<");
    expect(html).not.toContain("Recover stalled work and refresh linked Linear and GitHub state.");
    expect(html).not.toContain("Maintenance island");
  });

  it("distinguishes zero started runs from unavailable or partial usage", async () => {
    const empty = await renderStream(
      settingsCategory("advanced", false, {
        usage: Promise.resolve({
          ...workspaceUsage,
          totalRuns: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCostUsd: 0,
        }),
      }),
    );
    expect(empty).toContain("No runs have started yet.");
    expect(empty).not.toContain("Runs started");
    const partial = await renderStream(
      settingsCategory("advanced", false, {
        usage: Promise.resolve({
          ...workspaceUsage,
          totalCostUsd: null,
          costUnavailable: true,
          tokensUnavailable: true,
          hasEstimatedTokens: true,
        }),
      }),
    );
    expect(partial).not.toContain("No runs have started yet.");
    expect(partial).toContain("Provider did not report");
    expect(partial).toContain("Partial · includes estimates");
  });

  it("does not render invitations for ordinary members", async () => {
    const html = await renderSettingsCategory("workspace", false);
    expect(html).toContain("Workspace members island");
    expect(html).not.toContain("Edit profile");
    expect(html).not.toContain("Pending invitations");
    expect(html).not.toContain("Invite member");
  });

  it("keeps team and OAuth administration in Workspace and account tasks in Personal", async () => {
    const props = {
      personalConnections: <p>Personal connected clients</p>,
      personalProviderAccess: <p>Personal provider access</p>,
      workspaceOAuthClients: <p>Restricted workspace registration</p>,
    };
    const [workspace, memberWorkspace, personal] = await Promise.all([
      renderStream(settingsCategory("workspace", true, props)),
      renderStream(settingsCategory("workspace", false, props)),
      renderStream(settingsCategory("personal", false, props)),
    ]);

    expect(workspace).toContain('id="members"');
    expect(workspace.indexOf('id="members"')).toBeLessThan(
      workspace.indexOf("Pending invitations"),
    );
    expect(workspace).toContain("Restricted workspace registration");
    expect(workspace).not.toContain('id="profile"');
    expect(workspace).not.toContain("Personal provider access");
    expect(workspace).not.toContain("Personal connected clients");
    expect(memberWorkspace).not.toContain("Restricted workspace registration");
    expect(personal).toContain('id="profile"');
    expect(personal).toContain("Personal provider access");
    expect(personal).toContain("Personal connected clients");
    expect(personal).not.toContain("Restricted workspace registration");
    expect(personal).not.toContain('id="members"');
  });

  it("keeps GitHub and selected factory connectors available if integration details fail", async () => {
    const html = await renderStream(
      settingsCategory("integrations", true, {
        connectorSettings: <p>Selected factory connectors</p>,
        setupData: rejected("settings details"),
      }),
    );

    expect(html).toContain("GitHub integration island");
    expect(html).toContain("Selected factory connectors");
    expect(html.replaceAll(/<!--.*?-->/gu, "")).toContain("Integration details unavailable");
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
