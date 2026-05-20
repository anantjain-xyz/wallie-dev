"use client";

import { useRef, useState, type Dispatch, type SetStateAction } from "react";

import { SelectField } from "@/components/ui/select";
import type { WorkspaceOnboardingData } from "@/features/onboarding/data";
import { buildOnboardingRepositorySelectionPatch } from "@/features/onboarding/flow";
import { buildRepositorySetupHealth } from "@/features/onboarding/repository-health";
import { RepositoryProfileEditor } from "@/features/repository-profile/repository-profile-editor";
import type { SettingsPageData } from "@/features/settings/data";
import type { FlashMessage } from "@/features/settings/settings-types";
import { Section, StatusBadge } from "@/features/settings/settings-ui";
import type { RepositoryProfileState } from "@/lib/repo-inference/contracts";

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

function mergeOnboardingData(
  current: SettingsPageData,
  onboardingData: WorkspaceOnboardingData,
): SettingsPageData {
  return {
    ...current,
    agentConfig: onboardingData.agentConfig,
    github: onboardingData.github,
    latestSandboxCapabilityCheck: onboardingData.setupHealth.latestSandboxCapabilityCheck,
    linearRouting: onboardingData.linearRouting,
    linearSecret: onboardingData.linearSecret,
    onboarding: onboardingData.onboarding,
    pipeline: onboardingData.pipeline,
    setupHealth: onboardingData.setupHealth,
    workspaceMembers: onboardingData.workspaceMembers,
    workspaceSecrets: onboardingData.workspaceSecrets,
  };
}

function applySavedRepositoryProfile(
  current: SettingsPageData,
  profile: RepositoryProfileState,
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
  const repositoryOptions = selectableRepositories.map((repository) => ({
    label: repository.fullName,
    value: repository.id,
  }));
  const selectedRepositoryId = selectedRepository?.id ?? "";
  const profileBusy = profileAction !== null;

  function updateProfileDraft(nextProfile: RepositoryProfileState, dirty = false) {
    setProfileDraft(nextProfile);
    setProfileDirty(dirty);
  }

  async function selectRepository(repositoryId: string) {
    const repository = data.github.repositories.find((candidate) => candidate.id === repositoryId);
    if (!repository || profileBusy) return;

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
          body: JSON.stringify(patch),
          headers: { "content-type": "application/json" },
          method: "PATCH",
        });
        const body = (await response.json().catch(() => null)) as
          | (WorkspaceOnboardingData & { error?: string })
          | null;
        if (!response.ok || !body || "error" in body) {
          throw new Error(body?.error ?? "Repository selection failed.");
        }

        setData((current) => mergeOnboardingData(current, body));
        const selected = body.github.repositories.find(
          (candidate) => candidate.id === repository.id,
        );
        setProfileDraft(selected?.profile ?? null);
      } else {
        setProfileDraft(repository.profile ?? null);
      }
      setProfileDirty(false);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "Repository selection failed.");
    } finally {
      if (activeRepositoryRef.current === repository.id) {
        setProfileAction(null);
      }
    }
  }

  async function inferRepositoryProfile(repository: NonNullable<typeof selectedRepository>) {
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
        profile?: RepositoryProfileState;
      } | null;
      if (!response.ok || !body?.profile) {
        throw new Error(body?.error ?? "Failed to save repository profile.");
      }

      setData((current) => applySavedRepositoryProfile(current, body.profile!));
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

  return (
    <Section
      anchorId="repository"
      tagline="Analyze and save the primary repository profile Wallie uses for sessions and runtime checks."
      title="Analyze repository"
    >
      <div className="space-y-5">
        {profileError ? (
          <div
            className="rounded-[6px] border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] text-danger"
            role="alert"
          >
            {profileError}
          </div>
        ) : null}

        <SelectField
          disabled={!data.canManage || selectableRepositories.length === 0 || profileBusy}
          fallbackLabel="No repositories available"
          label="Repository"
          onValueChange={(value) => void selectRepository(value)}
          options={repositoryOptions}
          value={selectedRepositoryId}
        />

        {selectedRepository ? (
          <>
            <div className="rounded-[6px] border border-border bg-surface p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-[14px] font-semibold text-foreground">
                      {selectedRepository.fullName}
                    </h3>
                    <StatusBadge tone="accent">Selected</StatusBadge>
                    {selectedRepository.profile?.isPrimary ? (
                      <StatusBadge tone="success">Primary</StatusBadge>
                    ) : null}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {selectedRepository.defaultProgrammingLanguage ? (
                      <span className="ui-pill">
                        {selectedRepository.defaultProgrammingLanguage}
                      </span>
                    ) : null}
                    {selectedRepository.defaultBranch ? (
                      <span className="ui-pill font-mono">{selectedRepository.defaultBranch}</span>
                    ) : null}
                    <span className="ui-pill">
                      {selectedRepository.isPrivate ? "Private" : "Public"}
                    </span>
                  </div>
                  {selectedRepository.description ? (
                    <p className="mt-3 text-[13px] leading-5 text-muted">
                      {selectedRepository.description}
                    </p>
                  ) : null}
                </div>

                {!profileDraft && profileAction !== "analyzing" ? (
                  <button
                    className="ui-button-primary shrink-0"
                    disabled={!data.canManage || profileBusy}
                    onClick={() => void inferRepositoryProfile(selectedRepository)}
                    type="button"
                  >
                    Analyze repository
                  </button>
                ) : null}
              </div>
            </div>

            {profileDraft ? (
              <RepositoryProfileEditor
                canManage={data.canManage && !profileBusy}
                isAnalyzing={profileAction === "analyzing"}
                isSaving={profileAction === "saving"}
                onChange={updateProfileDraft}
                onInfer={() => void inferRepositoryProfile(selectedRepository)}
                onSave={() => void saveRepositoryProfile()}
                profile={profileDraft}
              />
            ) : profileAction === "analyzing" ? (
              <div className="rounded-[6px] border border-border bg-surface px-3 py-2 text-[13px] text-muted">
                Analyzing repository...
              </div>
            ) : null}
          </>
        ) : (
          <p className="rounded-[6px] border border-border bg-surface p-4 text-[13px] leading-6 text-muted">
            Connect GitHub and sync repositories before analyzing repository setup.
          </p>
        )}
      </div>
    </Section>
  );
}
