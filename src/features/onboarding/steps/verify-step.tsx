"use client";

import { useEffect, useRef, useState } from "react";

import { TimeDisplay } from "@/components/shared/time-display";
import { Status, configurationStatusFromTone } from "@/components/ui/status";
import type { WorkspaceOnboardingData } from "@/features/onboarding/data";
import { ONBOARDING_GROUPS } from "@/features/onboarding/flow";
import {
  capabilityCheckMatchesCurrentSetup,
  resolveAgentConfigValue,
  type VerifyChecklistItem,
} from "@/features/onboarding/runtime-readiness";
import { SetupCheck } from "@/features/onboarding/setup-check";
import {
  getSetupVerificationChecklist,
  getVerificationRecovery,
} from "@/features/onboarding/verification-presentation";
import { cn } from "@/lib/utils";
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

const capabilityNames: Record<string, string> = {
  git: "Git",
  node: "Node.js",
  packageManager: "Package manager",
  agentCli: "Agent CLI",
  codexExternalSandbox: "Codex external sandbox",
  playwrightPackage: "Playwright",
  chromium: "Chromium",
  screenshotSmoke: "Screenshot test",
};

const sandboxNames = {
  daytona: "Daytona",
  e2b: "E2B",
  fake: "Local test sandbox",
  vercel: "Vercel Sandbox",
};

function describeCheck(item: VerifyChecklistItem, data: WorkspaceOnboardingData) {
  const { setupHealth } = data;
  if (
    item.id === "repository-setup" &&
    !item.passed &&
    setupHealth.repositorySetup.status === "pr_open"
  ) {
    return "The repository’s setup pull request is still open. Merge it before verifying.";
  }
  if (item.id === "linear") {
    const connected = setupHealth.linearKey.configured && setupHealth.linearRouting.configured;
    if (!item.passed) return "Connect and test Linear, or choose Skip Linear to use prompts.";
    return connected
      ? "Linear key and status routing are saved."
      : "Linear isn’t connected. You can start from a prompt.";
  }
  if (item.id === "runtime" && item.passed) {
    const provider = resolveAgentConfigValue("agent_provider", data.agentConfig);
    const model = resolveAgentConfigValue("agent_model", data.agentConfig);
    return `${provider} · ${model}${setupHealth.agentConfig.configured ? "" : " (defaults)"}`;
  }
  if (item.id === "runtime" && !item.passed)
    return "Save or skip agent settings. Agent access is checked separately.";
  if (item.id === "pipeline" && item.passed && setupHealth.defaultPipeline.configured) {
    const count = setupHealth.defaultPipeline.stageCount;
    return `${count} saved ${count === 1 ? "stage" : "stages"}.`;
  }
  return item.detail;
}

function checkStatus(item: VerifyChecklistItem, data: WorkspaceOnboardingData) {
  if (
    item.id === "linear" &&
    item.passed &&
    (!data.setupHealth.linearKey.configured || !data.setupHealth.linearRouting.configured)
  ) {
    return { label: "Not connected", tone: "neutral" } as const;
  }
  if (item.id === "runtime" && item.passed && !data.setupHealth.agentConfig.configured) {
    return { label: "Defaults", tone: "neutral" } as const;
  }
  return {
    label: item.statusLabel ?? (item.passed ? "Ready" : "Blocked"),
    tone: item.statusTone ?? (item.passed ? "success" : "warning"),
  } as const;
}

