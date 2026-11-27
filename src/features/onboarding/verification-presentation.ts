import type { WorkspaceOnboardingData } from "@/features/onboarding/data";
import { onboardingStepIndex } from "@/features/onboarding/flow";
import {
  buildVerifyChecklist,
  type VerifyChecklistItem,
} from "@/features/onboarding/runtime-readiness";
import type { RuntimeCompletionState } from "@/features/onboarding/steps/types";

const noActiveRepositories =
  "No active repositories are available. Grant access using Manage on GitHub, then refresh repositories.";

export function hasActiveGithubRepositories(github: WorkspaceOnboardingData["github"]) {
  return github.repositories.some((repository) => !repository.isArchived);
}

export function getSetupVerificationChecklist(data: WorkspaceOnboardingData) {
  return buildVerifyChecklist({
    agentConfig: data.agentConfig,
    health: data.setupHealth,
    onboarding: data.onboarding,
  })
    .map((item): VerifyChecklistItem => {
      if (item.id === "github") {
        if (!item.passed) {
          return { ...item, detail: githubSetupBlocker(data.github) ?? item.detail };
        }
        if (!hasActiveGithubRepositories(data.github)) {
          return {
            ...item,
            detail: noActiveRepositories,
            label: "GitHub repository access",
            passed: false,
          };
        }
      }
      if (item.id === "pipeline" && !data.setupHealth.defaultPipeline.configured) {
        return {
          ...item,
          detail: data.pipeline
            ? "The current default pipeline has no stages."
            : "This workspace has no default pipeline.",
          label: "Current default pipeline",
          passed: false,
          statusLabel: "Missing",
          statusTone: "warning",
        };
      }
      return item;
    })
    .sort((a, b) => onboardingStepIndex(a.step) - onboardingStepIndex(b.step));
}

const verificationRecovery = {
  github: {
    action: "Fix GitHub access",
    handoff: "restore GitHub access",
    title: "GitHub access needed",
  },
  "repository-profile": {
    action: "Open repository setup",
    handoff: "save the selected repository’s profile",
    title: "Repository profile needed",
  },
  "repository-setup": {
    action: "Open repository setup",
    handoff: "finish preparing the selected repository",
    title: "Repository setup isn’t ready",
  },
  pipeline: {
    action: "Review pipeline",
    handoff: "review the pipeline",
    title: "Pipeline review needed",
  },
  linear: {
    action: "Open Linear step",
    handoff: "connect or skip Linear",
    title: "Choose whether to connect Linear",
  },
  runtime: {
    action: "Review agent settings",
    handoff: "save or skip agent settings",
    title: "Agent settings need review",
  },
  "provider-credentials": {
    action: "Fix agent access",
    handoff: "review agent access and verify with their own connected account",
    title: "Agent access isn’t ready",
  },
  "vercel-sandbox": {
    action: "Fix sandbox connection",
    handoff: "fix the sandbox connection",
    title: "Sandbox connection needed",
  },
} satisfies Record<
  Exclude<VerifyChecklistItem["id"], "sandbox">,
  { action: string; handoff: string; title: string }
>;

export function getVerificationRecovery(
  data: WorkspaceOnboardingData,
  blocker: VerifyChecklistItem | undefined,
) {
  if (!blocker || blocker.id === "sandbox") return null;
  if (blocker.id === "pipeline" && !data.setupHealth.defaultPipeline.configured) {
    return {
      action: "Open pipeline step",
      handoff: data.pipeline
        ? "add at least one stage to the default pipeline"
        : "contact Wallie support to restore the default pipeline",
      step: blocker.step,
      title: "Default pipeline unavailable",
    };
  }
  return { ...verificationRecovery[blocker.id], step: blocker.step };
}

export function githubSetupBlocker(github: WorkspaceOnboardingData["github"]) {
  if (!github.installation) {
    return github.missingAppKeys.length
      ? "GitHub installation is disabled because this Wallie deployment has no GitHub App configured."
      : "No GitHub App is installed for this workspace. Install it and grant access to at least one repository.";
  }
  if (github.installation.suspended) {
    return "This GitHub installation is suspended. A GitHub account owner must restore it before repositories can be refreshed.";
  }
  if (!hasActiveGithubRepositories(github)) return noActiveRepositories;
  return null;
}

export function repositoryStepBlocker(data: WorkspaceOnboardingData) {
  const { primaryRepositoryProfile, selectedRepository, repositorySetup } = data.setupHealth;
  if (repositorySetup.status === "pr_open") {
    return "The setup pull request is open. Merge it before verifying this repository.";
  }
  if (!hasActiveGithubRepositories(data.github)) return null;
  if (!selectedRepository.configured) {
    return "Choose a repository below, then install Wallie skills and save its profile.";
  }
  if (repositorySetup.status === "conflict") {
    return `Review the skill conflicts for ${selectedRepository.fullName} before preparing the repository.`;
  }
  if (repositorySetup.status === "error") {
    return `Wallie couldn’t prepare ${selectedRepository.fullName}. Check the error below and try again.`;
  }
  if (repositorySetup.status !== "ready") {
    return `Install Wallie skills for ${selectedRepository.fullName} before verifying setup.`;
  }
  if (!primaryRepositoryProfile.configured) {
    return `Analyze and save a repository profile for ${selectedRepository.fullName}.`;
  }
  return null;
}

export function executionStepBlocker(
  step: "sandbox" | "runtime",
  runtime: RuntimeCompletionState,
  checklist: VerifyChecklistItem[],
) {
  const sandbox = checklist.find((item) => item.id === "vercel-sandbox" && !item.passed);
  if (sandbox || step === "sandbox") return sandbox?.detail ?? null;
  if (runtime.hasInvalidDrafts) return "Fix the highlighted agent settings before saving.";
  if (runtime.hasUnsavedDrafts) return "Save your agent settings before continuing.";
  return runtime.readiness.requirements.find((requirement) => !requirement.passed)?.detail ?? null;
}
