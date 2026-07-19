"use client";

import { useEffect, useState } from "react";

import { Status, configurationStatusFromTone, type StatusValue } from "@/components/ui/status";
import type { WorkspaceOnboardingData } from "@/features/onboarding/data";
import { ONBOARDING_STEPS } from "@/features/onboarding/flow";
import { ONBOARDING_FOCUS_TARGETS } from "@/features/onboarding/progress";
import {
  buildRuntimeReadiness,
  buildVerifyChecklist,
} from "@/features/onboarding/runtime-readiness";
import { normalizeAgentProviderName } from "@/lib/agent-config/contracts";
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

function sandboxStatusValue(check: SandboxCapabilityCheckState | null): StatusValue {
  if (!check) return "not_started";
  const values = {
    error: "blocked",
    running: "running",
    success: "healthy",
  } satisfies Record<SandboxCapabilityCheckState["status"], StatusValue>;
  return values[check.status];
}

export default function VerifyStep({ data, onDataChange, onSelectStep }: OnboardingStepProps) {
  const [check, setCheck] = useState(data.setupHealth.latestSandboxCapabilityCheck);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const primaryRepositoryId = data.setupHealth.primaryRepositoryProfile.repositoryId;
  const checklist = buildVerifyChecklist({
    agentConfig: data.agentConfig,
    health: {
      ...data.setupHealth,
      latestSandboxCapabilityCheck: check,
    },
    onboarding: data.onboarding,
  });
  const isPolling = check?.status === "running";
  const canRunCapabilityCheck =
    data.canManage && Boolean(primaryRepositoryId) && busyAction === null && !isPolling;

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
          throw new Error(body?.error ?? "Capability check polling failed.");
        }
        if (cancelled || !body.check) return;
        const nextCheck = body.check;
        setCheck(nextCheck);
        onDataChange((currentData) => updateSandboxCapabilityCheckInData(currentData, nextCheck));
        if (nextCheck.status === "success" || nextCheck.status === "error") {
          window.clearInterval(timer);
        }
      } catch (error) {
        if (!cancelled) {
          setVerifyError(
            error instanceof Error ? error.message : "Capability check polling failed.",
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
    if (!canRunCapabilityCheck || !primaryRepositoryId) return;
    setBusyAction("sandbox");
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
        throw new Error(body?.error ?? "Sandbox capability check failed.");
      }
      setCheck(body.check);
      onDataChange((currentData) => updateSandboxCapabilityCheckInData(currentData, body.check));
    } catch (error) {
      setVerifyError(error instanceof Error ? error.message : "Sandbox capability check failed.");
    } finally {
      setBusyAction(null);
    }
  }

  const selectedProvider =
    typeof data.agentConfig.agent_provider === "string"
      ? (normalizeAgentProviderName(data.agentConfig.agent_provider) ?? "codex")
      : "codex";
  const vercelConnected = data.setupHealth.vercelSandboxConnection.connected;
  const runtimeReadiness = buildRuntimeReadiness({
    agentConfig: data.agentConfig,
    claudeCodeConnection: data.setupHealth.claudeCodeConnection,
    codexConnection: data.setupHealth.codexConnection,
    primaryRepositoryId: data.setupHealth.primaryRepositoryProfile.repositoryId,
    repositorySetup: data.setupHealth.repositorySetup,
  });
  // Full readiness: provider/model pairing + credentials + Claude repo setup, plus Vercel.
  const runtimeLiveReady = runtimeReadiness.canComplete && vercelConnected;
  const pipelineConfigured = data.setupHealth.defaultPipeline.configured;
  const setupSummary = [
    {
      detail: data.setupHealth.githubInstallation.connected
        ? (data.setupHealth.githubInstallation.targetName ?? "Connected")
        : "Not connected",
      id: "summary-github" as const,
      label: "GitHub",
      step: "github" as const,
      statusLabel: data.setupHealth.githubInstallation.connected ? "Configured" : "Missing",
      tone: data.setupHealth.githubInstallation.connected
        ? ("success" as const)
        : ("warning" as const),
    },
    {
      detail: data.setupHealth.selectedRepository.fullName ?? "No repository selected",
      id: "summary-repository" as const,
      label: "Repository",
      step: "repository" as const,
      statusLabel: data.setupHealth.primaryRepositoryProfile.configured ? "Configured" : "Partial",
      tone: data.setupHealth.primaryRepositoryProfile.configured
        ? ("success" as const)
        : ("warning" as const),
    },
    {
      detail: data.pipeline
        ? `${data.pipeline.name} · ${data.pipeline.stages.length} stages`
        : "No default pipeline",
      id: "summary-pipeline" as const,
      label: "Pipeline",
      step: "pipeline" as const,
      // Badge reflects live pipeline health — historical completedSteps alone is not Configured.
      statusLabel: pipelineConfigured ? "Configured" : "Missing",
      tone: pipelineConfigured ? ("success" as const) : ("warning" as const),
    },
    {
      detail:
        data.setupHealth.linearKey.configured && data.setupHealth.linearRouting.configured
          ? "API key and routing"
          : data.setupHealth.linearKey.configured
            ? "API key saved · routing incomplete"
            : data.onboarding.skippedSteps.includes("linear")
              ? "Skipped for now"
              : "Not configured",
      id: "summary-linear" as const,
      label: "Linear",
      step: "linear" as const,
      // Badge reflects live health — historical completedSteps alone is not Configured.
      statusLabel: data.onboarding.skippedSteps.includes("linear")
        ? "Skipped"
        : data.setupHealth.linearKey.configured && data.setupHealth.linearRouting.configured
          ? "Configured"
          : "Missing",
      tone: data.onboarding.skippedSteps.includes("linear")
        ? ("warning" as const)
        : data.setupHealth.linearKey.configured && data.setupHealth.linearRouting.configured
          ? ("success" as const)
          : ("warning" as const),
    },
    {
      detail: data.onboarding.skippedSteps.includes("runtime")
        ? "Skipped for now"
        : `${selectedProvider} · ${vercelConnected ? "Vercel connected" : "Vercel missing"}`,
      id: "summary-runtime" as const,
      label: "Agent",
      step: "runtime" as const,
      // Badge reflects full live readiness — connection alone is not Configured.
      statusLabel: data.onboarding.skippedSteps.includes("runtime")
        ? "Skipped"
        : runtimeLiveReady
          ? "Configured"
          : "Missing",
      tone: data.onboarding.skippedSteps.includes("runtime")
        ? ("warning" as const)
        : runtimeLiveReady
          ? ("success" as const)
          : ("warning" as const),
    },
  ];

  return (
    <div className="space-y-5" id={ONBOARDING_FOCUS_TARGETS.verify} tabIndex={-1}>
      {verifyError ? (
        <div
          className="rounded-[6px] border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] text-danger"
          role="alert"
        >
          {verifyError}
        </div>
      ) : null}

      <div className="rounded-[6px] border border-border bg-sheet p-4">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold text-foreground">Setup review</h3>
          <p className="mt-1 text-xs leading-5 text-muted">
            Review every integration and pipeline choice. Open a step to change it without losing
            saved work.
          </p>
        </div>
        <div className="mt-4 space-y-2">
          {setupSummary.map((item) => (
            <div
              className="flex flex-col gap-3 rounded-[6px] border border-border bg-sheet px-3 py-2 sm:flex-row sm:items-start sm:justify-between"
              key={item.id}
            >
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground">{item.label}</p>
                <p className="mt-0.5 text-xs leading-5 text-muted">{item.detail}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Status label={item.statusLabel} value={configurationStatusFromTone(item.tone)} />
                <button
                  className="ui-button"
                  data-step-link={item.step}
                  onClick={() => onSelectStep(item.step)}
                  type="button"
                >
                  Open {ONBOARDING_STEPS.find((step) => step.id === item.step)?.shortTitle}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-[6px] border border-border bg-sheet p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-foreground">Readiness checklist</h3>
            <p className="mt-1 text-xs leading-5 text-muted">
              Resolve blockers in their owning setup step, then complete onboarding.
            </p>
          </div>
        </div>

        <div className="mt-4 space-y-2">
          {checklist.map((item) => (
            <div
              className="flex flex-col gap-3 rounded-[6px] border border-border bg-sheet px-3 py-2 sm:flex-row sm:items-start sm:justify-between"
              key={item.id}
            >
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground">{item.label}</p>
                <p className="mt-0.5 text-xs leading-5 text-muted">{item.detail}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Status
                  label={item.statusLabel ?? (item.passed ? "Ready" : "Blocked")}
                  value={configurationStatusFromTone(
                    item.statusTone ?? (item.passed ? "success" : "warning"),
                  )}
                />
                {!item.passed && item.step !== "verify" ? (
                  <button
                    className="ui-button"
                    data-step-link={item.step}
                    onClick={() => onSelectStep(item.step)}
                    type="button"
                  >
                    Open {ONBOARDING_STEPS.find((step) => step.id === item.step)?.shortTitle}
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-[6px] border border-border bg-sheet p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-foreground">Sandbox capability</h3>
            <p className="mt-1 text-xs leading-5 text-muted">
              Checks run against the selected repository.
            </p>
          </div>
          <Status label={check ? undefined : "No check"} value={sandboxStatusValue(check)} />
        </div>
        {check?.errorText ? (
          <p className="mt-3 text-xs leading-5 text-danger">{check.errorText}</p>
        ) : null}
        {check ? (
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {Object.entries(check.capabilities).map(([name, result]) => {
              const value: StatusValue = result?.ok ? "healthy" : "blocked";
              return (
                <div className="rounded-[6px] border border-border px-3 py-2" key={name}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-foreground">{name}</p>
                    <Status compact value={value} />
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted">
                    {result?.detail ?? "No detail recorded."}
                  </p>
                </div>
              );
            })}
          </div>
        ) : null}
        <div className="mt-4 flex justify-end">
          <button
            className={check?.status === "error" ? "ui-button" : "ui-button-primary"}
            disabled={!canRunCapabilityCheck}
            onClick={() => void runCapabilityCheck()}
            type="button"
          >
            {busyAction === "sandbox"
              ? "Starting…"
              : isPolling
                ? "Checking…"
                : check?.status === "error"
                  ? "Retry capability check"
                  : "Run capability check"}
          </button>
        </div>
      </div>
    </div>
  );
}
