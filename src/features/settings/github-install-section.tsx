"use client";

import Link from "next/link";
import { useState } from "react";

import type {
  GitHubInstallResponse,
  GitHubRepositorySummary,
  GitHubRepositorySyncResponse,
} from "@/features/github/contracts";
import type { SettingsPageData } from "@/features/settings/data";
import type { FlashMessage } from "@/features/settings/settings-types";
import type {
  RepositoryOnboardingResponse,
  RepositoryOnboardingState,
} from "@/lib/repo-onboarding/contracts";
import {
  ConfigState,
  dateFormatter,
  interactiveLinkClass,
  Section,
  StatusBadge,
} from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";

type GitHubInstallSectionProps = {
  canManage: boolean;
  github: SettingsPageData["github"];
  setFlashMessage: (message: FlashMessage) => void;
  workspaceId: string;
};

type RepositoryWithOnboarding = SettingsPageData["github"]["repositories"][number];

function defaultOnboarding(repositoryId: string): RepositoryOnboardingState {
  return {
    conflictReport: [],
    githubRepositoryId: repositoryId,
    installedSkillHash: null,
    installedSkillVersion: null,
    lastError: null,
    setupBranchName: null,
    setupPrNumber: null,
    setupPrUrl: null,
    status: "not_set_up",
    updatedAt: null,
  };
}

function attachOnboarding(
  repository: GitHubRepositorySummary,
  currentRepositories: readonly RepositoryWithOnboarding[],
): RepositoryWithOnboarding {
  const current = currentRepositories.find((candidate) => candidate.id === repository.id);
  return {
    ...repository,
    onboarding: current?.onboarding ?? defaultOnboarding(repository.id),
  };
}

function onboardingLabel(status: RepositoryOnboardingState["status"]): string {
  switch (status) {
    case "pr_open":
      return "Setup PR open";
    case "ready":
      return "Ready";
    case "conflict":
      return "Conflict";
    case "error":
      return "Error";
    default:
      return "Not set up";
  }
}

function onboardingBadgeTone(
  status: RepositoryOnboardingState["status"],
): "success" | "warning" | "danger" | "neutral" | "accent" {
  switch (status) {
    case "ready":
      return "success";
    case "pr_open":
      return "accent";
    case "conflict":
      return "warning";
    case "error":
      return "danger";
    default:
      return "neutral";
  }
}

