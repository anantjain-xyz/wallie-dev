"use client";

import type { Dispatch, SetStateAction } from "react";

import { buildVerifyChecklist } from "@/features/onboarding/runtime-readiness";
import { SandboxCapabilitySection } from "@/features/settings/sandbox-capability-section";
import type { SettingsPageData } from "@/features/settings/data";
import type { FlashMessage } from "@/features/settings/settings-types";
import { Section, StatusBadge } from "@/features/settings/settings-ui";
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
  verify: "verify",
};

export function VerifySetupSection({ data, setData, setFlashMessage }: VerifySetupSectionProps) {
  const checklist = buildVerifyChecklist({
    agentConfig: data.agentConfig,
    health: data.setupHealth,
    mode: "settings",
    onboarding: data.onboarding,
  });
  const blockers = checklist.filter((item) => !item.passed);
  const preferredRepositoryId =
    data.setupHealth.primaryRepositoryProfile.repositoryId ??
    data.setupHealth.selectedRepository.repositoryId;

  return (
    <Section
      anchorId="verify"
      statusBadge={
        <StatusBadge tone={blockers.length === 0 ? "success" : "warning"}>
          {blockers.length === 0 ? "Ready" : `${blockers.length} blocked`}
        </StatusBadge>
      }
      tagline="Confirm setup health before Wallie starts running sessions against this workspace."
      title="Verify setup"
    >
      <div className="space-y-8">
        <div className="space-y-3">
          {checklist.map((item) => (
            <div
              className="flex flex-col gap-3 rounded-[6px] border border-border bg-surface px-4 py-3 sm:flex-row sm:items-start sm:justify-between"
              key={item.id}
            >
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-foreground">{item.label}</p>
                <p className="mt-0.5 text-[12px] leading-5 text-muted">{item.detail}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <StatusBadge tone={item.passed ? "success" : "warning"}>
                  {item.passed ? "Ready" : "Blocked"}
                </StatusBadge>
                {!item.passed && item.step !== "verify" ? (
                  <a className="ui-button" href={`#${stepAnchor[item.step]}`}>
                    Open
                  </a>
                ) : null}
              </div>
            </div>
          ))}
        </div>

        <div className="border-t border-border pt-6">
          <div className="mb-4 min-w-0">
            <h3 className="text-[14px] font-semibold text-foreground">Sandbox capability</h3>
            <p className="mt-1 text-[12px] leading-5 text-muted">
              Run the check against the selected primary repository.
            </p>
          </div>
          <SandboxCapabilitySection
            canManage={data.canManage}
            initialCheck={data.setupHealth.latestSandboxCapabilityCheck}
            onCheckChange={(check) =>
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
            setFlashMessage={setFlashMessage}
            workspaceId={data.workspace.id}
          />
        </div>
      </div>
    </Section>
  );
}
