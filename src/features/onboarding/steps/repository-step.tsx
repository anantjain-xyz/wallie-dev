"use client";

import { useRef, useState } from "react";

import { Status } from "@/components/ui/status";
import type { WorkspaceGitHubData, WorkspaceGitHubRepository } from "@/features/github/data";
import type { WorkspaceOnboardingData } from "@/features/onboarding/data";
import { buildRepositorySetupHealth } from "@/features/onboarding/repository-health";
import { RepositoryProfileEditor } from "@/features/repository-profile/repository-profile-editor";
import {
  hasCurrentWallieSkills,
  RepositoryMetadata,
  RepositorySetupControls,
  RepositorySetupMessages,
  repositorySetupCanAdvance,
  RepositorySetupStatus,
} from "@/features/repositories/repository-setup-controls";
import type { RepositoryProfileState } from "@/lib/repo-inference/contracts";
import type { SandboxCapabilityCheckState } from "@/lib/sandbox-capabilities/contracts";

import type { OnboardingStepProps } from "./types";

export default function RepositoryAnalysisStep({
  data,
  isSaving,
  onCompleteStep,
  onDataChange,
  onRepositoryOnboardingChange,
  onRepositorySetupMessage,
  onSelectStep,
  onSelectGithubRepository,
}: OnboardingStepProps) {
  const selectedRepository = selectedRepositoryFromData(data);
  const [profileAction, setProfileAction] = useState<"analyzing" | "saving" | null>(null);
  const [profileDirty, setProfileDirty] = useState(false);
  const [profileDraft, setProfileDraft] = useState<RepositoryProfileState | null>(
    () => selectedRepository?.profile ?? data.github.primaryProfile ?? null,
  );
  const [profileError, setProfileError] = useState<string | null>(null);
  const selectedRepositoryIdRef = useRef(selectedRepository?.id ?? null);
  selectedRepositoryIdRef.current = selectedRepository?.id ?? selectedRepositoryIdRef.current;
  const profileAnalyzing = profileAction === "analyzing";
  const profileSaving = profileAction === "saving";
  const repositories = data.github.repositories.filter((repository) => !repository.isArchived);

  async function selectRepository(repository: WorkspaceGitHubRepository) {
    const selected = await onSelectGithubRepository(repository);
    if (!selected) return false;
    selectedRepositoryIdRef.current = repository.id;
    setProfileDraft(repository.profile ?? null);
    setProfileDirty(false);
    setProfileError(null);
    return true;
  }

  async function inferRepositoryProfile(repository: WorkspaceGitHubRepository) {
    selectedRepositoryIdRef.current = repository.id;
    setProfileDraft(null);
    setProfileDirty(false);
    setProfileError(null);
    setProfileAction("analyzing");

    try {
      const response = await fetch(
        `/api/workspaces/${data.workspace.id}/repositories/${repository.id}/inference`,
        { method: "POST" },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Failed to infer repository setup.");
      }
      const body = (await response.json()) as { profile: RepositoryProfileState };
      if (selectedRepositoryIdRef.current === repository.id) setProfileDraft(body.profile);
    } catch (caught) {
      if (selectedRepositoryIdRef.current === repository.id) {
        setProfileError(
          caught instanceof Error ? caught.message : "Failed to infer repository setup.",
        );
      }
    } finally {
      if (selectedRepositoryIdRef.current === repository.id) setProfileAction(null);
    }
  }

  async function analyzeRepository(repository: WorkspaceGitHubRepository) {
    if (selectedRepository?.id !== repository.id && !(await selectRepository(repository))) return;
    await inferRepositoryProfile(repository);
  }

  async function saveRepositoryProfile() {
    const repositoryId = selectedRepositoryIdRef.current;
    if (!profileDraft || !repositoryId || profileAction) return;
    setProfileAction("saving");
    setProfileError(null);

    try {
      const response = await fetch(`/api/workspaces/${data.workspace.id}/repository-profile`, {
        body: JSON.stringify({
          buildCommand: profileDraft.buildCommand,
          envKeySuggestions: profileDraft.envKeySuggestions,
          frameworkHints: profileDraft.frameworkHints,
          githubRepositoryId: repositoryId,
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
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Failed to save repository profile.");
      }
      const body = (await response.json()) as {
        latestSandboxCapabilityCheck: SandboxCapabilityCheckState | null;
        profile: RepositoryProfileState;
      };
      const nextData = applySavedRepositoryProfileToData(
        data,
        body.profile,
        body.latestSandboxCapabilityCheck,
      );
      onDataChange(nextData);
      if (selectedRepositoryIdRef.current === repositoryId) {
        setProfileDraft(body.profile);
        setProfileDirty(false);
      }
      if (canCompleteRepositoryStep(nextData)) await onCompleteStep("repository-profile");
    } catch (caught) {
      setProfileError(
        caught instanceof Error ? caught.message : "Failed to save repository profile.",
      );
    } finally {
      setProfileAction(null);
    }
  }

  if (repositories.length === 0) {
    return (
      <div className="rounded-[6px] border border-border bg-sheet p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[13px] leading-5 text-muted">
            Connect GitHub and sync repositories before analyzing repository setup.
          </p>
          <button className="ui-button" onClick={() => onSelectStep("github")} type="button">
            Open GitHub
          </button>
        </div>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border rounded-[6px] border border-border bg-sheet">
      {repositories.map((repository) => {
        const selected = selectedRepository?.id === repository.id;
        const showProfileEditor = selected && Boolean(profileDraft);
        const rowProfileBusy = selected && (profileAnalyzing || profileSaving);
        const showSetupControls =
          Boolean(repository.onboarding.setupPrUrl) ||
          repository.onboarding.status !== "ready" ||
          !hasCurrentWallieSkills(repository.onboarding);
        const showProfileAction =
          repository.onboarding.status === "ready" && !showProfileEditor && !rowProfileBusy;
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
                {selected ? <Status label="Selected" value="approved" /> : null}
                <RepositorySetupStatus status={repository.onboarding.status} />
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
                    canManage={data.canManage && !isSaving}
                    onChange={onRepositoryOnboardingChange}
                    repository={repository}
                    setMessage={onRepositorySetupMessage}
                    workspaceId={data.workspace.id}
                  />
                ) : null}
                {showProfileAction ? (
                  <button
                    className={repository.profile ? "ui-button" : "ui-button-primary"}
                    disabled={!data.canManage || isSaving}
                    onClick={() =>
                      repository.profile
                        ? void selectRepository(repository)
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
                canManage={data.canManage && !isSaving}
                isAnalyzing={profileAnalyzing}
                isSaving={profileSaving}
                onChange={(profile, dirty = false) => {
                  setProfileDraft(profile);
                  setProfileDirty(dirty);
                }}
                onInfer={() => void inferRepositoryProfile(repository)}
                onSave={() => void saveRepositoryProfile()}
                profile={profileDraft}
              />
            ) : selected && profileAnalyzing ? (
              <div className="rounded-[6px] border border-border bg-sheet px-3 py-2 text-[13px] text-muted">
                Analyzing repository…
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function applySavedRepositoryProfileToData(
  currentData: WorkspaceOnboardingData,
  profile: RepositoryProfileState,
  latestSandboxCapabilityCheck: SandboxCapabilityCheckState | null,
): WorkspaceOnboardingData {
  const github: WorkspaceGitHubData = {
    ...currentData.github,
    primaryProfile: profile,
    repositories: currentData.github.repositories.map((repository) => ({
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
    ...currentData,
    github,
    setupHealth: {
      ...currentData.setupHealth,
      latestSandboxCapabilityCheck,
      ...buildRepositorySetupHealth(github, currentData.onboarding.selectedGithubRepositoryId),
    },
  };
}

function canCompleteRepositoryStep(data: WorkspaceOnboardingData) {
  const selectedId =
    data.onboarding.selectedGithubRepositoryId ?? data.github.primaryProfile?.githubRepositoryId;
  return (
    Boolean(selectedId) &&
    data.setupHealth.primaryRepositoryProfile.configured &&
    data.setupHealth.primaryRepositoryProfile.repositoryId === selectedId &&
    repositorySetupCanAdvance(data.setupHealth.repositorySetup.status)
  );
}

function selectedRepositoryFromData(data: WorkspaceOnboardingData) {
  const selectedRepositoryId =
    data.onboarding.selectedGithubRepositoryId ?? data.github.primaryProfile?.githubRepositoryId;
  if (!selectedRepositoryId) return null;
  return (
    data.github.repositories.find((repository) => repository.id === selectedRepositoryId) ?? null
  );
}
