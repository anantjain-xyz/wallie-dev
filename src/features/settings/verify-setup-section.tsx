"use client";

import type { Dispatch, SetStateAction } from "react";

import { Status, configurationStatusFromTone } from "@/components/ui/status";
import { buildVerifyChecklist } from "@/features/onboarding/runtime-readiness";
import { useFactorySettings } from "@/features/settings/factory-settings";
import { SandboxCapabilitySection } from "@/features/settings/sandbox-capability-section";
import type { SettingsPageData } from "@/features/settings/data";
import type { FlashMessage } from "@/features/settings/settings-types";
import { Section } from "@/features/settings/settings-ui";
import type { WorkspaceOnboardingStep } from "@/lib/onboarding/contracts";

type VerifySetupSectionProps = {
  data: SettingsPageData;
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

function checklistItemHref(item: ReturnType<typeof buildVerifyChecklist>[number]) {
  return item.id === "vercel-sandbox" ? "#sandbox" : `#${stepAnchor[item.step]}`;
}

export function VerifySetupSection({ data, setData, setFlashMessage }: VerifySetupSectionProps) {
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
          {checklist.map((item) => (
            <div
              className="flex flex-col gap-3 rounded-[6px] border border-border bg-sheet px-4 py-3 sm:flex-row sm:items-start sm:justify-between"
              key={item.id}
            >
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-foreground">
                  {item.id === "linear"
                    ? "Linear API key and session routing"
                    : item.id === "sandbox"
                      ? "Workspace sandbox capability"
                      : item.label}
                </p>
                <p className="mt-0.5 text-xs leading-5 text-muted">{item.detail}</p>
                {item.id === "linear" ? (
                  <a
                    className="mt-1 inline-block text-xs font-medium text-accent underline"
                    href="#connector-resources"
                  >
                    Open Factory connector resources
                  </a>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Status
                  label={item.statusLabel ?? (item.passed ? "Ready" : "Blocked")}
                  value={configurationStatusFromTone(
                    item.statusTone ?? (item.passed ? "success" : "warning"),
                  )}
                />
                {!item.passed && item.step !== "verify" ? (
                  <a className="ui-button" href={checklistItemHref(item)}>
                    Open {stepLabel[item.step]} settings
                  </a>
                ) : null}
              </div>
            </div>
          ))}
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
                ? `${factoryRepository ?? "Factory repository unavailable"} · ${sandboxLabel[snapshot.sandboxProvider]}. This check does not update workspace readiness.`
                : "Run the check against the selected repository to update workspace readiness."}
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
