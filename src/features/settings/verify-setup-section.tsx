"use client";

import type { Dispatch, SetStateAction } from "react";

import { Status, configurationStatusFromTone } from "@/components/ui/status";
import { buildVerifyChecklist } from "@/features/onboarding/runtime-readiness";
import { useFactorySettings } from "@/features/settings/factory-settings";
import { PersonalSettingsLink } from "@/features/settings/personal-settings-navigation";
import { SandboxCapabilitySection } from "@/features/settings/sandbox-capability-section";
import type { SettingsPageData } from "@/features/settings/data";
import type { FlashMessage } from "@/features/settings/settings-types";
import { Section } from "@/features/settings/settings-ui";
import { normalizeAgentProviderName } from "@/lib/agent-config/contracts";
import type { WorkspaceOnboardingStep } from "@/lib/onboarding/contracts";
import { workspaceSettingsPath } from "@/lib/routes";

type VerifySetupSectionProps = {
  data: SettingsPageData;
  defaultFactoryName?: string;
  setData: Dispatch<SetStateAction<SettingsPageData>>;
  setFlashMessage: (message: FlashMessage) => void;
};

const stepAnchor: Record<WorkspaceOnboardingStep, string> = {
  github: "github",
  linear: "linear",
  pipeline: "pipeline",
  repository: "repository",
  runtime: "runtime",
  sandbox: "sandbox",
  verify: "verify",
};

const stepLabel: Record<WorkspaceOnboardingStep, string> = {
  github: "GitHub",
  linear: "Linear",
  pipeline: "Pipeline",
  repository: "Repository",
  runtime: "Agent runtime",
  sandbox: "Sandbox",
  verify: "Verify setup",
};

const sandboxLabel = { daytona: "Daytona", e2b: "E2B", vercel: "Vercel Sandbox" } as const;

