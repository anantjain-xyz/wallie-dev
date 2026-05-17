"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";

import type {
  GitHubInstallResponse,
  GitHubRepositorySummary,
  GitHubRepositorySyncResponse,
} from "@/features/github/contracts";
import type { WorkspaceGitHubData, WorkspaceGitHubRepository } from "@/features/github/data";
import type { FlashMessage } from "@/features/settings/settings-types";
import type {
  RepositoryOnboardingResponse,
  RepositoryOnboardingState,
} from "@/lib/repo-onboarding/contracts";
import {
  ConfigState,
  dateFormatter,
  interactiveLinkClass,
  StatusBadge,
} from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";

type GitHubConnectionPanelProps = {
  canManage: boolean;
  github: WorkspaceGitHubData;
  hideArchivedRepositories?: boolean;
  onChange?: (github: WorkspaceGitHubData) => void;
  onSelectRepository?: (repositoryId: string) => void;
  renderRepositoryDetails?: (repository: WorkspaceGitHubRepository) => ReactNode;
  selectedRepositoryId?: string | null;
  setFlashMessage?: (message: FlashMessage) => void;
  source?: "onboarding" | "settings";
  workspaceId: string;
};

function noopFlashMessage() {
  return undefined;
}

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

function attachRepositoryState(
  repository: GitHubRepositorySummary,
  currentRepositories: readonly WorkspaceGitHubRepository[],
): WorkspaceGitHubRepository {
  const current = currentRepositories.find((candidate) => candidate.id === repository.id);
  return {
    ...repository,
    onboarding: current?.onboarding ?? defaultOnboarding(repository.id),
    profile: current?.profile ?? null,
  };
}

export function primaryProfileForRepositories(
  github: Pick<WorkspaceGitHubData, "primaryProfile">,
  repositories: readonly WorkspaceGitHubRepository[],
): WorkspaceGitHubData["primaryProfile"] {
  if (!github.primaryProfile) return null;
  return (
    repositories.find((repository) => repository.id === github.primaryProfile?.githubRepositoryId)
      ?.profile ?? null
  );
}

