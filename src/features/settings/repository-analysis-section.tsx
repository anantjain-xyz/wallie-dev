"use client";

import { useRef, useState, type Dispatch, type SetStateAction } from "react";

import { buildOnboardingRepositorySelectionPatch } from "@/features/onboarding/flow";
import { reduceOnboardingMutationData } from "@/features/onboarding/mutation-reducer";
import { buildRepositorySetupHealth } from "@/features/onboarding/repository-health";
import { RepositoryProfileEditor } from "@/features/repository-profile/repository-profile-editor";
import { notifySessionRepositoriesChanged } from "@/features/sessions/session-repository-cache-events";
import {
  mergeRepositoryOnboardingState,
  hasCurrentWallieSkills,
  RepositoryMetadata,
  RepositorySetupControls,
  RepositorySetupMessages,
  RepositorySetupStatusBadge,
} from "@/features/repositories/repository-setup-controls";
import type { SettingsPageData } from "@/features/settings/data";
import type { FlashMessage } from "@/features/settings/settings-types";
import { Section, StatusBadge } from "@/features/settings/settings-ui";
import type {
  WorkspaceOnboardingConflictResponse,
  WorkspaceOnboardingMutationDelta,
  WorkspaceOnboardingMutationErrorResponse,
  WorkspaceOnboardingUpdatePayload,
} from "@/lib/onboarding/contracts";
import type { RepositoryProfileState } from "@/lib/repo-inference/contracts";
import type { RepositoryOnboardingState } from "@/lib/repo-onboarding/contracts";
import type { SandboxCapabilityCheckState } from "@/lib/sandbox-capabilities/contracts";

type RepositoryAnalysisSectionProps = {
  data: SettingsPageData;
  setData: Dispatch<SetStateAction<SettingsPageData>>;
  setFlashMessage: (message: FlashMessage) => void;
};

type ProfileAction = "analyzing" | "saving" | "selecting" | null;

function selectedRepositoryFromData(data: SettingsPageData) {
  const selectedRepositoryId =
    data.onboarding.selectedGithubRepositoryId ?? data.github.primaryProfile?.githubRepositoryId;
  if (!selectedRepositoryId) return null;
  return (
    data.github.repositories.find((repository) => repository.id === selectedRepositoryId) ?? null
  );
}

function initialProfileDraft(data: SettingsPageData): RepositoryProfileState | null {
  const selectedRepository = selectedRepositoryFromData(data);
  if (selectedRepository?.profile) return selectedRepository.profile;
  if (
    selectedRepository &&
    data.github.primaryProfile?.githubRepositoryId === selectedRepository.id
  ) {
    return data.github.primaryProfile;
  }
  return null;
}

export function reduceSettingsOnboardingMutationData(
  current: SettingsPageData,
  response: WorkspaceOnboardingMutationDelta | WorkspaceOnboardingConflictResponse,
): SettingsPageData {
  const next = reduceOnboardingMutationData(current, response);
  return {
    ...next,
    latestSandboxCapabilityCheck: next.setupHealth.latestSandboxCapabilityCheck,
  };
}

export function buildSettingsRepositorySelectionMutation(
  onboarding: SettingsPageData["onboarding"],
  changes: WorkspaceOnboardingUpdatePayload,
) {
  return {
    action: "repository-selection" as const,
    changes,
    expectedUpdatedAt: onboarding.updatedAt,
    step: "repository" as const,
  };
}

function applySavedRepositoryProfile(
  current: SettingsPageData,
  profile: RepositoryProfileState,
  latestSandboxCapabilityCheck: SandboxCapabilityCheckState | null,
): SettingsPageData {
  const github = {
    ...current.github,
    primaryProfile: profile,
    repositories: current.github.repositories.map((repository) => ({
      ...repository,
      profile:
        repository.id === profile.githubRepositoryId
          ? profile
          : repository.profile
            ? { ...repository.profile, isPrimary: false }
            : null,
    })),
  };

  return {
    ...current,
    github,
    latestSandboxCapabilityCheck,
    setupHealth: {
      ...current.setupHealth,
      ...buildRepositorySetupHealth(github, current.onboarding.selectedGithubRepositoryId),
      latestSandboxCapabilityCheck,
    },
  };
}

function applyRepositoryOnboarding(
  current: SettingsPageData,
  repositoryId: string,
  onboarding: RepositoryOnboardingState,
): SettingsPageData {
  const github = {
    ...current.github,
    repositories: mergeRepositoryOnboardingState(
      current.github.repositories,
      repositoryId,
      onboarding,
    ),
  };

  return {
    ...current,
    github,
    setupHealth: {
      ...current.setupHealth,
      ...buildRepositorySetupHealth(github, current.onboarding.selectedGithubRepositoryId),
    },
  };
}