function ReadinessChecks({
  items,
  providerAccessHref,
}: {
  items: ReturnType<typeof buildVerifyChecklist>;
  providerAccessHref: string;
}) {
  return (
    <ul className="divide-y divide-border border-y border-border">
      {items.map((item) => (
        <li
          className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between"
          key={item.id}
        >
          <div className="min-w-0">
            <p className="type-secondary font-medium text-foreground">
              {item.id === "linear"
                ? "Linear API key and session routing"
                : item.id === "sandbox"
                  ? "Workspace sandbox capability"
                  : item.label}
            </p>
            <p className="mt-0.5 break-words text-xs leading-5 text-muted">{item.detail}</p>
            {item.id === "linear" ? (
              <a
                className="mt-1 inline-block text-xs font-medium text-accent underline"
                href="#connector-resources"
              >
                Open Factory connector resources
              </a>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
            <Status
              label={item.statusLabel ?? (item.passed ? "Ready" : "Blocked")}
              value={configurationStatusFromTone(
                item.statusTone ?? (item.passed ? "success" : "warning"),
              )}
            />
            {!item.passed && item.step !== "verify" ? (
              item.id === "provider-credentials" ? (
                <PersonalSettingsLink className="ui-button" href={providerAccessHref}>
                  Open provider access
                </PersonalSettingsLink>
              ) : (
                <a className="ui-button" href={`#${stepAnchor[item.step]}`}>
                  {`Open ${stepLabel[item.step]} settings`}
                </a>
              )
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function VerifySetupSection({
  data,
  defaultFactoryName,
  setData,
  setFlashMessage,
}: VerifySetupSectionProps) {
  const settings = useFactorySettings();
  const snapshot = settings?.snapshot;
  const definition = snapshot?.draft ?? snapshot?.published;
  const definitionTarget =
    data.canManage && snapshot && definition
      ? {
          id: definition.id,
          kind: snapshot.draft ? ("draft" as const) : ("revision" as const),
          repositoryId: snapshot.repositoryId,
        }
      : undefined;
  const checklist = buildVerifyChecklist({
    agentConfig: data.agentConfig,
    health: data.setupHealth,
    mode: "settings",
    onboarding: data.onboarding,
  });
  const needsAttention = checklist.filter((item) => !item.passed);
  const passing = checklist.filter((item) => item.passed);
  const configuredProvider = data.agentConfig.agent_provider;
  const provider = normalizeAgentProviderName(
    typeof configuredProvider === "string" ? configuredProvider : undefined,
  );
  const providerAccessHref = `${workspaceSettingsPath(data.workspace.slug, { category: "personal", provider: provider ?? undefined })}#provider-access`;
  const preferredRepositoryId =
    data.setupHealth.primaryRepositoryProfile.repositoryId ??
    data.setupHealth.selectedRepository.repositoryId;
  const activeSandbox = data.setupHealth.sandboxConnection;
  const factoryRepository = definitionTarget
    ? data.github.repositories.find((item) => item.id === definitionTarget.repositoryId)?.fullName
    : undefined;
  const sandboxConnected =
    definitionTarget && snapshot
      ? data.sandboxSettings.enabledProviders.includes(snapshot.sandboxProvider) &&
        data.sandboxSettings.connections[snapshot.sandboxProvider]?.status === "connected"
      : (activeSandbox?.connected ?? data.setupHealth.vercelSandboxConnection.connected);

  return (
    <Section
      anchorId="verify"
      tagline="Check connections before running sessions."
      title="Verify setup"
    >
      <div className="space-y-8">
        <div className="space-y-3">
          <div>
            <h3 className="text-[14px] font-semibold text-foreground">Workspace readiness</h3>
            <p className="mt-1 text-xs leading-5 text-muted">
              These results apply to the workspace defaults, not to a factory definition.
            </p>
          </div>
          {needsAttention.length ? (
            <ReadinessChecks items={needsAttention} providerAccessHref={providerAccessHref} />
          ) : (
            <Status label="All workspace checks ready" value="healthy" />
          )}
          {passing.length ? (
            <details className="type-secondary text-muted">
              <summary className="w-fit cursor-pointer hover:text-foreground">
                Passing checks ({passing.length})
              </summary>
              <div className="mt-2">
                <ReadinessChecks items={passing} providerAccessHref={providerAccessHref} />
              </div>
            </details>
          ) : null}
        </div>

        <div className="border-t border-border pt-6">
          <div className="mb-4 min-w-0">
            <h3 className="text-[14px] font-semibold text-foreground">
              {definitionTarget
                ? definitionTarget.kind === "draft"
                  ? "Factory draft capability"
                  : "Published factory capability"
                : "Check workspace sandbox capability"}
            </h3>
            <p className="mt-1 text-xs leading-5 text-muted">
              {definitionTarget && snapshot
                ? `${defaultFactoryName ?? "Default factory"} · ${factoryRepository ?? "Factory repository unavailable"} · ${sandboxLabel[snapshot.sandboxProvider]}. This check does not update workspace readiness.`
                : data.canManage
                  ? "Run the check against the selected repository to update workspace readiness."
                  : "Workspace admins can run this check to update readiness."}
            </p>
          </div>
          <SandboxCapabilitySection
            key={definitionTarget?.id ?? "workspace"}
            canManage={
              data.canManage && settings?.phase !== "loading" && settings?.phase !== "error"
            }
            definitionTarget={definitionTarget}
            initialCheck={definitionTarget ? null : data.setupHealth.latestSandboxCapabilityCheck}
            onCheckChange={
              definitionTarget
                ? undefined
                : (check) =>
                    setData((current) => ({
                      ...current,
                      latestSandboxCapabilityCheck: check,
                      setupHealth: {
                        ...current.setupHealth,
                        latestSandboxCapabilityCheck: check,
                      },
                    }))
            }
            preferredRepositoryId={preferredRepositoryId}
            repositories={data.github.repositories}
            sandboxConnected={sandboxConnected}
            setFlashMessage={setFlashMessage}
            workspaceId={data.workspace.id}
          />
        </div>
      </div>
    </Section>
  );
}
