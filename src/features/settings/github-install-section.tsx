"use client";

import { GitHubConnectionPanel } from "@/features/github/github-connection-panel";
import { Status } from "@/components/ui/status";
import type { SettingsPageData } from "@/features/settings/data";
import type { FlashMessage } from "@/features/settings/settings-types";
import { Section } from "@/features/settings/settings-ui";

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
      <Status label="Suspended" value="needs_attention" />
    ) : (
      <Status label="Connected" value="healthy" />
    )
  ) : (
    <Status label="Not connected" value="not_started" />
  );

  return (
    <Section
      anchorId="github"
      statusBadge={statusBadge}
      tagline="Connect GitHub to create PRs and track their status."
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
