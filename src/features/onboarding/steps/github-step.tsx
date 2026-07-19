"use client";

import { GitHubConnectionPanel } from "@/features/github/github-connection-panel";
import type { WorkspaceGitHubData } from "@/features/github/data";
import { ONBOARDING_FOCUS_TARGETS } from "@/features/onboarding/progress";
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
    <div id={ONBOARDING_FOCUS_TARGETS.github} tabIndex={-1}>
      <GitHubConnectionPanel
        canManage={data.canManage && !isSaving}
        github={data.github}
        onChange={updateGithub}
        source="onboarding"
        workspaceId={data.workspace.id}
      />
    </div>
  );
}
