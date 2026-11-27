"use client";

import { GitHubConnectionPanel } from "@/features/github/github-connection-panel";
import type { WorkspaceGitHubData } from "@/features/github/data";
import { buildRepositorySetupHealth } from "@/features/onboarding/repository-health";
import { githubSetupBlocker } from "@/features/onboarding/verification-presentation";
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

export default function GitHubStep({
  data,
  isSaving,
  onDataChange,
  onRepositorySetupMessage,
}: OnboardingStepProps) {
  const { github } = data;
  const blocker = githubSetupBlocker(github);
  const installDisabled = !github.installation && github.missingAppKeys.length > 0;
  const missingWebhookKeys = github.missingWebhookKeys.filter(
    (key) => !github.missingAppKeys.includes(key),
  );

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
      {blocker || !data.canManage ? (
        <div
          className="space-y-1 border-l-2 border-warning pl-3 text-[13px] leading-5"
          role="status"
        >
          {blocker ? <p>{blocker}</p> : null}
          {!data.canManage ? (
            <p className="text-muted">
              Read only. Ask a workspace owner or admin to{" "}
              {installDisabled ? "contact the deployment operator" : "manage GitHub access"}.
            </p>
          ) : null}
        </div>
      ) : null}
      {installDisabled && data.canManage ? (
        <>
          <a
            className="ui-button-primary min-h-11"
            href="https://github.com/anantjain-xyz/wallie-dev/blob/main/docs/deployment/self-hosting.md#5-create-the-production-github-app"
            rel="noreferrer"
            target="_blank"
          >
            Open GitHub App setup guide
          </a>
          <details className="border-t border-border">
            <summary className="min-h-11 cursor-pointer rounded-sm py-3 text-[13px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
              GitHub configuration details
            </summary>
            <p className="text-[13px] leading-5 text-muted">
              Ask the deployment operator to set these variables and restart Wallie before
              installing the GitHub App.
            </p>
            <ul className="mt-2 space-y-1 text-xs text-muted [overflow-wrap:anywhere]">
              {github.missingAppKeys.map((key) => (
                <li key={key}>
                  <code>{key}</code>
                </li>
              ))}
            </ul>
            {missingWebhookKeys.length ? (
              <p className="mt-2 text-xs text-muted [overflow-wrap:anywhere]">
                Webhook sync is also disabled: <code>{missingWebhookKeys.join(", ")}</code>.
              </p>
            ) : null}
          </details>
        </>
      ) : !installDisabled && (github.installation || data.canManage) ? (
        <GitHubConnectionPanel
          canManage={data.canManage && !isSaving}
          github={github}
          onChange={updateGithub}
          setFlashMessage={onRepositorySetupMessage}
          source="onboarding"
          workspaceId={data.workspace.id}
        />
      ) : null}
    </div>
  );
}
