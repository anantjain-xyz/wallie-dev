"use client";

import { useEffect, useRef, useState } from "react";

import { SetupCheck } from "@/features/onboarding/setup-check";
import type { WorkspaceOnboardingData } from "@/features/onboarding/data";
import { ONBOARDING_STEPS } from "@/features/onboarding/flow";
import {
  buildVerifyChecklist,
  capabilityCheckMatchesCurrentSetup,
  resolveAgentConfigValue,
  type VerifyChecklistItem,
} from "@/features/onboarding/runtime-readiness";
import type { WorkspaceOnboardingStep } from "@/lib/onboarding/contracts";
import type {
  SandboxCapabilityCheckLatestResponse,
  SandboxCapabilityCheckResponse,
  SandboxCapabilityCheckState,
} from "@/lib/sandbox-capabilities/contracts";

import type { OnboardingStepProps } from "./types";

export function updateSandboxCapabilityCheckInData(
  currentData: WorkspaceOnboardingData,
  check: SandboxCapabilityCheckState,
): WorkspaceOnboardingData {
  return {
    ...currentData,
    setupHealth: {
      ...currentData.setupHealth,
      latestSandboxCapabilityCheck: check,
    },
  };
}

const configurationGroups: { label: string; steps: WorkspaceOnboardingStep[] }[] = [
  { label: "Repository", steps: ["github", "repository"] },
  { label: "Pipeline", steps: ["pipeline"] },
  { label: "Agent", steps: ["runtime"] },
  { label: "Sandbox", steps: ["sandbox"] },
  { label: "Linear (optional)", steps: ["linear"] },
];

function configurationDetail(data: WorkspaceOnboardingData, label: string) {
  switch (label) {
    case "Repository":
      return data.setupHealth.primaryRepositoryProfile.fullName;
    case "Pipeline":
      return `${data.setupHealth.defaultPipeline.stageCount} ${data.setupHealth.defaultPipeline.stageCount === 1 ? "stage" : "stages"}`;
    case "Agent":
      return `${resolveAgentConfigValue("agent_provider", data.agentConfig)} · ${resolveAgentConfigValue("agent_model", data.agentConfig)}`;
    case "Sandbox":
      return data.setupHealth.sandboxConnection?.providerLabel ?? "Vercel Sandbox";
    default:
      return null;
  }
}

function blockerLabel(item: VerifyChecklistItem) {
  switch (item.id) {
    case "github":
      return "GitHub connection";
    case "repository-profile":
      return "Repository profile";
    case "repository-setup":
      return "Repository setup";
    case "pipeline":
      return "Review your pipeline";
    case "linear":
      return "Connect or skip Linear";
    case "runtime":
      return "Save or skip agent settings";
    case "provider-credentials":
      return "Agent access";
    default:
      return "Sandbox connection";
  }
}

