"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import type {
  GitHubAuthorConnectResponse,
  GitHubInstallResponse,
  GitHubRepositorySummary,
  GitHubRepositorySyncResponse,
} from "@/features/github/contracts";
import type { WorkspaceGitHubData, WorkspaceGitHubRepository } from "@/features/github/data";
import type { FlashMessage } from "@/features/settings/settings-types";
import { ConfigState, dateFormatter } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import type { RepositoryOnboardingState } from "@/lib/repo-onboarding/contracts";

export { mergeRepositoryOnboardingState } from "@/features/repositories/repository-setup-controls";

type GitHubConnectionPanelProps = {
  canManage: boolean;
  github: WorkspaceGitHubData;
  onChange?: (github: WorkspaceGitHubData) => void;
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

export function mergeRefreshedRepositories(
  refreshedRepositories: readonly GitHubRepositorySummary[],
  currentRepositories: readonly WorkspaceGitHubRepository[],
): WorkspaceGitHubRepository[] {
  return refreshedRepositories.map((repository) =>
    attachRepositoryState(repository, currentRepositories),
  );
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

export function GitHubConnectionPanel({
  canManage,
  github,
  onChange,
  setFlashMessage = noopFlashMessage,
  source = "settings",
  workspaceId,
}: GitHubConnectionPanelProps) {
  const [localGithubInstallation, setLocalGithubInstallation] = useState(github.installation);
  const [localRepositories, setLocalRepositories] = useState(github.repositories);
  const isControlled = Boolean(onChange);
  const githubInstallation = isControlled ? github.installation : localGithubInstallation;
  const repositories = isControlled ? github.repositories : localRepositories;
  const latestGithubRef = useRef(github);
  const latestInstallationRef = useRef(githubInstallation);
  const latestRepositoriesRef = useRef(repositories);
  const hasGitHubAppConfig = github.missingAppKeys.length === 0;

  useEffect(() => {
    latestGithubRef.current = github;
  }, [github]);

  useEffect(() => {
    latestInstallationRef.current = githubInstallation;
  }, [githubInstallation]);

  useEffect(() => {
    latestRepositoriesRef.current = repositories;
  }, [repositories]);

  function emitChange(next: Partial<WorkspaceGitHubData>) {
    const currentGithub = latestGithubRef.current;
    const currentInstallation = latestInstallationRef.current;
    const currentRepositories = latestRepositoriesRef.current;
    const nextInstallation = next.installation ?? currentInstallation;
    const nextRepositories = next.repositories ?? currentRepositories;
    const nextPrimaryProfile = Object.prototype.hasOwnProperty.call(next, "primaryProfile")
      ? (next.primaryProfile ?? null)
      : currentGithub.primaryProfile;
    const nextGithub = {
      ...currentGithub,
      installation: nextInstallation,
      primaryProfile: nextPrimaryProfile,
      repositories: nextRepositories,
    };

    latestGithubRef.current = nextGithub;
    latestInstallationRef.current = nextInstallation;
    latestRepositoriesRef.current = nextRepositories;

    onChange?.(nextGithub);
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

  const launchAuthorConnect = useApiAction<GitHubAuthorConnectResponse>({
    call: () => {
      const params = new URLSearchParams({ workspaceId });
      if (source === "onboarding") params.set("source", "onboarding");
      return fetch(`/api/github/author?${params.toString()}`, {
        method: "GET",
      });
    },
    errorText: "GitHub author connection failed.",
    onSuccess: (payload) => {
      window.location.assign(payload.authorizeUrl);
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
      const nextRepositories = mergeRefreshedRepositories(
        payload.repositories,
        latestRepositoriesRef.current,
      );
      const nextPrimaryProfile = primaryProfileForRepositories(
        latestGithubRef.current,
        nextRepositories,
      );
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
  const hasGitHubAuthorConfig = github.missingAuthorKeys.length === 0;
  const authorIdentity = github.authorIdentity;

  const authorPanel = (
    <div className="flex flex-wrap items-start justify-between gap-4 border-t border-border pt-5">
      <div className="space-y-1">
        <p className="text-[14px] font-medium text-foreground">
          Commit author{" "}
          {authorIdentity ? (
            <span className="font-mono">@{authorIdentity.githubLogin}</span>
          ) : (
            <span className="text-muted">not connected</span>
          )}
        </p>
        <p className="max-w-2xl text-[12px] leading-5 text-muted">
          {authorIdentity
            ? `${authorIdentity.authorName} <${authorIdentity.authorEmail}>`
            : "Connect a GitHub account before starting Wallie runs that create PR commits."}
        </p>
      </div>
      <button
        className="ui-button"
        disabled={!hasGitHubAuthorConfig || launchAuthorConnect.isBusy}
        onClick={() => void launchAuthorConnect.run()}
        type="button"
      >
        {launchAuthorConnect.isBusy
          ? "Connecting..."
          : authorIdentity
            ? "Reconnect author"
            : "Connect author"}
      </button>
    </div>
  );

  if (!githubInstallation) {
    return (
      <div className="space-y-6">
        <ConfigState missingKeys={github.missingAppKeys} title="GitHub install flow disabled" />
        <ConfigState
          missingKeys={github.missingAuthorKeys}
          title="GitHub author connection disabled"
        />
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
        {authorPanel}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ConfigState missingKeys={github.missingAppKeys} title="GitHub install flow disabled" />
      <ConfigState
        missingKeys={github.missingAuthorKeys}
        title="GitHub author connection disabled"
      />
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
      {authorPanel}
    </div>
  );
}
