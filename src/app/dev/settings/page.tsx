import { notFound } from "next/navigation";
import Link from "next/link";

import { isProductionDeploy } from "@/env/deploy";
import { verificationData } from "@/features/onboarding/fixtures";
import { ConnectorSettingsPanel } from "@/features/settings/connector-settings/section";
import type { SettingsPageData } from "@/features/settings/data";
import { SettingsLoadingSkeleton } from "@/features/settings/loading-skeleton";
import { parseSettingsCategory } from "@/features/settings/settings-categories";
import { SettingsServerShell } from "@/features/settings/settings-server-shell";
import { Section } from "@/features/settings/settings-ui";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const defaultFactory = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Product factory",
  isDefault: true,
  status: "active",
} as const;
const supportFactory = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Support factory",
  isDefault: false,
  status: "active",
} as const;

/** Real Settings components with deterministic data for visual review, without a database. */
export default async function SettingsPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{
    category?: string;
    state?: string;
    role?: string;
    factory?: string;
    github?: string;
  }>;
}) {
  if (isProductionDeploy()) notFound();

  const { category, factory, github, role, state } = await searchParams;
  const selectedCategory = parseSettingsCategory(category);
  if (state === "loading") {
    return (
      <main id="main-content" data-settings-fixture="loading">
        <SettingsLoadingSkeleton />
      </main>
    );
  }
  const onboarding = verificationData();
  const memberRole = role === "admin" || role === "member" ? role : "owner";
  const canManage = memberRole !== "member";
  const workspaceMembers = [
    {
      id: "member-1",
      fullName: "Riley Park",
      email: "riley@example.test",
      avatarUrl: null,
      role: "owner",
    },
    {
      id: "member-2",
      fullName: "Morgan Lee",
      email: "morgan@example.test",
      avatarUrl: null,
      role: "admin",
    },
    {
      id: "member-3",
      fullName: "Casey Wells",
      email: "casey@example.test",
      avatarUrl: null,
      role: "member",
    },
  ] as const;
  const currentMember =
    workspaceMembers.find((member) => member.role === memberRole) ?? workspaceMembers[0];
  const data: SettingsPageData = {
    ...onboarding,
    canManage,
    currentMember: { id: currentMember.id, role: currentMember.role },
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
      id: workspaceId,
      avatarPath: null,
      avatarUrl: null,
    },
    workspaceMembers: [...workspaceMembers],
    workspaceInvitations: [
      {
        acceptedAt: null,
        acceptedByMemberId: null,
        createdAt: "2026-05-16T18:00:00.000Z",
        email: "jordan@example.test",
        expiresAt: "2099-05-16T18:00:00.000Z",
        fullName: "Jordan Lee",
        id: "44444444-4444-4444-8444-444444444444",
        invitedByMemberId: onboarding.currentMember.id,
        lastSentAt: null,
        revokedAt: null,
        role: "member",
        status: "pending",
        updatedAt: "2026-05-16T18:00:00.000Z",
        workspaceId,
      },
    ],
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
        connectorSettings={
          selectedCategory === "integrations" ? (
            <ConnectorSettingsPanel
              options={[defaultFactory, supportFactory].map((option) => ({ ...option, canManage }))}
              requestedFactory={factory}
              workspaceId={workspaceId}
              workspaceSlug={data.workspace.slug}
            />
          ) : undefined
        }
        defaultFactoryName={Promise.resolve(defaultFactory.name)}
        initialData={data}
        personalConnections={
          selectedCategory === "workspace" ? (
            <Section anchorId="connected-clients" heading="h3" title="Connected clients">
              <p className="type-secondary text-muted">No active connections.</p>
            </Section>
          ) : undefined
        }
        searchState={{ codexStatus: null, githubStatus: github ?? null }}
        setupData={setupData}
        usage={Promise.resolve(data.usage)}
        workspaceInvitations={Promise.resolve({ asOf: 0, invitations: data.workspaceInvitations })}
        workspaceProfile={Promise.resolve({
          avatarUrl: currentMember.avatarUrl,
          fullName: currentMember.fullName,
        })}
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
