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

  return (
    <Section title="GitHub">
      <div className="space-y-4">
        <ConfigState missingKeys={github.missingAppKeys} title="GitHub install flow disabled" />
        <ConfigState
          missingKeys={github.missingWebhookKeys.filter(
            (key) => !github.missingAppKeys.includes(key),
          )}
          title="GitHub webhook sync disabled"
        />

        {githubInstallation ? (
          <div className="ui-subpanel space-y-4 p-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-1">
                <p className="text-sm font-semibold text-foreground">
                  Connected to{" "}
                  {githubInstallation.targetType.charAt(0).toUpperCase() +
                    githubInstallation.targetType.slice(1).toLowerCase()}{" "}
                  <span className="font-mono">{githubInstallation.targetName}</span>
                </p>
                <p className="text-sm text-muted">
                  Installation #{githubInstallation.installationId} · last synced{" "}
                  {dateFormatter.format(new Date(githubInstallation.updatedAt))}
                </p>
                {githubInstallation.suspended ? (
                  <p className="text-sm font-semibold text-amber-950">
                    GitHub marked this installation as suspended.
                  </p>
                ) : null}
              </div>

              <div className="flex flex-wrap gap-3">
                <button
                  className="ui-button"
                  disabled={!canManage || refreshRepositories.isBusy}
                  onClick={() => void refreshRepositories.run()}
                  type="button"
                >
                  {refreshRepositories.isBusy ? "Refreshing…" : "Refresh Repositories"}
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

            <div className="space-y-3">
              {repositories.length === 0 ? (
                <div className="ui-muted-panel p-4 text-sm leading-6 text-muted">
                  No repositories are synced yet.
                </div>
              ) : (
                repositories.map((repository) => (
                  <div className="ui-muted-panel space-y-3 p-4" key={repository.id}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-2">
                        <a
                          className={`text-sm ${interactiveLinkClass}`}
                          href={repository.htmlUrl}
                          rel="noreferrer"
                          target="_blank"
                        >
                          {repository.fullName}
                        </a>
                        <div className="flex flex-wrap gap-2 text-xs uppercase tracking-[0.16em] text-muted">
                          <span>{repository.defaultProgrammingLanguage ?? "language unknown"}</span>
                          <span>{repository.defaultBranch ?? "no default branch"}</span>
                          {repository.isPrivate ? <span>private</span> : <span>public</span>}
                          {repository.isArchived ? <span>archived</span> : null}
                          <span>{onboardingLabel(repository.onboarding.status)}</span>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {repository.onboarding.setupPrUrl ? (
                          <a
                            className="ui-button"
                            href={repository.onboarding.setupPrUrl}
                            rel="noreferrer"
                            target="_blank"
                          >
                            View Setup PR
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
                    {repository.description ? (
                      <p className="text-sm leading-6 text-muted">{repository.description}</p>
                    ) : null}
                    {repository.onboarding.status === "conflict" ? (
                      <div className="rounded-[6px] border border-warning/20 bg-warning-soft px-3 py-2 text-xs leading-5 text-warning">
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
                      <p className="text-xs leading-5 text-danger">
                        {repository.onboarding.lastError}
                      </p>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </div>
        ) : (
          <div className="ui-subpanel space-y-4 p-4">
            <div className="space-y-2">
              <p className="text-sm leading-7 text-foreground">
                Install the workspace GitHub App so PR status appears on each issue automatically
                and Wallie can open PRs from agent runs.
              </p>
              <p className="text-xs leading-6 text-muted">
                Workspace admins only. The app requests read access to repositories and metadata,
                plus write access to pull requests on the repos you select during install.
              </p>
            </div>
            <button
              className="ui-button-primary"
              disabled={!canManage || !hasGitHubAppConfig || launchInstall.isBusy}
              onClick={() => void launchInstall.run()}
              type="button"
            >
              {launchInstall.isBusy ? "Preparing Install…" : "Install GitHub App"}
            </button>
          </div>
        )}
      </div>
    </Section>
  );
}
