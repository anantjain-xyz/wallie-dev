import { notFound } from "next/navigation";
import Link from "next/link";

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
  const selectedCategory = parseSettingsCategory(category);
  if (state === "loading") {
    return (
      <main id="main-content" data-settings-fixture="loading">
        <SettingsLoadingSkeleton />
      </main>
    );
  }
  const onboarding = verificationData();
  const data: SettingsPageData = {
    ...onboarding,
    latestSandboxCapabilityCheck: null,
    rateLimits: [],
    usage: {
      totalCostUsd: 12.5,
      totalInputTokens: 24000,
      totalOutputTokens: 8000,
      totalRuns: 12,
      tokensUnavailable: false,
      costUnavailable: false,
      hasEstimatedTokens: false,
      hasEstimatedCost: false,
    },
    workspace: {
      ...onboarding.workspace,
      id: "11111111-1111-4111-8111-111111111111",
      avatarPath: null,
      avatarUrl: null,
    },
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
  if (state === "missing-usage") {
    data.usage = {
      totalCostUsd: null,
      totalInputTokens: null,
      totalOutputTokens: null,
      totalRuns: 4,
      tokensUnavailable: true,
      costUnavailable: true,
      hasEstimatedTokens: false,
      hasEstimatedCost: false,
    };
  }

  // Mirror the production streaming shell, including its error treatment.
  const setupData =
    state === "error"
      ? Promise.reject<SettingsPageData>(new Error("Preview setup unavailable"))
      : Promise.resolve(data);
  void setupData.catch(() => undefined);

  return (
    <main id="main-content" data-settings-fixture={state ?? "loaded"}>
      <SettingsServerShell
        category={selectedCategory}
        initialData={data}
        searchState={{ codexStatus: null, githubStatus: null }}
        setupData={setupData}
        usage={Promise.resolve(data.usage)}
        workspaceInvitations={Promise.resolve([])}
      />
      {state === "error" ? (
        <aside
          aria-label="Fixture recovery"
          className="mx-auto max-w-[1080px] space-y-3 px-4 pb-8 sm:px-8"
        >
          <p className="type-body text-muted">
            This fixture can restore its setup data without connecting to a service.
          </p>
          <Link
            className="ui-button"
            href={`/dev/settings?category=${selectedCategory}&state=loaded`}
            prefetch={false}
          >
            Restore fixture setup data
          </Link>
        </aside>
      ) : null}
    </main>
  );
}
