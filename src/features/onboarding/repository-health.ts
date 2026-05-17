import type { WorkspaceGitHubData } from "@/features/github/data";
import type { OnboardingSetupHealth } from "@/lib/onboarding/contracts";

export function buildRepositorySetupHealth(
  github: Pick<WorkspaceGitHubData, "primaryProfile" | "repositories">,
): Pick<OnboardingSetupHealth, "primaryRepositoryProfile" | "repositorySetup"> {
  const primaryProfile = github.primaryProfile;
  const primaryRepository = primaryProfile
    ? github.repositories.find((repository) => repository.id === primaryProfile.githubRepositoryId)
    : null;
  const usablePrimaryRepository =
    primaryRepository && !primaryRepository.isArchived ? primaryRepository : null;
  const primaryRepositorySetup = usablePrimaryRepository?.onboarding ?? null;
  const primaryRepositoryId =
    primaryProfile && usablePrimaryRepository ? primaryProfile.githubRepositoryId : null;

  return {
    primaryRepositoryProfile: {
      configured: Boolean(primaryRepositoryId),
      fullName: usablePrimaryRepository?.fullName ?? null,
      repositoryId: primaryRepositoryId,
      status: primaryRepositoryId ? "ready" : "missing",
    },
    repositorySetup: {
      configured: primaryRepositorySetup?.status === "ready",
      repositoryId: primaryRepositorySetup?.githubRepositoryId ?? primaryRepositoryId,
      status: primaryRepositorySetup?.status ?? "placeholder",
    },
  };
}
