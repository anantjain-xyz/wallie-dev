import type { WorkspaceGitHubData } from "@/features/github/data";
import type { OnboardingSetupHealth } from "@/lib/onboarding/contracts";

export function buildRepositorySetupHealth(
  github: Pick<WorkspaceGitHubData, "primaryProfile" | "repositories">,
  selectedGithubRepositoryId?: string | null,
): Pick<
  OnboardingSetupHealth,
  "primaryRepositoryProfile" | "repositorySetup" | "selectedRepository"
> {
  const primaryProfile = github.primaryProfile;
  const effectiveSelectedRepositoryId =
    selectedGithubRepositoryId ?? primaryProfile?.githubRepositoryId ?? null;
  const selectedRepository = effectiveSelectedRepositoryId
    ? github.repositories.find((repository) => repository.id === effectiveSelectedRepositoryId)
    : null;
  const usableSelectedRepository =
    selectedRepository && !selectedRepository.isArchived ? selectedRepository : null;
  const selectedRepositorySetup = usableSelectedRepository?.onboarding ?? null;
  const primaryProfileMatchesSelected =
    Boolean(usableSelectedRepository) &&
    primaryProfile?.githubRepositoryId === usableSelectedRepository?.id;

  return {
    selectedRepository: {
      configured: Boolean(usableSelectedRepository),
      fullName: usableSelectedRepository?.fullName ?? null,
      repositoryId: usableSelectedRepository?.id ?? null,
      status: usableSelectedRepository ? "ready" : "missing",
    },
    primaryRepositoryProfile: {
      configured: primaryProfileMatchesSelected,
      fullName: primaryProfileMatchesSelected ? (usableSelectedRepository?.fullName ?? null) : null,
      repositoryId: primaryProfileMatchesSelected
        ? (primaryProfile?.githubRepositoryId ?? null)
        : null,
      status: primaryProfileMatchesSelected ? "ready" : "missing",
    },
    repositorySetup: {
      configured: selectedRepositorySetup?.status === "ready",
      repositoryId:
        selectedRepositorySetup?.githubRepositoryId ?? usableSelectedRepository?.id ?? null,
      status: selectedRepositorySetup?.status ?? "placeholder",
    },
  };
}
