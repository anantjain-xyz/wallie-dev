import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GitHubInstallSection } from "@/features/settings/github-install-section";
import type { SettingsPageData } from "@/features/settings/data";

function repository(
  id: string,
  status: SettingsPageData["github"]["repositories"][number]["onboarding"]["status"],
): SettingsPageData["github"]["repositories"][number] {
  return {
    defaultBranch: "main",
    defaultProgrammingLanguage: "TypeScript",
    description: null,
    fullName: `acme/${id}`,
    htmlUrl: `https://github.com/acme/${id}`,
    id,
    isArchived: false,
    isPrivate: true,
    name: id,
    onboarding: {
      conflictReport:
        status === "conflict"
          ? [
              {
                path: ".agents/skills/push/SKILL.md",
                reason: "existing_skill_differs",
                message: "Differs",
              },
            ]
          : [],
      githubRepositoryId: id,
      installedSkillHash: null,
      installedSkillVersion: null,
      lastError: status === "error" ? "GitHub read failed" : null,
      setupBranchName: status === "pr_open" ? "wallie/setup-app" : null,
      setupPrNumber: status === "pr_open" ? 12 : null,
      setupPrUrl: status === "pr_open" ? "https://github.com/acme/app/pull/12" : null,
      status,
      updatedAt: null,
    },
    profile: null,
    repoId: 100,
  };
}

function github(overrides: Partial<SettingsPageData["github"]> = {}): SettingsPageData["github"] {
  return {
    installation: {
      appId: 123,
      id: "installation-1",
      installationId: 456,
      installationUrl: "https://github.com/settings/installations/456",
      permissions: {},
      suspended: false,
      targetName: "acme",
      targetType: "Organization",
      updatedAt: "2026-05-16T18:00:00.000Z",
    },
    missingAppKeys: [],
    missingWebhookKeys: [],
    primaryProfile: null,
    repositories: [
      repository("not-set-up", "not_set_up"),
      repository("pr-open", "pr_open"),
      repository("ready", "ready"),
      repository("conflict", "conflict"),
      repository("error", "error"),
    ],
    ...overrides,
  };
}

function renderSection(data: SettingsPageData["github"]) {
  return renderToStaticMarkup(
    React.createElement(GitHubInstallSection, {
      canManage: true,
      github: data,
      setFlashMessage: () => undefined,
      workspaceId: "00000000-0000-4000-8000-000000000001",
    }),
  );
}

describe("GitHubInstallSection", () => {
  it("renders the settings install action when GitHub is not connected", () => {
    const markup = renderSection(github({ installation: null }));

    expect(markup).toContain("Not connected");
    expect(markup).toContain("Install GitHub App");
  });

  it("renders refresh, manage, repository setup actions, and inline setup states", () => {
    const markup = renderSection(github());

    expect(markup).toContain("Connected");
    expect(markup).toContain("Refresh repositories");
    expect(markup).toContain("Manage on GitHub");
    expect(markup).toContain("Set up Wallie");
    expect(markup).toContain("Not set up");
    expect(markup).toContain("Setup PR open");
    expect(markup).toContain("Ready");
    expect(markup).toContain("Conflict");
    expect(markup).toContain("Error");
    expect(markup).toContain("Existing skill files need review.");
    expect(markup).toContain("GitHub read failed");
  });
});