export function RepositoryAnalysisSection({
  data,
  setData,
  setFlashMessage,
}: RepositoryAnalysisSectionProps) {
  const selectableRepositories = data.github.repositories.filter(
    (repository) => !repository.isArchived,
  );
  const selectedRepository = selectedRepositoryFromData(data);
  const [profileDraft, setProfileDraft] = useState<RepositoryProfileState | null>(() =>
    initialProfileDraft(data),
  );
  const [profileDirty, setProfileDirty] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileAction, setProfileAction] = useState<ProfileAction>(null);
  const activeRepositoryRef = useRef(selectedRepository?.id ?? null);
  const selectedRepositoryId = selectedRepository?.id ?? null;
  const profileBusy = profileAction !== null;

  function updateProfileDraft(nextProfile: RepositoryProfileState, dirty = false) {
    setProfileDraft(nextProfile);
    setProfileDirty(dirty);
  }

  async function selectRepository(repositoryId: string): Promise<boolean> {
    const repository = data.github.repositories.find((candidate) => candidate.id === repositoryId);
    if (!repository || profileBusy) return false;

    setProfileError(null);
    setProfileAction("selecting");
    activeRepositoryRef.current = repository.id;

    const patch = buildOnboardingRepositorySelectionPatch(
      data.onboarding,
      repository.id,
      selectedRepositoryFromData(data)?.id ?? null,
    );

    try {
      if (patch) {
        const response = await fetch(`/api/workspaces/${data.workspace.id}/onboarding`, {
          body: JSON.stringify(buildSettingsRepositorySelectionMutation(data.onboarding, patch)),
          headers: { "content-type": "application/json" },
          method: "PATCH",
        });
        const body = (await response.json().catch(() => null)) as
          | WorkspaceOnboardingConflictResponse
          | WorkspaceOnboardingMutationDelta
          | WorkspaceOnboardingMutationErrorResponse
          | null;

        if (body?.kind === "onboarding-conflict") {
          setData((current) => reduceSettingsOnboardingMutationData(current, body));
          throw new Error(body.error);
        }

        if (!response.ok || body?.kind !== "onboarding-mutation") {
          throw new Error(body && "error" in body ? body.error : "Repository selection failed.");
        }

        setData((current) => reduceSettingsOnboardingMutationData(current, body));
        notifySessionRepositoriesChanged(data.workspace.id);
        setProfileDraft(repository.profile ?? null);
      } else {
        setProfileDraft(repository.profile ?? null);
      }
      setProfileDirty(false);
      return true;
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "Repository selection failed.");
      return false;
    } finally {
      if (activeRepositoryRef.current === repository.id) {
        setProfileAction(null);
      }
    }
  }

  async function inferRepositoryProfile(
    repository: SettingsPageData["github"]["repositories"][number],
  ) {
    if (profileBusy) return;
    activeRepositoryRef.current = repository.id;
    setProfileDraft(null);
    setProfileDirty(false);
    setProfileError(null);
    setProfileAction("analyzing");

    try {
      const response = await fetch(
        `/api/workspaces/${data.workspace.id}/repositories/${repository.id}/inference`,
        { method: "POST" },
      );
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        profile?: RepositoryProfileState;
      } | null;
      if (!response.ok || !body?.profile) {
        throw new Error(body?.error ?? "Failed to infer repository setup.");
      }
      if (activeRepositoryRef.current !== repository.id) return;
      setProfileDraft(body.profile);
    } catch (error) {
      if (activeRepositoryRef.current !== repository.id) return;
      setProfileError(error instanceof Error ? error.message : "Failed to infer repository setup.");
    } finally {
      if (activeRepositoryRef.current === repository.id) {
        setProfileAction(null);
      }
    }
  }

  async function analyzeRepository(repository: SettingsPageData["github"]["repositories"][number]) {
    if (selectedRepositoryId !== repository.id) {
      const selected = await selectRepository(repository.id);
      if (!selected) return;
    }

    await inferRepositoryProfile(repository);
  }

  async function saveRepositoryProfile() {
    if (!profileDraft || !selectedRepository || profileBusy) return;

    setProfileAction("saving");
    setProfileError(null);

    try {
      const response = await fetch(`/api/workspaces/${data.workspace.id}/repository-profile`, {
        body: JSON.stringify({
          buildCommand: profileDraft.buildCommand,
          envKeySuggestions: profileDraft.envKeySuggestions,
          frameworkHints: profileDraft.frameworkHints,
          githubRepositoryId: selectedRepository.id,
          inferenceConfidence: profileDirty ? "manual" : profileDraft.inferenceConfidence,
          inferenceSources: profileDraft.inferenceSources,
          installCommand: profileDraft.installCommand,
          languageHints: profileDraft.languageHints,
          packageManager: profileDraft.packageManager,
          setupNotes: profileDraft.setupNotes,
          testCommand: profileDraft.testCommand,
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        latestSandboxCapabilityCheck?: SandboxCapabilityCheckState | null;
        profile?: RepositoryProfileState;
      } | null;
      if (!response.ok || !body?.profile || !("latestSandboxCapabilityCheck" in body)) {
        throw new Error(body?.error ?? "Failed to save repository profile.");
      }

      setData((current) =>
        applySavedRepositoryProfile(
          current,
          body.profile!,
          body.latestSandboxCapabilityCheck ?? null,
        ),
      );
      notifySessionRepositoriesChanged(data.workspace.id);
      setProfileDraft(body.profile);
      setProfileDirty(false);
      setFlashMessage({ kind: "success", text: "Repository profile saved." });
    } catch (error) {
      setProfileError(
        error instanceof Error ? error.message : "Failed to save repository profile.",
      );
    } finally {
      setProfileAction(null);
    }
  }

  function updateRepositoryOnboarding(repositoryId: string, onboarding: RepositoryOnboardingState) {
    setData((current) => applyRepositoryOnboarding(current, repositoryId, onboarding));
  }

  return (
    <Section
      anchorId="repository"
      tagline="Prepare each synced repository for Wallie by installing skills and saving repository profiles."
      title="Repositories"
    >
      <div className="space-y-5">
        {selectableRepositories.length === 0 ? (
          <p className="rounded-[6px] border border-border bg-sheet p-4 text-[13px] leading-6 text-muted">
            Connect GitHub and sync repositories before analyzing repository setup.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-[6px] border border-border bg-sheet">
            {selectableRepositories.map((repository) => {
              const selected = selectedRepositoryId === repository.id;
              const showProfileEditor = selected && Boolean(profileDraft);
              const rowProfileAction = selected ? profileAction : null;
              const rowBusy = rowProfileAction !== null;
              const showSetupControls =
                Boolean(repository.onboarding.setupPrUrl) ||
                repository.onboarding.status !== "ready" ||
                !hasCurrentWallieSkills(repository.onboarding);
              const showProfileAction =
                repository.onboarding.status === "ready" &&
                !showProfileEditor &&
                rowProfileAction !== "analyzing";
              const showActionRow = showSetupControls || showProfileAction;

              return (
                <li className="flex flex-col gap-4 px-5 py-4" key={repository.id}>
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <a
                        className="truncate text-[14px] font-semibold text-foreground transition-colors duration-150 hover:text-accent"
                        href={repository.htmlUrl}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {repository.fullName}
                      </a>
                      {selected ? <StatusBadge tone="accent">Selected</StatusBadge> : null}
                      <RepositorySetupStatusBadge status={repository.onboarding.status} />
                    </div>
                    <RepositoryMetadata repository={repository} />
                    {repository.description ? (
                      <p className="text-[13px] leading-5 text-muted">{repository.description}</p>
                    ) : null}
                  </div>

                  {showActionRow ? (
                    <div className="flex flex-wrap items-center justify-start gap-2 border-t border-border pt-3 sm:justify-end">
                      {showSetupControls ? (
                        <RepositorySetupControls
                          canManage={data.canManage}
                          onChange={updateRepositoryOnboarding}
                          repository={repository}
                          setMessage={setFlashMessage}
                          workspaceId={data.workspace.id}
                        />
                      ) : null}
                      {showProfileAction ? (
                        <button
                          className={repository.profile ? "ui-button" : "ui-button-primary"}
                          disabled={!data.canManage || rowBusy || profileBusy}
                          onClick={() =>
                            repository.profile
                              ? void selectRepository(repository.id)
                              : void analyzeRepository(repository)
                          }
                          type="button"
                        >
                          {repository.profile ? "Edit profile" : "Analyze repository"}
                        </button>
                      ) : null}
                    </div>
                  ) : null}

                  {selected && profileError ? (
                    <div
                      className="rounded-[6px] border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] text-danger"
                      role="alert"
                    >
                      {profileError}
                    </div>
                  ) : null}
                  <RepositorySetupMessages repository={repository} />
                  {showProfileEditor && profileDraft ? (
                    <RepositoryProfileEditor
                      canManage={data.canManage && !profileBusy}
                      isAnalyzing={profileAction === "analyzing"}
                      isSaving={profileAction === "saving"}
                      onChange={updateProfileDraft}
                      onInfer={() => void inferRepositoryProfile(repository)}
                      onSave={() => void saveRepositoryProfile()}
                      profile={profileDraft}
                    />
                  ) : selected && profileAction === "analyzing" ? (
                    <div className="rounded-[6px] border border-border bg-sheet px-3 py-2 text-[13px] text-muted">
                      Analyzing repository…
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Section>
  );
}