export function repositoryOnboardingLabel(status: RepositoryOnboardingState["status"]): string {
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

export function repositoryOnboardingBadgeTone(
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

export function GitHubConnectionPanel({
  canManage,
  github,
  hideArchivedRepositories = false,
  onChange,
  onSelectRepository,
  renderRepositoryDetails,
  selectedRepositoryId,
  setFlashMessage = noopFlashMessage,
  source = "settings",
  workspaceId,
}: GitHubConnectionPanelProps) {
  const [localGithubInstallation, setLocalGithubInstallation] = useState(github.installation);
  const [localRepositories, setLocalRepositories] = useState(github.repositories);
  const isControlled = Boolean(onChange);
  const githubInstallation = isControlled ? github.installation : localGithubInstallation;
  const repositories = isControlled ? github.repositories : localRepositories;
  const hasGitHubAppConfig = github.missingAppKeys.length === 0;

  function emitChange(next: Partial<WorkspaceGitHubData>) {
    const nextPrimaryProfile = Object.prototype.hasOwnProperty.call(next, "primaryProfile")
      ? (next.primaryProfile ?? null)
      : github.primaryProfile;

    onChange?.({
      ...github,
      installation: next.installation ?? githubInstallation,
      repositories: next.repositories ?? repositories,
      primaryProfile: nextPrimaryProfile,
    });
  }

  const launchInstall = useApiAction<GitHubInstallResponse>({
    call: () => {
      const params = new URLSearchParams({ workspaceId });
      if (source === "onboarding") params.set("source", "onboarding");
      return fetch(`/api/github/install?${params.toString()}`, {
        method: "GET",
      });
    },
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
      const nextRepositories = payload.repositories.map((repository) =>
        attachRepositoryState(repository, repositories),
      );
      const nextPrimaryProfile = primaryProfileForRepositories(github, nextRepositories);
      if (!isControlled) {
        setLocalGithubInstallation(payload.installation);
        setLocalRepositories(nextRepositories);
      }
      emitChange({
        installation: payload.installation,
        primaryProfile: nextPrimaryProfile,
        repositories: nextRepositories,
      });
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
      const nextRepositories = repositories.map((repository) =>
        repository.id === repositoryId
          ? { ...repository, onboarding: payload.onboarding }
          : repository,
      );
      if (!isControlled) setLocalRepositories(nextRepositories);
      emitChange({ repositories: nextRepositories });
    },
    setFlashMessage,
    successText: (payload) =>
      payload.onboarding.status === "conflict"
        ? "Wallie setup found existing skill conflicts."
        : payload.onboarding.status === "ready"
          ? "Repository already has the current Wallie skills."
          : "Wallie setup PR created.",
  });

  const visibleRepositories = useMemo(
    () =>
      hideArchivedRepositories
        ? repositories.filter((repository) => !repository.isArchived)
        : repositories,
    [hideArchivedRepositories, repositories],
  );

  if (!githubInstallation) {
    return (
      <div className="space-y-6">
        <ConfigState missingKeys={github.missingAppKeys} title="GitHub install flow disabled" />
        <ConfigState
          missingKeys={github.missingWebhookKeys.filter(
            (key) => !github.missingAppKeys.includes(key),
          )}
          title="GitHub webhook sync disabled"
        />
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
            {launchInstall.isBusy ? "Preparing install..." : "Install GitHub App"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ConfigState missingKeys={github.missingAppKeys} title="GitHub install flow disabled" />
      <ConfigState
        missingKeys={github.missingWebhookKeys.filter(
          (key) => !github.missingAppKeys.includes(key),
        )}
        title="GitHub webhook sync disabled"
      />

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
            {refreshRepositories.isBusy ? "Refreshing..." : "Refresh repositories"}
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

      {visibleRepositories.length === 0 ? (
        <p className="text-[13px] leading-6 text-muted">
          {hideArchivedRepositories
            ? "No non-archived repositories are synced yet."
            : "No repositories are synced yet."}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-[10px] border border-border bg-surface">
          {visibleRepositories.map((repository) => {
            const selected = selectedRepositoryId === repository.id;
            return (
              <li className="flex flex-col gap-3 px-5 py-4" key={repository.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {onSelectRepository ? (
                        <button
                          className={`text-left text-[14px] ${interactiveLinkClass}`}
                          disabled={!canManage}
                          onClick={() => onSelectRepository(repository.id)}
                          type="button"
                        >
                          {repository.fullName}
                        </button>
                      ) : (
                        <a
                          className={`text-[14px] ${interactiveLinkClass}`}
                          href={repository.htmlUrl}
                          rel="noreferrer"
                          target="_blank"
                        >
                          {repository.fullName}
                        </a>
                      )}
                      <StatusBadge
                        tone={repositoryOnboardingBadgeTone(repository.onboarding.status)}
                      >
                        {repositoryOnboardingLabel(repository.onboarding.status)}
                      </StatusBadge>
                      {repository.profile?.isPrimary ? (
                        <StatusBadge tone="success">Primary</StatusBadge>
                      ) : null}
                      {selected ? <StatusBadge tone="accent">Selected</StatusBadge> : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {repository.defaultProgrammingLanguage ? (
                        <span className="ui-pill">{repository.defaultProgrammingLanguage}</span>
                      ) : null}
                      {repository.defaultBranch ? (
                        <span className="ui-pill font-mono">{repository.defaultBranch}</span>
                      ) : null}
                      <span className="ui-pill">{repository.isPrivate ? "Private" : "Public"}</span>
                      {repository.isArchived ? <span className="ui-pill">Archived</span> : null}
                    </div>
                    {repository.description ? (
                      <p className="text-[13px] leading-5 text-muted">{repository.description}</p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {onSelectRepository ? (
                      <button
                        className={selected ? "ui-button-primary" : "ui-button"}
                        disabled={!canManage}
                        onClick={() => onSelectRepository(repository.id)}
                        type="button"
                      >
                        {selected ? "Selected" : "Select"}
                      </button>
                    ) : null}
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
                      {startOnboarding.isBusy ? "Setting up..." : "Set up Wallie"}
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
                {selected && renderRepositoryDetails ? renderRepositoryDetails(repository) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
