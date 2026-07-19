import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import type {
  SettingsInitialData,
  SettingsSetupData,
  WorkspaceUsageData,
} from "@/features/settings/data";
import {
  isSettingsCategory,
  SETTINGS_CATEGORIES,
  type SettingsCategory,
} from "@/features/settings/settings-categories";
import {
  SettingsSectionError,
  SettingsSectionFallback,
  SettingsServerShell,
} from "@/features/settings/settings-server-shell";

const initialData: SettingsInitialData = {
  canManage: true,
  currentMember: { id: "member-1", role: "owner" },
  github: {
    installation: null,
    missingAppKeys: [],
    missingWebhookKeys: [],
    primaryProfile: null,
    repositories: [],
  },
  workspace: {
    avatarPath: null,
    avatarUrl: null,
    id: "workspace-1",
    name: "Northwind Labs",
    slug: "northwind-labs",
  },
};

const readOnlyData: SettingsInitialData = {
  ...initialData,
  canManage: false,
  currentMember: { id: "member-2", role: "member" },
};

const emptyUsage: WorkspaceUsageData = {
  totalCostUsd: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalRuns: 0,
};

function neverPromise<T>(): Promise<T> {
  return new Promise(() => undefined);
}

function settledSetup(): Promise<SettingsSetupData> {
  return Promise.resolve({
    agentConfig: {},
    latestSandboxCapabilityCheck: null,
    linearRouting: { defaultStageSlug: null, teamRoutes: [] },
    linearSecret: null,
    onboarding: {
      activatedAt: null,
      completedAt: null,
      currentStep: "workspace",
      selectedRepositoryId: null,
      status: "not_started",
      steps: {},
    },
    pipeline: null,
    rateLimits: [
      {
        description: "Paid LLM calls",
        endpoint: "agent",
        max: 4,
        windowMs: 60_000,
      },
    ],
    setupHealth: {
      claudeCodeConnection: {
        checkedAt: null,
        connected: false,
        updatedAt: null,
      },
      codexConnection: {
        accountEmail: null,
        checkedAt: null,
        connected: false,
        credentialType: null,
        expiresAt: null,
        reconnectReason: null,
        reconnectRequired: false,
        status: "disconnected",
        updatedAt: null,
      },
      latestSandboxCapabilityCheck: null,
    },
    vercelSandboxConnection: null,
    workspaceMembers: [],
    workspaceSecrets: [],
  } as unknown as SettingsSetupData);
}

function renderShell(
  category: SettingsCategory,
  data: SettingsInitialData,
  setup: Promise<SettingsSetupData>,
) {
  return (
    <SettingsServerShell
      category={category}
      initialData={data}
      searchState={{ codexStatus: null, githubStatus: null }}
      setupData={setup}
      usage={Promise.resolve(emptyUsage)}
      workspaceInvitations={Promise.resolve([])}
    />
  );
}

export default async function SettingsFixturePage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; mode?: string; readonly?: string }>;
}) {
  if (process.env.NODE_ENV !== "development") notFound();

  const { category: rawCategory, mode, readonly } = await searchParams;
  const category = isSettingsCategory(rawCategory) ? rawCategory : SETTINGS_CATEGORIES[0];
  const data = readonly === "1" ? readOnlyData : initialData;

  let body: ReactNode;
  if (mode === "loading") {
    body = (
      <main className="mx-auto max-w-[1080px] space-y-8 px-4 py-10 sm:px-8">
        <h1 className="type-page-title">Loading</h1>
        <SettingsSectionFallback label={`${category} section`} minHeight="min-h-72" />
      </main>
    );
  } else if (mode === "error") {
    body = (
      <main className="mx-auto max-w-[1080px] space-y-8 px-4 py-10 sm:px-8">
        <h1 className="type-page-title">Error</h1>
        <SettingsSectionError label={`${category} section`} minHeight="min-h-72" />
      </main>
    );
  } else if (mode === "pending") {
    body = renderShell(category, data, neverPromise());
  } else {
    body = renderShell(category, data, settledSetup());
  }

  return <div data-settings-fixture>{body}</div>;
}