export function GitHubInstallSection({
  canManage,
  github,
  setFlashMessage,
  workspaceId,
}: GitHubInstallSectionProps) {
  const [githubInstallation, setGithubInstallation] = useState(github.installation);
  const [repositories, setRepositories] = useState(github.repositories);
  const hasGitHubAppConfig = github.missingAppKeys.length === 0;

  const launchInstall = useApiAction<GitHubInstallResponse>({
    call: () =>
      fetch(`/api/github/install?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "GET",
      }),
    errorText: "GitHub install preparation failed.",
    onSuccess: (payload) => {
      window.location.assign(payload.installUrl);
    },
    setFlashMessage,
    successText: null,
  });

  const refreshRepositories = useApiAction<GitHubRepositorySyncResponse>({
    call: () =>
      fetch("/api/github/refresh-repositories", {
        body: JSON.stringify({ workspaceId }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      }),
    errorText: "GitHub repository sync failed.",
    onSuccess: (payload) => {
      setGithubInstallation(payload.installation);
      setRepositories((current) =>
        payload.repositories.map((repository) => attachOnboarding(repository, current)),
      );
    },
    setFlashMessage,
    successText: "GitHub repositories refreshed.",
  });

  const startOnboarding = useApiAction<RepositoryOnboardingResponse, [repositoryId: string]>({
    call: (repositoryId) =>
      fetch(`/api/workspaces/${workspaceId}/repositories/${repositoryId}/onboarding`, {
        method: "POST",
      }),
    errorText: "Wallie setup failed.",
    onSuccess: (payload, [repositoryId]) => {
      setRepositories((current) =>
        current.map((repository) =>
          repository.id === repositoryId
            ? { ...repository, onboarding: payload.onboarding }
            : repository,
        ),
      );
    },
    setFlashMessage,
    successText: (payload) =>
      payload.onboarding.status === "conflict"
        ? "Wallie setup found existing skill conflicts."
        : payload.onboarding.status === "ready"
          ? "Repository already has the current Wallie skills."
          : "Wallie setup PR created.",
  });

  const statusBadge = githubInstallation ? (
    githubInstallation.suspended ? (
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
      <div className="space-y-6">
        <ConfigState missingKeys={github.missingAppKeys} title="GitHub install flow disabled" />
        <ConfigState
          missingKeys={github.missingWebhookKeys.filter(
            (key) => !github.missingAppKeys.includes(key),
          )}
          title="GitHub webhook sync disabled"
        />

        {githubInstallation ? (
          <div className="space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-1">
                <p className="text-[14px] font-medium text-foreground">
                  Connected to{" "}
                  {githubInstallation.targetType.charAt(0).toUpperCase() +
                    githubInstallation.targetType.slice(1).toLowerCase()}{" "}
                  <span className="font-mono">{githubInstallation.targetName}</span>
                </p>
                <p className="text-[12px] leading-5 text-muted">
                  Installation #{githubInstallation.installationId} · last synced{" "}
                  {dateFormatter.format(new Date(githubInstallation.updatedAt))}
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  className="ui-button"
                  disabled={!canManage || refreshRepositories.isBusy}
                  onClick={() => void refreshRepositories.run()}
                  type="button"
                >
                  {refreshRepositories.isBusy ? "Refreshing…" : "Refresh repositories"}
                </button>
                <Link
                  className="ui-button"
                  href={githubInstallation.installationUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  Manage on GitHub
                </Link>
              </div>
            </div>

            {repositories.length === 0 ? (
              <p className="text-[13px] leading-6 text-muted">No repositories are synced yet.</p>
            ) : (
              <ul className="divide-y divide-border rounded-[10px] border border-border bg-surface">
                {repositories.map((repository) => (
                  <li className="flex flex-col gap-3 px-5 py-4" key={repository.id}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <a
                            className={`text-[14px] ${interactiveLinkClass}`}
                            href={repository.htmlUrl}
                            rel="noreferrer"
                            target="_blank"
                          >
                            {repository.fullName}
                          </a>
                          <StatusBadge tone={onboardingBadgeTone(repository.onboarding.status)}>
                            {onboardingLabel(repository.onboarding.status)}
                          </StatusBadge>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {repository.defaultProgrammingLanguage ? (
                            <span className="ui-pill">
                              {repository.defaultProgrammingLanguage}
                            </span>
                          ) : null}
                          {repository.defaultBranch ? (
                            <span className="ui-pill font-mono">{repository.defaultBranch}</span>
                          ) : null}
                          <span className="ui-pill">
                            {repository.isPrivate ? "Private" : "Public"}
                          </span>
                          {repository.isArchived ? (
                            <span className="ui-pill">Archived</span>
                          ) : null}
                        </div>
                        {repository.description ? (
                          <p className="text-[13px] leading-5 text-muted">
                            {repository.description}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        {repository.onboarding.setupPrUrl ? (
                          <a
                            className="ui-button"
                            href={repository.onboarding.setupPrUrl}
                            rel="noreferrer"
                            target="_blank"
                          >
                            View setup PR
                          </a>
                        ) : null}
                        <button
                          className="ui-button-primary"
                          disabled={
                            !canManage ||
                            repository.isArchived ||
                            startOnboarding.isBusy ||
                            repository.onboarding.status === "ready"
                          }
                          onClick={() => void startOnboarding.run(repository.id)}
                          type="button"
                        >
                          {startOnboarding.isBusy ? "Setting up…" : "Set up Wallie"}
                        </button>
                      </div>
                    </div>
                    {repository.onboarding.status === "conflict" ? (
                      <div className="rounded-[6px] border border-warning/20 bg-warning-soft px-3 py-2 text-[12px] leading-5 text-warning">
                        <p className="font-semibold">Existing skill files need review.</p>
                        <ul className="mt-1 space-y-1">
                          {repository.onboarding.conflictReport.map((conflict) => (
                            <li key={conflict.path}>
                              <span className="font-mono">{conflict.path}</span>: {conflict.message}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {repository.onboarding.lastError ? (
                      <p className="text-[12px] leading-5 text-danger">
                        {repository.onboarding.lastError}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="max-w-2xl text-[13px] leading-6 text-muted">
              The app requests read access to repositories and metadata, plus write access to pull
              requests on the repos you select during install.
            </p>
            <button
              className="ui-button-primary"
              disabled={!canManage || !hasGitHubAppConfig || launchInstall.isBusy}
              onClick={() => void launchInstall.run()}
              type="button"
            >
              {launchInstall.isBusy ? "Preparing install…" : "Install GitHub App"}
            </button>
          </div>
        )}
      </div>
    </Section>
  );
}
