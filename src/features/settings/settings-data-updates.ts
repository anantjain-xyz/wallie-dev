import { buildRepositorySetupHealth } from "@/features/onboarding/repository-health";
import type { SettingsPageData } from "@/features/settings/data";

export function updateGithubInSettingsData(
  currentData: SettingsPageData,
  github: SettingsPageData["github"],
): SettingsPageData {
  return {
    ...currentData,
    github,
    setupHealth: {
      ...currentData.setupHealth,
      githubInstallation: {
        connected: Boolean(github.installation && !github.installation.suspended),
        installationId: github.installation?.installationId ?? null,
        status: github.installation ? "present" : "missing",
        suspended: github.installation?.suspended ?? null,
        targetName: github.installation?.targetName ?? null,
        updatedAt: github.installation?.updatedAt ?? null,
      },
      ...buildRepositorySetupHealth(github, currentData.onboarding.selectedGithubRepositoryId),
    },
  };
}
