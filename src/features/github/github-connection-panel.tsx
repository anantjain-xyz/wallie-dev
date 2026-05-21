"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ArchiveIcon, BranchIcon, CodeIcon, GlobeIcon, LockIcon } from "@/components/shared/icons";
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
  allowManualSetupComplete?: boolean;
  selectedRepositoryId?: string | null;
  setFlashMessage?: (message: FlashMessage) => void;
  setupActionScope?: "all" | "none" | "selected";
  source?: "onboarding" | "settings";
  workspaceId: string;
};

function noopFlashMessage() {
  return undefined;
}

function RepoPropertyIcon({
  type,
}: {
  type: "archived" | "branch" | "language" | "private" | "public";
}) {
  const className = "h-3.5 w-3.5 text-muted";

  if (type === "language") return <CodeIcon className={className} />;
  if (type === "branch") return <BranchIcon className={className} />;
  if (type === "archived") return <ArchiveIcon className={className} />;
  if (type === "private") return <LockIcon className={className} />;
  return <GlobeIcon className={className} />;
}

function RepoPropertyPill({
  icon,
  label,
  monospace = false,
  value,
}: {
  icon: "archived" | "branch" | "language" | "private" | "public";
  label: string;
  monospace?: boolean;
  value: string;
}) {
  return (
    <span aria-label={`${label}: ${value}`} className="ui-pill" title={`${label}: ${value}`}>
      <RepoPropertyIcon type={icon} />
      <span className={monospace ? "font-mono" : undefined}>{value}</span>
    </span>
  );
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

export function mergeRepositoryOnboardingState(
  repositories: readonly WorkspaceGitHubRepository[],
  repositoryId: string,
  onboarding: RepositoryOnboardingState,
): WorkspaceGitHubRepository[] {
  return repositories.map((repository) =>
    repository.id === repositoryId ? { ...repository, onboarding } : repository,
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
  allowManualSetupComplete = false,
  selectedRepositoryId,
  setFlashMessage = noopFlashMessage,
  setupActionScope = "all",
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

  const startOnboarding = useApiAction<RepositoryOnboardingResponse, [repositoryId: string]>({
    call: (repositoryId) =>
      fetch(`/api/workspaces/${workspaceId}/repositories/${repositoryId}/onboarding`, {
        method: "POST",
      }),
    errorText: "Wallie setup failed.",
    onSuccess: (payload, [repositoryId]) => {
      const nextRepositories = mergeRepositoryOnboardingState(
        latestRepositoriesRef.current,
        repositoryId,
        payload.onboarding,
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

  const markOnboardingReady = useApiAction<RepositoryOnboardingResponse, [repositoryId: string]>({
    call: (repositoryId) =>
      fetch(`/api/workspaces/${workspaceId}/repositories/${repositoryId}/onboarding`, {
        body: JSON.stringify({ action: "mark_ready" }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "PATCH",
      }),
    errorText: "Manual Wallie setup confirmation failed.",
    onSuccess: (payload, [repositoryId]) => {
      const nextRepositories = mergeRepositoryOnboardingState(
        latestRepositoriesRef.current,
        repositoryId,
        payload.onboarding,
      );
      if (!isControlled) setLocalRepositories(nextRepositories);
      emitChange({ repositories: nextRepositories });
    },
    setFlashMessage,
    successText: "Repository marked ready for Wallie.",
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
            const showSetupAction =
              setupActionScope === "all" || (setupActionScope === "selected" && selected);
            const showInstallSkillsAction =
              showSetupAction && repository.onboarding.status !== "ready";
            const showManualSetupComplete =
              allowManualSetupComplete &&
              showSetupAction &&
              repository.onboarding.status !== "ready";
            const showSetupHelp = source === "onboarding" && showInstallSkillsAction;
            const setupActionBusy = startOnboarding.isBusy || markOnboardingReady.isBusy;
            return (
              <li className="flex flex-col gap-3 px-5 py-4" key={repository.id}>
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
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
                        <RepoPropertyPill
                          icon="language"
                          label="Language"
                          value={repository.defaultProgrammingLanguage}
                        />
                      ) : null}
                      {repository.defaultBranch ? (
                        <RepoPropertyPill
                          icon="branch"
                          label="Default branch"
                          monospace
                          value={repository.defaultBranch}
                        />
                      ) : null}
                      <RepoPropertyPill
                        icon={repository.isPrivate ? "private" : "public"}
                        label="Visibility"
                        value={repository.isPrivate ? "Private" : "Public"}
                      />
                      {repository.isArchived ? (
                        <RepoPropertyPill icon="archived" label="Status" value="Archived" />
                      ) : null}
                    </div>
                    {repository.description ? (
                      <p className="text-[13px] leading-5 text-muted">{repository.description}</p>
                    ) : null}
                    {showSetupHelp ? (
                      <p className="max-w-[640px] text-[12px] leading-5 text-muted">
                        Install skills opens a pull request that adds Wallie&apos;s repo-local
                        workflow skills under{" "}
                        <span className="font-mono text-foreground">.agents/skills</span>. Mark
                        skills as installed if they already exist in the repository.
                      </p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                    {onSelectRepository && !selected ? (
                      <button
                        className="ui-button"
                        disabled={!canManage}
                        onClick={() => onSelectRepository(repository.id)}
                        type="button"
                      >
                        Select
                      </button>
                    ) : null}
                    {showSetupAction && repository.onboarding.setupPrUrl ? (
                      <a
                        className="ui-button"
                        href={repository.onboarding.setupPrUrl}
                        rel="noreferrer"
                        target="_blank"
                      >
                        View setup PR
                      </a>
                    ) : null}
                    {showInstallSkillsAction ? (
                      <button
                        className="ui-button-primary"
                        disabled={!canManage || repository.isArchived || setupActionBusy}
                        onClick={() => void startOnboarding.run(repository.id)}
                        type="button"
                      >
                        {startOnboarding.isBusy ? "Installing..." : "Install skills"}
                      </button>
                    ) : null}
                    {showManualSetupComplete ? (
                      <button
                        className="ui-button"
                        disabled={!canManage || repository.isArchived || setupActionBusy}
                        onClick={() => void markOnboardingReady.run(repository.id)}
                        type="button"
                      >
                        {markOnboardingReady.isBusy
                          ? "Marking installed..."
                          : "Mark skills as installed"}
                      </button>
                    ) : null}
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
