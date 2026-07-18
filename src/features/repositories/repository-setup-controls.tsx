"use client";

import { ArchiveIcon } from "@/components/shared/icons/archive-icon";
import { BranchIcon } from "@/components/shared/icons/branch-icon";
import { CodeIcon } from "@/components/shared/icons/code-icon";
import { GlobeIcon } from "@/components/shared/icons/globe-icon";
import { LockIcon } from "@/components/shared/icons/lock-icon";
import { Status, type StatusValue } from "@/components/ui/status";
import { MetadataItem, MetadataList } from "@/components/ui/page-shell";
import type { WorkspaceGitHubRepository } from "@/features/github/data";
import type { FlashMessage } from "@/features/settings/settings-types";
import { useApiAction } from "@/features/settings/use-api-action";
import { CURRENT_WALLIE_SKILL_VERSION } from "@/lib/repo-onboarding/contracts";
import type {
  RepositoryOnboardingResponse,
  RepositoryOnboardingState,
  RepositoryOnboardingStatus,
} from "@/lib/repo-onboarding/contracts";

type RepositorySetupControlsProps = {
  canManage: boolean;
  onChange: (repositoryId: string, onboarding: RepositoryOnboardingState) => void;
  repository: WorkspaceGitHubRepository;
  setMessage?: (message: FlashMessage) => void;
  showManualSetupComplete?: boolean;
  workspaceId: string;
};

function noopMessage() {
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

function RepositoryProperty({
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
    <MetadataItem
      aria-label={`${label}: ${value}`}
      className="flex items-center gap-1.5 border-0 py-0"
      label={
        <span className="inline-flex items-center gap-1">
          <RepoPropertyIcon type={icon} />
          {label}
        </span>
      }
      monospace={monospace}
      value={value}
    />
  );
}

export function RepositoryMetadata({ repository }: { repository: WorkspaceGitHubRepository }) {
  return (
    <MetadataList className="flex flex-wrap items-center gap-x-4 gap-y-1 sm:flex">
      {repository.defaultProgrammingLanguage ? (
        <RepositoryProperty
          icon="language"
          label="Language"
          value={repository.defaultProgrammingLanguage}
        />
      ) : null}
      {repository.defaultBranch ? (
        <RepositoryProperty
          icon="branch"
          label="Default branch"
          monospace
          value={repository.defaultBranch}
        />
      ) : null}
      <RepositoryProperty
        icon={repository.isPrivate ? "private" : "public"}
        label="Visibility"
        value={repository.isPrivate ? "Private" : "Public"}
      />
      {repository.isArchived ? (
        <RepositoryProperty icon="archived" label="Status" value="Archived" />
      ) : null}
    </MetadataList>
  );
}

const repositoryOnboardingStatuses = {
  conflict: { label: "Conflict", value: "needs_attention" },
  error: { label: "Error", value: "blocked" },
  not_set_up: { label: "Not set up", value: "not_started" },
  pr_open: { label: "Setup PR open", value: "awaiting_review" },
  ready: { label: "Ready", value: "healthy" },
} satisfies Record<RepositoryOnboardingStatus, { label: string; value: StatusValue }>;

export function repositorySetupCanAdvance(status: RepositoryOnboardingStatus | "placeholder") {
  return status === "pr_open" || status === "ready";
}

export function hasCurrentWallieSkills(onboarding: RepositoryOnboardingState): boolean {
  return (
    onboarding.status === "ready" &&
    onboarding.installedSkillVersion === CURRENT_WALLIE_SKILL_VERSION
  );
}

export function RepositorySetupStatus({ status }: { status: RepositoryOnboardingStatus }) {
  const definition = repositoryOnboardingStatuses[status];
  return <Status label={definition?.label} value={definition?.value as StatusValue} />;
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

export function RepositorySetupMessages({ repository }: { repository: WorkspaceGitHubRepository }) {
  return (
    <>
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
        <p className="text-xs leading-5 text-danger">{repository.onboarding.lastError}</p>
      ) : null}
    </>
  );
}

export function RepositorySetupControls({
  canManage,
  onChange,
  repository,
  setMessage = noopMessage,
  showManualSetupComplete = true,
  workspaceId,
}: RepositorySetupControlsProps) {
  const startOnboarding = useApiAction<RepositoryOnboardingResponse, [repositoryId: string]>({
    call: (repositoryId) =>
      fetch(`/api/workspaces/${workspaceId}/repositories/${repositoryId}/onboarding`, {
        method: "POST",
      }),
    errorText: "Wallie setup failed.",
    onSuccess: (payload, [repositoryId]) => {
      onChange(repositoryId, payload.onboarding);
    },
    setFlashMessage: setMessage,
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
      onChange(repositoryId, payload.onboarding);
    },
    setFlashMessage: setMessage,
    successText: "Repository marked ready for Wallie.",
  });

  const setupSkillsAreCurrent = hasCurrentWallieSkills(repository.onboarding);
  const showInstallSkillsAction =
    repository.onboarding.status !== "ready" || !setupSkillsAreCurrent;
  const showManualSetupAction = showManualSetupComplete && repository.onboarding.status !== "ready";
  const setupActionBusy = startOnboarding.isBusy || markOnboardingReady.isBusy;
  const setupActionText =
    repository.onboarding.status === "ready"
      ? startOnboarding.isBusy
        ? "Updating…"
        : "Update skills"
      : startOnboarding.isBusy
        ? "Installing…"
        : "Install skills";

  return (
    <>
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
      {showInstallSkillsAction ? (
        <button
          className="ui-button-primary"
          disabled={!canManage || repository.isArchived || setupActionBusy}
          onClick={() => void startOnboarding.run(repository.id)}
          type="button"
        >
          {setupActionText}
        </button>
      ) : null}
      {showManualSetupAction ? (
        <button
          className="ui-button"
          disabled={!canManage || repository.isArchived || setupActionBusy}
          onClick={() => void markOnboardingReady.run(repository.id)}
          type="button"
        >
          {markOnboardingReady.isBusy ? "Marking installed…" : "Mark skills as installed"}
        </button>
      ) : null}
    </>
  );
}
