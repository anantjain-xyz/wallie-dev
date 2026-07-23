// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { Profiler } from "react";
import { describe, expect, it, vi } from "vitest";

import type { SettingsPageData } from "@/features/settings/data";
import type { SandboxSettingsResponse } from "@/lib/sandbox-connections/contracts";

const renders = vi.hoisted(() => ({ github: 0, runtime: 0, vercel: 0 }));

vi.mock("@/features/settings/agent-config-section", () => ({
  AgentConfigSection: ({
    sandboxConnectionLabel,
    sandboxConnectionReady,
  }: {
    sandboxConnectionLabel: string;
    sandboxConnectionReady: boolean;
  }) => {
    renders.runtime += 1;
    return (
      <output>
        Sandbox {sandboxConnectionLabel} {sandboxConnectionReady ? "ready" : "blocked"}
      </output>
    );
  },
}));

vi.mock("@/features/settings/github-install-section", () => ({
  GitHubInstallSection: ({
    github,
    onGithubChange,
  }: {
    github: { installation: { targetName: string } | null };
    onGithubChange: (github: { installation: { targetName: string } | null }) => void;
  }) => {
    renders.github += 1;
    return (
      <button
        onClick={() => onGithubChange({ installation: { targetName: "updated" } })}
        type="button"
      >
        GitHub {github.installation?.targetName ?? "missing"}
      </button>
    );
  },
}));

vi.mock("@/features/settings/linear-configuration-section", () => ({
  LinearConfigurationSection: ({ stages }: { stages: Array<{ slug: string }> }) => (
    <output>Linear stages {stages.map((stage) => stage.slug).join(", ")}</output>
  ),
}));

vi.mock("@/features/settings/sandbox-provider-section", () => ({
  SandboxProviderSection: ({
    vercelConnection,
    onSettingsChange,
  }: {
    vercelConnection: { projectId: string } | null;
    onSettingsChange: (settings: SandboxSettingsResponse) => void;
  }) => {
    renders.vercel += 1;
    return (
      <button
        onClick={() =>
          onSettingsChange({
            activeProvider: "e2b",
            connections: {
              daytona: null,
              e2b: {
                apiKeyPreview: "e2b_…1234",
                connectionRevision: "revision-e2b",
                lastValidatedAt: "2026-07-22T00:00:00.000Z",
                lastValidationError: null,
                status: "connected",
                updatedAt: "2026-07-22T00:00:00.000Z",
                workspaceId: "workspace-1",
              },
              vercel: { projectId: "updated" } as never,
            },
            enabledProviders: ["vercel", "e2b", "daytona"],
            revision: 2,
            updatedAt: "2026-07-22T00:00:00.000Z",
          })
        }
        type="button"
      >
        Vercel {vercelConnection?.projectId ?? "missing"}
      </button>
    );
  },
  applySandboxSettingsToData: (current: SettingsPageData, settings: SandboxSettingsResponse) => {
    const active = settings.connections[settings.activeProvider];
    return {
      ...current,
      sandboxSettings: settings,
      setupHealth: {
        ...current.setupHealth,
        sandboxConnection: {
          connected:
            settings.enabledProviders.includes(settings.activeProvider) &&
            active?.status === "connected",
          providerLabel: settings.activeProvider === "e2b" ? "E2B" : "Vercel Sandbox",
        },
      },
      vercelSandboxConnection: settings.connections.vercel,
    } as SettingsPageData;
  },
}));

import {
  GithubIntegrationIsland,
  LinearIntegrationIsland,
  RuntimeIntegrationIsland,
  VercelIntegrationIsland,
} from "@/features/settings/islands/integration-islands";
import { SETTINGS_PIPELINE_CHANGED } from "@/features/settings/settings-island-events";

function data(): SettingsPageData {
  return {
    canManage: true,
    currentMember: { id: "member-1", role: "owner" },
    github: { installation: null, repositories: [] },
    sandboxSettings: {
      activeProvider: "vercel",
      connections: { daytona: null, e2b: null, vercel: { projectId: "initial" } },
      enabledProviders: ["vercel", "e2b", "daytona"],
      revision: 1,
      updatedAt: null,
    },
    setupHealth: {
      claudeCodeConnection: {
        checkedAt: null,
        connected: false,
        updatedAt: null,
      },
      codexConnection: {
        accountEmail: null,
        checkedAt: null,
        connected: false,
        credentialType: null,
        expiresAt: null,
        reconnectReason: null,
        reconnectRequired: false,
        status: "missing",
        updatedAt: null,
      },
      sandboxConnection: {
        connected: false,
        providerLabel: "Vercel Sandbox",
      },
      vercelSandboxConnection: { connected: false },
    },
    vercelSandboxConnection: { projectId: "initial" },
    workspaceSecrets: [],
    workspace: { id: "workspace-1", name: "Northwind", slug: "northwind" },
  } as unknown as SettingsPageData;
}

describe("Settings client-island isolation", () => {
  it("refreshes Linear stage options when the pipeline island saves", () => {
    const initialData = {
      ...data(),
      linearRouting: {},
      pipeline: {
        id: "pipeline-1",
        isDefault: true,
        name: "Default",
        operatingRulesMd: "",
        stages: [{ slug: "plan" }],
      },
    } as unknown as SettingsPageData;

    render(<LinearIntegrationIsland initialData={initialData} />);
    expect(screen.getByText("Linear stages plan")).not.toBeNull();

    fireEvent(
      window,
      new CustomEvent(SETTINGS_PIPELINE_CHANGED, {
        detail: {
          ...initialData.pipeline,
          stages: [{ slug: "design" }, { slug: "build" }],
        },
      }),
    );

    expect(screen.getByText("Linear stages design, build")).not.toBeNull();
  });

  it("does not rerender a sibling integration when local section state changes", () => {
    renders.github = 0;
    renders.runtime = 0;
    renders.vercel = 0;
    const initialData = data();
    const profilerCommits = { github: 0, runtime: 0, vercel: 0 };

    render(
      <>
        <Profiler id="github" onRender={() => (profilerCommits.github += 1)}>
          <GithubIntegrationIsland
            canManage
            github={initialData.github}
            githubStatus={null}
            workspaceId={initialData.workspace.id}
          />
        </Profiler>
        <Profiler id="vercel" onRender={() => (profilerCommits.vercel += 1)}>
          <VercelIntegrationIsland initialData={initialData} />
        </Profiler>
        <Profiler id="runtime" onRender={() => (profilerCommits.runtime += 1)}>
          <RuntimeIntegrationIsland codexStatus={null} initialData={initialData} />
        </Profiler>
      </>,
    );

    expect(renders).toEqual({ github: 1, runtime: 1, vercel: 1 });
    expect(profilerCommits).toEqual({ github: 1, runtime: 1, vercel: 1 });
    expect(screen.getByText("Sandbox Vercel Sandbox blocked")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "GitHub missing" }));
    expect(screen.getByRole("button", { name: "GitHub updated" })).not.toBeNull();
    expect(renders).toEqual({ github: 2, runtime: 1, vercel: 1 });
    expect(profilerCommits).toEqual({ github: 2, runtime: 1, vercel: 1 });

    fireEvent.click(screen.getByRole("button", { name: "Vercel initial" }));
    expect(screen.getByRole("button", { name: "Vercel updated" })).not.toBeNull();
    expect(screen.getByText("Sandbox E2B ready")).not.toBeNull();
    expect(renders).toEqual({ github: 2, runtime: 2, vercel: 2 });
    expect(profilerCommits).toEqual({ github: 2, runtime: 2, vercel: 2 });
  });
});
