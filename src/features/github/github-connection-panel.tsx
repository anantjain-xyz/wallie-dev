"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import type {
  GitHubInstallResponse,
  GitHubRepositorySummary,
  GitHubRepositorySyncResponse,
} from "@/features/github/contracts";
import type { WorkspaceGitHubData, WorkspaceGitHubRepository } from "@/features/github/data";
import { notifySessionRepositoriesChanged } from "@/features/sessions/session-repository-cache-events";
import type { FlashMessage } from "@/features/settings/settings-types";
import { ConfigState, dateFormatter, interactiveLinkClass } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import type { RepositoryOnboardingState } from "@/lib/repo-onboarding/contracts";

export { mergeRepositoryOnboardingState } from "@/features/repositories/repository-setup-controls";

// Deep link to the "Create the production GitHub App" section of the self-hosting
// guide so a self-hoster on the blocked GitHub step can reach setup instructions
// without leaving the page blind.
const GITHUB_APP_SETUP_DOCS_URL =
  "https://github.com/anantjain-xyz/wallie-dev/blob/main/docs/deployment/self-hosting.md#5-create-the-production-github-app";

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
  const webhookKeys = github.missingWebhookKeys.filter(
    (key) => !github.missingAppKeys.includes(key),
  );
  const syncBlocked = github.missingAppKeys.some((key) => github.missingWebhookKeys.includes(key));

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
      notifySessionRepositoriesChanged(workspaceId);
    },
    setFlashMessage,
    successText: "GitHub repositories refreshed.",
  });

  const settingsDiagnostics = source === "settings" &&
    (!hasGitHubAppConfig ||
      github.missingWebhookKeys.length > 0 ||
      Boolean(githubInstallation)) && (
      <div className="space-y-2 type-secondary text-muted">
        {!hasGitHubAppConfig ? (
          <p className="text-warning">
            {githubInstallation && syncBlocked
              ? "Repository sync and new installations are"
              : "GitHub App installation is"}{" "}
            blocked by missing server configuration.{" "}
            <a
              className="font-medium underline"
              href={GITHUB_APP_SETUP_DOCS_URL}
              rel="noreferrer"
              target="_blank"
            >
              GitHub App setup guide
            </a>
          </p>
        ) : null}
        {github.missingWebhookKeys.length ? (
          <p className="text-warning">
            GitHub delivery updates are off until webhooks are configured.
          </p>
        ) : null}
        <details>
          <summary className="w-fit cursor-pointer hover:text-foreground">
            GitHub deployment details
          </summary>
          <div className="mt-2 space-y-1 [overflow-wrap:anywhere]">
            {!hasGitHubAppConfig ? (
              <p>App configuration: {github.missingAppKeys.join(", ")}</p>
            ) : null}
            {webhookKeys.length ? <p>Webhook configuration: {webhookKeys.join(", ")}</p> : null}
            {githubInstallation ? (
              <p>
                Installation #{githubInstallation.installationId} · last synced{" "}
                {dateFormatter.format(new Date(githubInstallation.updatedAt))}
              </p>
            ) : null}
          </div>
        </details>
      </div>
    );
  const onboardingDiagnostics = source === "onboarding" && (
    <>
      <ConfigState missingKeys={github.missingAppKeys} title="GitHub install flow disabled" />
      <ConfigState missingKeys={webhookKeys} title="GitHub webhook sync disabled" />
    </>
  );

  if (!githubInstallation) {
    return (
      <div className={source === "settings" ? "space-y-3" : "space-y-6"}>
        {hasGitHubAppConfig || source !== "onboarding" ? null : (
          <div className="space-y-3 rounded-[6px] border border-border bg-control-hover px-5 py-4">
            <p className="text-[14px] font-semibold text-foreground">
              Wallie needs a GitHub App to read your repositories
            </p>
            <p className="text-[13px] leading-6 text-muted">
              Wallie reads the repositories you pick and opens pull requests through a GitHub App.
              This self-hosted instance does not have one configured yet, so the install flow below
              stays off until you create the App and add its credentials as environment variables.
            </p>
            <p className="text-[13px] leading-6 text-muted">
              The{" "}
              <a
                className={interactiveLinkClass}
                href={GITHUB_APP_SETUP_DOCS_URL}
                rel="noreferrer"
                target="_blank"
              >
                GitHub App setup guide
              </a>{" "}
              walks through creating the App and shows where each value goes.
            </p>
          </div>
        )}
        {onboardingDiagnostics}
        {settingsDiagnostics}
        <div className="flex flex-wrap items-center justify-between gap-4">
          {hasGitHubAppConfig || source === "onboarding" ? (
            <p className="max-w-2xl text-[13px] leading-6 text-muted">
              {hasGitHubAppConfig
                ? "The app requests read and write access to repository contents and pull requests, plus read access to metadata. This lets Wallie prepare your repository and publish changes on the repos you select during install."
                : "Once these variables are set and the app restarts, the install button turns on. You cannot finish this step or continue until the App is installed and a repository is connected."}
            </p>
          ) : null}
          <button
            className="ui-button-primary"
            disabled={!canManage || !hasGitHubAppConfig || launchInstall.isBusy}
            onClick={() => void launchInstall.run()}
            title={
              hasGitHubAppConfig
                ? undefined
                : "Set the missing GitHub App variables, then restart the app to enable install."
            }
            type="button"
          >
            {launchInstall.isBusy ? "Preparing install…" : "Install GitHub App"}
          </button>
          {source === "settings" && !canManage ? (
            <p className="type-secondary text-muted">
              A workspace admin can install the GitHub App.
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className={source === "settings" ? "space-y-3" : "space-y-6"}>
      {onboardingDiagnostics}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className={source === "settings" ? "min-w-0 space-y-1" : "space-y-1"}>
          <p className="text-[14px] font-medium text-foreground">
            {source === "settings" && githubInstallation.suspended
              ? "Installation for"
              : "Connected to"}{" "}
            {githubInstallation.targetType.charAt(0).toUpperCase() +
              githubInstallation.targetType.slice(1).toLowerCase()}{" "}
            <span
              className={source === "settings" ? "font-mono [overflow-wrap:anywhere]" : "font-mono"}
            >
              {githubInstallation.targetName}
            </span>
          </p>
          {source === "onboarding" ? (
            <p className="text-xs leading-5 text-muted">
              Installation #{githubInstallation.installationId} · last synced{" "}
              {dateFormatter.format(new Date(githubInstallation.updatedAt))}
            </p>
          ) : null}
          {source === "settings" && githubInstallation.suspended ? (
            <p className="type-secondary text-warning">
              Restore the suspended installation on GitHub before trying to refresh repositories.
            </p>
          ) : null}
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
      {settingsDiagnostics}
    </div>
  );
}