export default function VerifyStep({
  data,
  isSaving,
  onDataChange,
  onSelectStep,
  onVerificationPendingChange,
}: OnboardingStepProps) {
  const check = data.setupHealth.latestSandboxCapabilityCheck;
  const [isStarting, setIsStarting] = useState(false);
  const startingRef = useRef(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const primaryRepositoryId = data.setupHealth.primaryRepositoryProfile.repositoryId;
  const checklist = buildVerifyChecklist({
    agentConfig: data.agentConfig,
    health: data.setupHealth,
    onboarding: data.onboarding,
  });
  const configuration = checklist.filter((item) => item.step !== "verify");
  const blockers = configuration.filter((item) => !item.passed);
  const verification = checklist.find((item) => item.id === "sandbox")!;
  const isPolling = check?.status === "running";
  const verified = verification.passed;
  const ready = verified && blockers.length === 0;
  const failed = verification.statusLabel === "Failed";
  const stale = verification.statusLabel === "Stale";
  const canRunCapabilityCheck =
    data.canManage &&
    Boolean(primaryRepositoryId) &&
    blockers.length === 0 &&
    !isSaving &&
    !isStarting &&
    !isPolling;
  const configuredGroups = configurationGroups.filter((group) =>
    configuration.filter((item) => group.steps.includes(item.step)).every((item) => item.passed),
  );
  const checkIsCurrent = capabilityCheckMatchesCurrentSetup(data.setupHealth);

  useEffect(() => {
    if (!data.canManage || !primaryRepositoryId || check?.status !== "running") return;

    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(
          `/api/workspaces/${data.workspace.id}/sandbox-capability-check?repositoryId=${encodeURIComponent(primaryRepositoryId)}`,
          { cache: "no-store" },
        );
        const body = (await response.json().catch(() => null)) as
          | (SandboxCapabilityCheckLatestResponse & { error?: string })
          | null;
        if (!response.ok || !body) {
          throw new Error(body?.error ?? "Could not check verification progress.");
        }
        if (cancelled || !body.check) return;
        const nextCheck = body.check;
        setVerifyError(null);
        onDataChange((currentData) => updateSandboxCapabilityCheckInData(currentData, nextCheck));
        if (nextCheck.status === "success" || nextCheck.status === "error") {
          window.clearInterval(timer);
        }
      } catch (error) {
        if (!cancelled) {
          setVerifyError(
            error instanceof Error ? error.message : "Could not check verification progress.",
          );
        }
      }
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [check?.status, data.canManage, data.workspace.id, onDataChange, primaryRepositoryId]);

  async function runCapabilityCheck() {
    if (!canRunCapabilityCheck || !primaryRepositoryId || startingRef.current) return;
    startingRef.current = true;
    setIsStarting(true);
    onVerificationPendingChange?.(true);
    setVerifyError(null);

    try {
      const response = await fetch(
        `/api/workspaces/${data.workspace.id}/sandbox-capability-check`,
        {
          body: JSON.stringify({ repositoryId: primaryRepositoryId }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      const body = (await response.json().catch(() => null)) as
        | (SandboxCapabilityCheckResponse & { error?: string })
        | null;
      if (!response.ok || !body) {
        throw new Error(body?.error ?? "Could not start verification.");
      }
      onDataChange((currentData) => updateSandboxCapabilityCheckInData(currentData, body.check));
    } catch (error) {
      setVerifyError(error instanceof Error ? error.message : "Could not start verification.");
    } finally {
      startingRef.current = false;
      setIsStarting(false);
      onVerificationPendingChange?.(false);
    }
  }

  return (
    <form
      id="onboarding-verification"
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        void runCapabilityCheck();
      }}
    >
      <div className="rounded-lg bg-control-hover p-5 sm:p-6" role="status" aria-live="polite">
        <div className="flex items-center gap-2">
          {ready ? <SetupCheck label="Verification passed" /> : null}
          <h3 className="text-base font-semibold tracking-tight text-foreground">
            {isStarting || isPolling
              ? "Checking your setup…"
              : blockers.length > 0
                ? "A few things need attention"
                : ready
                  ? "You’re ready for your first task"
                  : failed
                    ? "Verification needs attention"
                    : stale
                      ? "Your setup has changed"
                      : "Your connections are saved"}
          </h3>
        </div>
        <p className="mt-2 text-[13px] leading-6 text-muted">
          {isStarting || isPolling
            ? "We’re checking that your repository, agent, and sandbox work together."
            : blockers.length > 0
              ? "Finish the items below, then verify your setup."
              : ready
                ? "Your repository, agent, and sandbox passed verification."
                : failed
                  ? verification.detail
                  : stale
                    ? "Verify again to check your current repository, agent, and sandbox."
                    : "Run one final check to make sure your repository, agent, and sandbox work together."}
        </p>
        {!data.canManage && (data.onboarding.status !== "completed" || !ready) ? (
          <p className="mt-2 text-[13px] leading-6 text-muted">
            A workspace owner or admin can verify and complete setup.
          </p>
        ) : null}
      </div>

      {verifyError ? (
        <p className="text-[13px] leading-6 text-danger" role="alert">
          {verifyError}
        </p>
      ) : null}

      {failed && blockers.length > 0 ? (
        <p className="text-[13px] leading-6 text-danger" role="alert">
          {verification.detail}
        </p>
      ) : null}

      {blockers.length > 0 ? (
        <section aria-label="Needs attention">
          <ul className="divide-y divide-border">
            {blockers.map((item) => (
              <li
                className="flex flex-col gap-3 py-4 first:pt-0 sm:flex-row sm:items-start sm:justify-between"
                key={item.id}
              >
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-foreground">{blockerLabel(item)}</p>
                  <p className="mt-1 text-[13px] leading-5 text-muted">{item.detail}</p>
                </div>
                <button
                  className="ui-button shrink-0 self-start"
                  data-step-link={item.step}
                  disabled={isSaving}
                  onClick={() => onSelectStep(item.step)}
                  type="button"
                >
                  Open {ONBOARDING_STEPS.find((step) => step.id === item.step)?.shortTitle}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {configuredGroups.length > 0 ? (
        <details className="group border-t border-border">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 py-3 text-[13px] font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [&::-webkit-details-marker]:hidden">
            <span aria-hidden="true" className="text-muted group-open:rotate-90">
              ›
            </span>
            View configuration
          </summary>
          <ul className="divide-y divide-border">
            {configuredGroups.map((group) => {
              const skipped =
                group.steps.some((step) => data.onboarding.skippedSteps.includes(step)) ||
                (group.steps.includes("linear") &&
                  (!data.setupHealth.linearKey.configured ||
                    !data.setupHealth.linearRouting.configured)) ||
                (group.steps.includes("runtime") && !data.setupHealth.agentConfig.configured);
              return (
                <li key={group.label} className="flex items-center gap-3 py-3">
                  {skipped ? (
                    <span
                      aria-hidden="true"
                      className="inline-flex size-4 shrink-0 justify-center text-muted"
                    >
                      –
                    </span>
                  ) : (
                    <SetupCheck label="Configured" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium text-foreground">{group.label}</p>
                    {!skipped && configurationDetail(data, group.label) ? (
                      <p className="mt-0.5 break-words text-[13px] text-muted">
                        {configurationDetail(data, group.label)}
                      </p>
                    ) : null}
                  </div>
                  {skipped ? <span className="text-xs text-muted">Skipped</span> : null}
                  <button
                    className="min-h-11 px-2 text-xs text-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    disabled={isSaving}
                    type="button"
                    aria-label={`Edit ${group.label}`}
                    onClick={() =>
                      onSelectStep(
                        group.steps.includes("repository") ? "repository" : group.steps[0],
                      )
                    }
                  >
                    Edit
                  </button>
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}

      {check && Object.keys(check.capabilities).length > 0 ? (
        <details className="group border-t border-border" open={failed || undefined}>
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 py-3 text-[13px] font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [&::-webkit-details-marker]:hidden">
            <span aria-hidden="true" className="text-muted group-open:rotate-90">
              ›
            </span>
            {checkIsCurrent ? "Verification details" : "Previous verification details"}
          </summary>
          {!checkIsCurrent ? (
            <p className="pb-3 text-[13px] text-muted">
              These results do not verify your current setup.
            </p>
          ) : null}
          <ul className="divide-y divide-border">
            {Object.entries(check.capabilities).map(([name, result]) => (
              <li className="flex items-start gap-3 py-3" key={name}>
                {result?.ok ? (
                  <SetupCheck label="Passed" />
                ) : (
                  <span className="text-xs text-danger">Failed</span>
                )}
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-foreground">{name}</p>
                  <p className="mt-1 break-words text-[13px] leading-5 text-muted">
                    {result?.detail ?? "No detail recorded."}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </form>
  );
}
