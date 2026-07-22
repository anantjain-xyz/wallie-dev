"use client";

import { ArchiveIcon } from "@/components/shared/icons/archive-icon";
import { BranchIcon } from "@/components/shared/icons/branch-icon";
import { CodeIcon } from "@/components/shared/icons/code-icon";
import { GlobeIcon } from "@/components/shared/icons/globe-icon";
import { LockIcon } from "@/components/shared/icons/lock-icon";
import { Status, type StatusValue } from "@/components/ui/status";
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
    <div
      aria-label={`${label}: ${value}`}
      className="grid min-w-0 flex-1 content-start grid-cols-[1rem_minmax(0,1fr)] items-center gap-x-2 border-t border-border/70 px-3 py-2.5 first:border-t-0 sm:border-l sm:border-t-0 sm:first:border-l-0"
    >
      <dt className="col-span-2 grid grid-cols-[1rem_minmax(0,1fr)] items-center gap-x-2 text-xs font-semibold uppercase leading-4 tracking-[0.08em] text-muted">
        <span>
          <RepoPropertyIcon type={icon} />
        </span>
        <span>{label}</span>
      </dt>
      <dd
        className={`col-start-2 min-w-0 break-words text-[13px] font-medium leading-5 text-foreground${monospace ? " font-mono" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}

export function RepositoryMetadata({ repository }: { repository: WorkspaceGitHubRepository }) {
  return (
    <dl className="flex flex-col overflow-hidden rounded-[6px] border border-border/70 bg-canvas/40 sm:flex-row">
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
    </dl>
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
