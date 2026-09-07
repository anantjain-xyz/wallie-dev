import { notFound } from "next/navigation";

import { isProductionDeploy } from "@/env/deploy";
import { verificationData } from "@/features/onboarding/fixtures";
import type { SettingsPageData } from "@/features/settings/data";
import { SettingsLoadingSkeleton } from "@/features/settings/loading-skeleton";
import { parseSettingsCategory } from "@/features/settings/settings-categories";
import { SettingsServerShell } from "@/features/settings/settings-server-shell";

/** Real Settings components with deterministic data for visual review, without a database. */
export default async function SettingsPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; state?: string }>;
}) {
  if (isProductionDeploy()) notFound();

  const { category, state } = await searchParams;
  if (state === "loading") {
    return (
      <main id="main-content">
        <SettingsLoadingSkeleton />
      </main>
    );
  }
  const onboarding = verificationData();
  const data: SettingsPageData = {
    ...onboarding,
    latestSandboxCapabilityCheck: null,
    rateLimits: [],
    usage: { totalCostUsd: 12.5, totalInputTokens: 24000, totalOutputTokens: 8000, totalRuns: 12 },
    workspace: { ...onboarding.workspace, avatarPath: null, avatarUrl: null },
    workspaceInvitations: [],
  };
  data.github.installation = {
    appId: 123,
    id: "installation-preview",
    installationId: 123,
    installationUrl: "https://github.com/settings/installations",
    permissions: {},
    suspended: false,
    targetName: "acme",
    targetType: "Organization",
    updatedAt: "2026-05-16T18:00:00.000Z",
  };
  if (state === "empty") {
    data.github.repositories = [];
    data.github.primaryProfile = null;
  }

  // Mirror the production streaming shell, including its error treatment.
  const setupData =
    state === "error"
      ? Promise.reject<SettingsPageData>(new Error("Preview setup unavailable"))
      : Promise.resolve(data);
  void setupData.catch(() => undefined);

  return (
    <main id="main-content">
      <SettingsServerShell
        category={parseSettingsCategory(category)}
        initialData={data}
        searchState={{ codexStatus: null, githubStatus: null }}
        setupData={setupData}
        usage={Promise.resolve(data.usage)}
        workspaceInvitations={Promise.resolve([])}
      />
    </main>
  );
}
