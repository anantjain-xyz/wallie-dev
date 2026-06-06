"use client";

import { ArchiveIcon, BranchIcon, CodeIcon, GlobeIcon, LockIcon } from "@/components/shared/icons";
import type { WorkspaceGitHubRepository } from "@/features/github/data";
import type { FlashMessage } from "@/features/settings/settings-types";
import { StatusBadge } from "@/features/settings/settings-ui";
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

export function RepositoryPropertyPill({
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

export function RepositoryMetadataPills({ repository }: { repository: WorkspaceGitHubRepository }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {repository.defaultProgrammingLanguage ? (
        <RepositoryPropertyPill
          icon="language"
          label="Language"
          value={repository.defaultProgrammingLanguage}
        />
      ) : null}
      {repository.defaultBranch ? (
        <RepositoryPropertyPill
          icon="branch"
          label="Default branch"
          monospace
          value={repository.defaultBranch}
        />
      ) : null}
      <RepositoryPropertyPill
        icon={repository.isPrivate ? "private" : "public"}
        label="Visibility"
        value={repository.isPrivate ? "Private" : "Public"}
      />
      {repository.isArchived ? (
        <RepositoryPropertyPill icon="archived" label="Status" value="Archived" />
      ) : null}
    </div>
  );
}

export function repositoryOnboardingLabel(status: RepositoryOnboardingStatus): string {
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
  status: RepositoryOnboardingStatus,
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

export function repositorySetupCanAdvance(status: RepositoryOnboardingStatus | "placeholder") {
  return status === "pr_open" || status === "ready";
}

export function hasCurrentWallieSkills(onboarding: RepositoryOnboardingState): boolean {
  return (
    onboarding.status === "ready" &&
    onboarding.installedSkillVersion === CURRENT_WALLIE_SKILL_VERSION
  );
}

export function RepositorySetupStatusBadge({ status }: { status: RepositoryOnboardingStatus }) {
  return (
    <StatusBadge tone={repositoryOnboardingBadgeTone(status)}>
      {repositoryOnboardingLabel(status)}
    </StatusBadge>
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

export function RepositorySetupMessages({ repository }: { repository: WorkspaceGitHubRepository }) {
  return (
    <>
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
        <p className="text-[12px] leading-5 text-danger">{repository.onboarding.lastError}</p>
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
        ? "Updating..."
        : "Update skills"
      : startOnboarding.isBusy
        ? "Installing..."
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
          {markOnboardingReady.isBusy ? "Marking installed..." : "Mark skills as installed"}
        </button>
      ) : null}
    </>
  );
}
