import { notFound } from "next/navigation";
import Link from "next/link";

import { isProductionDeploy } from "@/env/deploy";
import { verificationData } from "@/features/onboarding/fixtures";
import type { SettingsPageData } from "@/features/settings/data";
import { SettingsLoadingSkeleton } from "@/features/settings/loading-skeleton";
import { parseSettingsCategory } from "@/features/settings/settings-categories";
import { SettingsServerShell } from "@/features/settings/settings-server-shell";
import type { CompiledFactoryDefinition } from "@/lib/factory-definitions/compiler";
import {
  createEmptySettingsFactoryDefinitionState,
  type SettingsFactoryDefinitionState,
} from "@/lib/factory-definitions/settings-contracts";
import { projectSettingsDataWithFactoryDefinition } from "@/lib/factory-definitions/settings-projection";

const previewIds = {
  factoryId: "22222222-2222-4222-8222-222222222201",
  activationId: "22222222-2222-4222-8222-222222222202",
  revisionId: "22222222-2222-4222-8222-222222222203",
  draftId: "22222222-2222-4222-8222-222222222204",
  pipelineId: "22222222-2222-4222-8222-222222222205",
  repositoryId: "22222222-2222-4222-8222-222222222206",
  stageId: "22222222-2222-4222-8222-222222222207",
  executionPolicyId: "22222222-2222-4222-8222-222222222208",
  deliveryPolicyId: "22222222-2222-4222-8222-222222222209",
  workspaceId: "11111111-1111-4111-8111-111111111111",
};

function buildPreviewDefinition(
  overrides: Partial<CompiledFactoryDefinition> = {},
): CompiledFactoryDefinition {
  return {
    schemaVersion: 1,
    kind: "serial",
    pipelineId: previewIds.pipelineId,
    repositoryId: previewIds.repositoryId,
    sandboxProvider: "vercel",
    agent: {
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "xhigh",
      concurrencyLimit: 1,
      stallTimeoutMs: 900_000,
      maxRetries: 3,
      maxTurns: 5,
    },
    executionPolicyRevisionId: previewIds.executionPolicyId,
    deliveryPolicyRevisionId: previewIds.deliveryPolicyId,
    skillIds: [],
    toolIds: [],
    operatingRulesMd: "Keep diffs small and verify tests before approval.",
    operatingRuleStageIds: [],
    stages: [
      {
        id: previewIds.stageId,
        slug: "product",
        name: "Product",
        description: "Product",
        promptTemplateMd: "Product prompt",
        anyoneCanApprove: false,
        approverMemberIds: [],
        previousStageIds: [],
      },
    ],
    ...overrides,
  };
}

function buildPreviewFactoryState(state: string | undefined): SettingsFactoryDefinitionState {
  if (state === "empty") {
    return {
      ...createEmptySettingsFactoryDefinitionState(),
      factoryId: previewIds.factoryId,
    };
  }

  const publishedDefinition = buildPreviewDefinition();
  const executionPolicy = {
    id: previewIds.executionPolicyId,
    workspaceId: previewIds.workspaceId,
    revision: 1,
    createdAt: "2026-05-16T18:00:00.000Z",
    requirements: {
      version: 1 as const,
      maxRepairAttempts: 3,
      maxExecutionMs: 3_600_000,
      maxTotalTokens: null,
      maxCostUsd: null,
    },
  };
  const deliveryPolicy = {
    id: previewIds.deliveryPolicyId,
    workspaceId: previewIds.workspaceId,
    pipelineId: previewIds.pipelineId,
    revision: 1,
    createdAt: "2026-05-16T18:00:00.000Z",
    requirements: {
      version: 1 as const,
      deliveryMode: "code" as const,
      requiredChecks: ["lint-and-format", "test"],
      minimumApprovals: 1,
      requireCodeOwnerReview: false,
      requireResolvedThreads: true,
      requiredEvidence: ["browser-proof"],
      freshnessSeconds: 3600,
      requireArtifactApprovalForDelivery: false,
    },
  };

  const draftDefinition =
    state === "draft"
      ? buildPreviewDefinition({
          agent: {
            ...publishedDefinition.agent,
            model: "gpt-5.6",
            maxRetries: 4,
          },
          operatingRulesMd: "Keep diffs small, run pnpm check, and verify screenshots.",
        })
      : null;

  return {
    factoryId: previewIds.factoryId,
    expectedActivationNumber: 1,
    currentActivation: {
      id: previewIds.activationId,
      revisionId: previewIds.revisionId,
      activationNumber: 1,
      previousActivationNumber: null,
      canonicalDigest: "1a2b3c4d".repeat(8),
      createdAt: "2026-05-16T18:00:00.000Z",
      definition: publishedDefinition,
    },
    latestDraft: draftDefinition
      ? {
          id: previewIds.draftId,
          baseActivationNumber: 1,
          schemaVersion: 1,
          canonicalDigest: "9e8d7c6b".repeat(8),
          createdAt: "2026-05-16T18:05:00.000Z",
          definition: draftDefinition,
        }
      : null,
    activeDefinition: draftDefinition ?? publishedDefinition,
    defaultRepositoryId: previewIds.repositoryId,
    executionPolicy,
    deliveryPolicy,
    liveExecutionPolicyRevision: 1,
    liveDeliveryPolicyRevision: 1,
  };
}

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
  const factoryDefinition = buildPreviewFactoryState(state);
  const baseData: SettingsPageData = {
    ...onboarding,
    factoryDefinition,
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
      id: previewIds.workspaceId,
      avatarPath: null,
      avatarUrl: null,
    },
    workspaceInvitations: [],
  };
  baseData.github.installation = {
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
    baseData.github.repositories = [];
    baseData.github.primaryProfile = null;
  }
  if (state === "missing-usage") {
    baseData.usage = {
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
  const data = projectSettingsDataWithFactoryDefinition(baseData, factoryDefinition);

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
