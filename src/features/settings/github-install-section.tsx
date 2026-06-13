"use client";

import { GitHubConnectionPanel } from "@/features/github/github-connection-panel";
import type { SettingsPageData } from "@/features/settings/data";
import type { FlashMessage } from "@/features/settings/settings-types";
import { Section, StatusBadge } from "@/features/settings/settings-ui";

type GitHubInstallSectionProps = {
  canManage: boolean;
  github: SettingsPageData["github"];
  onGithubChange?: (github: SettingsPageData["github"]) => void;
  setFlashMessage: (message: FlashMessage) => void;
  workspaceId: string;
};

export function GitHubInstallSection({
  canManage,
  github,
  onGithubChange,
  setFlashMessage,
  workspaceId,
}: GitHubInstallSectionProps) {
  const statusBadge = github.installation ? (
    github.installation.suspended ? (
      <StatusBadge tone="warning">Suspended</StatusBadge>
    ) : (
      <StatusBadge tone="success">Connected</StatusBadge>
    )
  ) : (
    <StatusBadge tone="neutral">Not connected</StatusBadge>
  );

  return (
    <Section
      anchorId="github"
      statusBadge={statusBadge}
      tagline="Install the workspace GitHub App so PR status appears on each session and Wallie can open PRs from agent runs."
      title="GitHub"
    >
      <GitHubConnectionPanel
        canManage={canManage}
        github={github}
        onChange={onGithubChange}
        setFlashMessage={setFlashMessage}
        source="settings"
        workspaceId={workspaceId}
      />
    </Section>
  );
}
