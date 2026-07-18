// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { Profiler } from "react";
import { describe, expect, it, vi } from "vitest";

import type { SettingsPageData } from "@/features/settings/data";

const renders = vi.hoisted(() => ({ github: 0, vercel: 0 }));

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

vi.mock("@/features/settings/vercel-sandbox-connection-section", () => ({
  VercelSandboxConnectionSection: ({
    connection,
    onConnectionChange,
  }: {
    connection: { projectId: string } | null;
    onConnectionChange: (connection: { projectId: string }) => void;
  }) => {
    renders.vercel += 1;
    return (
      <button onClick={() => onConnectionChange({ projectId: "updated" })} type="button">
        Vercel {connection?.projectId ?? "missing"}
      </button>
    );
  },
  vercelConnectionHealth: vi.fn(),
}));

import {
  GithubIntegrationIsland,
  VercelIntegrationIsland,
} from "@/features/settings/islands/integration-islands";

function data(): SettingsPageData {
  return {
    canManage: true,
    currentMember: { id: "member-1", role: "owner" },
    github: { installation: null, repositories: [] },
    vercelSandboxConnection: { projectId: "initial" },
    workspace: { id: "workspace-1", name: "Northwind", slug: "northwind" },
  } as unknown as SettingsPageData;
}

describe("Settings client-island isolation", () => {
  it("does not rerender a sibling integration when local section state changes", () => {
    renders.github = 0;
    renders.vercel = 0;
    const initialData = data();
    const profilerCommits = { github: 0, vercel: 0 };

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
      </>,
    );

    expect(renders).toEqual({ github: 1, vercel: 1 });
    expect(profilerCommits).toEqual({ github: 1, vercel: 1 });
    fireEvent.click(screen.getByRole("button", { name: "GitHub missing" }));
    expect(screen.getByRole("button", { name: "GitHub updated" })).not.toBeNull();
    expect(renders).toEqual({ github: 2, vercel: 1 });
    expect(profilerCommits).toEqual({ github: 2, vercel: 1 });

    fireEvent.click(screen.getByRole("button", { name: "Vercel initial" }));
    expect(screen.getByRole("button", { name: "Vercel updated" })).not.toBeNull();
    expect(renders).toEqual({ github: 2, vercel: 2 });
    expect(profilerCommits).toEqual({ github: 2, vercel: 2 });
  });
});