export default function VerifyStep({
  data,
  initialNow = "1970-01-01T00:00:00.000Z",
  isSaving,
  onDataChange,
  onVerificationPendingChange,
  verificationActions,
}: OnboardingStepProps) {
  const check = data.setupHealth.latestSandboxCapabilityCheck;
  const [isStarting, setIsStarting] = useState(false);
  const startingRef = useRef(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const primaryRepositoryId = data.setupHealth.primaryRepositoryProfile.repositoryId;
  const checklist = getSetupVerificationChecklist(data);
  const firstBlocker = checklist.find((item) => !item.passed);
  const needsRepair = getVerificationRecovery(data, firstBlocker);
  const isPolling = check?.status === "running";
  const canRunCapabilityCheck =
    data.canManage &&
    Boolean(primaryRepositoryId) &&
    !needsRepair &&
    !isSaving &&
    !isStarting &&
    !isPolling;
  const checkIsCurrent = capabilityCheckMatchesCurrentSetup(data.setupHealth);
  const checkRepository =
    check &&
    data.github.repositories.find((repository) => repository.id === check.githubRepositoryId);
  const isComplete = data.onboarding.status === "completed";
  const hasCompletedBefore = isComplete || data.onboarding.completedAt !== null;
  const checking = isStarting || firstBlocker?.statusLabel === "Running";
  const failed = firstBlocker?.id === "sandbox" && firstBlocker.statusLabel === "Failed";
  const stale =
    firstBlocker?.id === "sandbox" &&
    (firstBlocker.statusLabel === "Stale" ||
      (firstBlocker.statusLabel === "Not started" && Boolean(check)));
  const firstFailedCapability = failed
    ? Object.values(check?.capabilities ?? {}).find((result) => result?.ok === false)
    : null;
  const statusTitle = needsRepair
    ? needsRepair.title
    : checking
      ? "Checking your setup…"
      : failed
        ? "Verification failed"
        : stale
          ? "Setup has changed"
          : firstBlocker
            ? "Verification required"
            : "Setup is ready";
  const statusDetail =
    needsRepair && firstBlocker
      ? describeCheck(firstBlocker, data)
      : checking
        ? "Checking the repository, agent, and sandbox."
        : failed
          ? check?.errorText || firstFailedCapability?.detail || firstBlocker.detail
          : stale
            ? isPolling
              ? "The previous check is still running. Verify again when it finishes."
              : "The previous result doesn’t verify the current repository, agent, and sandbox."
            : firstBlocker
              ? "Run a check for the current repository, agent, and sandbox."
              : "The current repository, agent, and sandbox have passed verification.";
  const adminHandoff =
    needsRepair?.handoff ??
    (!firstBlocker
      ? "finish setup"
      : checking
        ? "follow up on the verification result"
        : "verify the current setup");

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
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void runCapabilityCheck();
      }}
    >
      <div
        className={cn(
          "space-y-1 border-l-2 pl-3",
          needsRepair || stale
            ? "border-warning"
            : failed
              ? "border-danger"
              : firstBlocker
                ? "border-border"
                : "border-success",
        )}
        role="status"
        aria-live="polite"
      >
        <h3 className="text-[14px] font-semibold text-foreground">{statusTitle}</h3>
        <p className="text-[13px] leading-5 text-foreground [overflow-wrap:anywhere]">
          {statusDetail}
        </p>
        {!data.canManage && (firstBlocker || !isComplete) ? (
          <p className="text-[13px] leading-5 text-muted">
            Read only. Ask a workspace owner or admin to {adminHandoff}.
          </p>
        ) : null}
      </div>

      {verifyError ? (
        <p className="text-[13px] leading-5 text-danger [overflow-wrap:anywhere]" role="alert">
          {verifyError}
        </p>
      ) : null}
      {verificationActions}
      {hasCompletedBefore ? (
        <p className="type-annotation text-muted">
          Setup was completed previously
          {data.onboarding.completedAt ? (
            <>
              {" · "}
              <TimeDisplay
                initialNow={initialNow}
                value={data.onboarding.completedAt}
                variant="relative"
              />
            </>
          ) : null}
          .
        </p>
      ) : null}

      <details className="group border-t border-border">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-sm text-[13px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [&::-webkit-details-marker]:hidden">
          <span aria-hidden="true" className="text-muted group-open:rotate-90">
            ›
          </span>
          All checks
        </summary>
        <div className="space-y-5 pb-3">
          {ONBOARDING_GROUPS.map((group) => (
            <section key={group.title} className="space-y-1">
              <h4 className="text-[13px] font-semibold text-foreground">{group.title}</h4>
              <dl className="divide-y divide-border">
                {checklist
                  .filter((item) => group.steps.includes(item.step))
                  .map((item) => {
                    const status = checkStatus(item, data);
                    return (
                      <div key={item.id} className="py-2">
                        <dt className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-medium">
                          {item.id === "linear" ? "Linear (optional)" : item.label}
                          <Status
                            label={status.label}
                            value={configurationStatusFromTone(status.tone)}
                          />
                        </dt>
                        <dd className="mt-1 text-[13px] leading-5 text-muted [overflow-wrap:anywhere]">
                          {describeCheck(item, data)}
                        </dd>
                      </div>
                    );
                  })}
              </dl>
            </section>
          ))}
          {check ? (
            <section className="space-y-2 border-t border-border pt-4">
              <h4 className="text-[13px] font-semibold text-foreground">
                {checkIsCurrent ? "Current verification result" : "Previous verification result"}
              </h4>
              {!checkIsCurrent ? (
                <p className="text-[13px] text-muted">
                  These results don’t verify the current setup.
                </p>
              ) : null}
              <dl className="space-y-1 text-[13px] leading-5 text-muted [overflow-wrap:anywhere]">
                <div>
                  <dt className="inline font-medium text-foreground">Repository: </dt>
                  <dd className="inline" translate="no">
                    {checkRepository?.fullName ?? check.githubRepositoryId ?? "Not recorded"}
                  </dd>
                </div>
                <div>
                  <dt className="inline font-medium text-foreground">Sandbox: </dt>
                  <dd className="inline" translate="no">
                    {check.sandboxProvider ? sandboxNames[check.sandboxProvider] : "Not recorded"}
                    {check.sandboxVercelProjectId ? ` · ${check.sandboxVercelProjectId}` : ""}
                    {check.sandboxConnectionRevision
                      ? ` · revision ${check.sandboxConnectionRevision}`
                      : ""}
                  </dd>
                </div>
                <div>
                  <dt className="inline font-medium text-foreground">Agent: </dt>
                  <dd className="inline" translate="no">
                    {[check.agentProvider, check.agentModel].filter(Boolean).join(" · ") ||
                      "Not recorded"}
                  </dd>
                </div>
                <div>
                  <dt className="inline font-medium text-foreground">Checked: </dt>
                  <dd className="inline">
                    <TimeDisplay initialNow={initialNow} value={check.checkedAt} />
                  </dd>
                </div>
              </dl>
              {Object.keys(check.capabilities).length ? (
                <ul className="divide-y divide-border">
                  {Object.entries(check.capabilities).map(([name, result]) => (
                    <li className="flex items-start gap-3 py-3" key={name}>
                      {result?.ok ? (
                        <SetupCheck label="Passed" />
                      ) : (
                        <span className="text-xs text-danger">Failed</span>
                      )}
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium text-foreground">
                          {capabilityNames[name] ?? name}
                        </p>
                        <p className="text-[13px] leading-5 text-muted [overflow-wrap:anywhere]">
                          {result?.detail ?? "No detail recorded."}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
        </div>
      </details>
    </form>
  );
}
