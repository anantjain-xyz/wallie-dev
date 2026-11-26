"use client";

import { GitHubConnectionPanel } from "@/features/github/github-connection-panel";
import type { WorkspaceGitHubData } from "@/features/github/data";
import { buildRepositorySetupHealth } from "@/features/onboarding/repository-health";
import type { OnboardingSetupHealth } from "@/lib/onboarding/contracts";

import type { OnboardingStepProps } from "./types";

function applyGithubHealth(
  health: OnboardingSetupHealth,
  github: WorkspaceGitHubData,
  selectedGithubRepositoryId: string | null,
): OnboardingSetupHealth {
  return {
    ...health,
    githubInstallation: {
      connected: Boolean(github.installation && !github.installation.suspended),
      installationId: github.installation?.installationId ?? null,
      status: github.installation ? "present" : "missing",
      suspended: github.installation?.suspended ?? null,
      targetName: github.installation?.targetName ?? null,
      updatedAt: github.installation?.updatedAt ?? null,
    },
    ...buildRepositorySetupHealth(github, selectedGithubRepositoryId),
  };
}

export default function GitHubStep({ data, isSaving, onDataChange }: OnboardingStepProps) {
  function updateGithub(github: WorkspaceGitHubData) {
    onDataChange({
      ...data,
      github,
      setupHealth: applyGithubHealth(
        data.setupHealth,
        github,
        data.onboarding.selectedGithubRepositoryId,
      ),
    });
  }

  return (
    <div className="space-y-4">
      <GitHubConnectionPanel
        canManage={data.canManage && !isSaving}
        github={data.github}
        onChange={updateGithub}
        source="onboarding"
        workspaceId={data.workspace.id}
      />
      {data.github.installation?.suspended ? (
        <p
          className="rounded-[6px] border border-warning/20 bg-warning-soft px-3 py-2 text-[13px] text-foreground"
          role="status"
        >
          This GitHub installation is suspended. Ask a GitHub account owner to restore it using
          Manage on GitHub, then refresh repositories.
        </p>
      ) : data.github.installation &&
        !data.github.repositories.some((repository) => !repository.isArchived) ? (
        <p
          className="rounded-[6px] border border-border bg-sheet px-3 py-2 text-[13px] text-muted"
          role="status"
        >
          No active repositories are available. Use Manage on GitHub to give Wallie access to at
          least one active repository, then refresh repositories.
        </p>
      ) : null}
    </div>
  );
}
