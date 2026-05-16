"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";

import type { WorkspaceOnboardingData } from "@/features/onboarding/data";
import {
  buildOnboardingContinuePatch,
  buildOnboardingExitPatch,
  buildOnboardingRailNavigationPatch,
  buildOnboardingSkipPatch,
  canSkipOnboardingStep,
  getOnboardingStepRailItems,
  onboardingStepIndex,
  ONBOARDING_STEPS,
  type OnboardingStepDisplayState,
} from "@/features/onboarding/flow";
import type {
  OnboardingSetupHealth,
  WorkspaceOnboardingStep,
  WorkspaceOnboardingUpdatePayload,
} from "@/lib/onboarding/contracts";
import { workspaceBasePath, workspaceSettingsPath } from "@/lib/routes";
import { cn } from "@/lib/utils";

type OnboardingPageClientProps = {
  initialData: WorkspaceOnboardingData;
};

type HealthTone = "accent" | "danger" | "neutral" | "success" | "warning";

type HealthSummaryItem = {
  detail: string;
  label: string;
  tone: HealthTone;
  value: string;
};

type StepHealthItem = {
  label: string;
  tone: HealthTone;
  value: string;
};

const stepStateLabels: Record<OnboardingStepDisplayState, string> = {
  active: "Current",
  available: "Available",
  blocked: "Blocked",
  completed: "Complete",
  skipped: "Skipped",
};

const badgeToneClasses: Record<HealthTone, string> = {
  accent: "ui-badge-neutral",
  danger: "ui-badge-danger",
  neutral: "ui-badge-neutral",
  success: "ui-badge-neutral",
  warning: "ui-badge-neutral",
};

const railStateClasses: Record<OnboardingStepDisplayState, string> = {
  active: "border-border-strong bg-background text-foreground shadow-sm",
  available: "border-border bg-surface text-foreground hover:bg-surface-strong",
  blocked: "border-border bg-surface-muted text-muted opacity-70",
  completed: "border-border bg-surface text-muted hover:bg-surface-strong",
  skipped: "border-border bg-surface text-muted hover:bg-surface-strong",
};

function StepStateIcon({ state }: { state: OnboardingStepDisplayState }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "h-2 w-2 rounded-full",
        state === "active" ? "bg-foreground" : "bg-muted/60",
        state === "blocked" && "bg-border-strong",
      )}
    />
  );
}

function Badge({ children, tone }: { children: string; tone: HealthTone }) {
  return (
    <span className={cn("ui-badge whitespace-nowrap", badgeToneClasses[tone])}>
      <span className="ui-badge-dot" />
      {children}
    </span>
  );
}

function presenceBadge(configured: boolean) {
  return configured
    ? { tone: "success" as const, value: "Present" }
    : { tone: "warning" as const, value: "Missing" };
}

function setupHealthItems(health: OnboardingSetupHealth): HealthSummaryItem[] {
  const github = health.githubInstallation.connected
    ? {
        detail: health.githubInstallation.targetName ?? "Connected installation",
        tone: "success" as const,
        value: "Connected",
      }
    : {
        detail: "No active installation",
        tone: "warning" as const,
        value: "Missing",
      };
  const pipeline = health.defaultPipeline.configured
    ? {
        detail: `${health.defaultPipeline.stageCount} stages`,
        tone: "success" as const,
        value: "Ready",
      }
    : {
        detail: "Default pipeline unavailable",
        tone: "warning" as const,
        value: "Missing",
      };
  const linearKey = presenceBadge(health.linearKey.configured);
  const linearRouting = presenceBadge(health.linearRouting.configured);
  const agentConfig = presenceBadge(health.agentConfig.configured);
  const codex = health.codexConnection.connected
    ? { tone: "success" as const, value: "Connected" }
    : health.codexConnection.status === "expired"
      ? { tone: "danger" as const, value: "Expired" }
      : { tone: "warning" as const, value: "Missing" };
  const sandbox = health.latestSandboxCapabilityCheck
    ? health.latestSandboxCapabilityCheck.status === "success"
      ? { tone: "success" as const, value: "Ready" }
      : health.latestSandboxCapabilityCheck.status === "running"
        ? { tone: "accent" as const, value: "Running" }
        : { tone: "danger" as const, value: "Error" }
    : { tone: "neutral" as const, value: "No check" };

  return [
    { detail: github.detail, label: "GitHub", tone: github.tone, value: github.value },
    {
      detail: "Repository selector pending",
      label: "Repository",
      tone: "neutral",
      value: "Pending",
    },
    { detail: pipeline.detail, label: "Pipeline", tone: pipeline.tone, value: pipeline.value },
    {
      detail: health.linearKey.updatedAt ? "Credential stored" : "Workspace secret required",
      label: "Linear key",
      tone: linearKey.tone,
      value: linearKey.value,
    },
    {
      detail: health.linearRouting.updatedAt ? "Routes saved" : "Routing not mapped",
      label: "Linear routing",
      tone: linearRouting.tone,
      value: linearRouting.value,
    },
    {
      detail: health.agentConfig.configuredKeys.length
        ? health.agentConfig.configuredKeys.join(", ")
        : "Agent settings required",
      label: "Agent config",
      tone: agentConfig.tone,
      value: agentConfig.value,
    },
    {
      detail: health.codexConnection.updatedAt ? "Token available" : "Account connection required",
      label: "Codex",
      tone: codex.tone,
      value: codex.value,
    },
    {
      detail: health.latestSandboxCapabilityCheck?.checkedAt ?? "Run a capability check",
      label: "Sandbox",
      tone: sandbox.tone,
      value: sandbox.value,
    },
  ];
}

function stepHealthItems(
  step: WorkspaceOnboardingStep,
  health: OnboardingSetupHealth,
): StepHealthItem[] {
  switch (step) {
    case "github":
      return [
        {
          label: "Installation",
          tone: health.githubInstallation.connected ? "success" : "warning",
          value: health.githubInstallation.connected ? "Connected" : "Missing",
        },
        {
          label: "Target",
          tone: health.githubInstallation.targetName ? "success" : "neutral",
          value: health.githubInstallation.targetName ?? "Not selected",
        },
      ];
    case "repository":
      return [
        {
          label: "Repository setup",
          tone: "neutral",
          value: "Pending",
        },
        {
          label: "Primary profile",
          tone: "neutral",
          value: "Pending",
        },
      ];
    case "pipeline":
      return [
        {
          label: "Default pipeline",
          tone: health.defaultPipeline.configured ? "success" : "warning",
          value: health.defaultPipeline.configured ? "Ready" : "Missing",
        },
        {
          label: "Stages",
          tone: health.defaultPipeline.stageCount > 0 ? "success" : "warning",
          value: String(health.defaultPipeline.stageCount),
        },
      ];
    case "linear":
      return [
        {
          label: "Linear key",
          tone: health.linearKey.configured ? "success" : "warning",
          value: health.linearKey.configured ? "Present" : "Missing",
        },
        {
          label: "Routing",
          tone: health.linearRouting.configured ? "success" : "warning",
          value: health.linearRouting.configured ? "Mapped" : "Missing",
        },
      ];
    case "runtime":
      return [
        {
          label: "Agent config",
          tone: health.agentConfig.configured ? "success" : "warning",
          value: health.agentConfig.configured ? "Present" : "Missing",
        },
        {
          label: "Codex",
          tone: health.codexConnection.connected ? "success" : "warning",
          value: health.codexConnection.connected ? "Connected" : "Missing",
        },
        {
          label: "Sandbox",
          tone:
            health.latestSandboxCapabilityCheck?.status === "success"
              ? "success"
              : health.latestSandboxCapabilityCheck?.status === "error"
                ? "danger"
                : "neutral",
          value: health.latestSandboxCapabilityCheck?.status ?? "No check",
        },
      ];
    case "verify":
      return setupHealthItems(health).map((item) => ({
        label: item.label,
        tone: item.tone,
        value: item.value,
      }));
  }
}

function settingsHref(workspaceSlug: string, anchor: string) {
  return `${workspaceSettingsPath(workspaceSlug)}#${anchor}`;
}

function StepBody({
  health,
  step,
  workspaceSlug,
}: {
  health: OnboardingSetupHealth;
  step: WorkspaceOnboardingStep;
  workspaceSlug: string;
}) {
  const rows = stepHealthItems(step, health);
  const primaryHref =
    step === "github"
      ? settingsHref(workspaceSlug, "github")
      : step === "pipeline"
        ? settingsHref(workspaceSlug, "pipeline")
        : step === "linear"
          ? settingsHref(workspaceSlug, "linear")
          : step === "runtime"
            ? settingsHref(workspaceSlug, "coding-agent")
            : null;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {rows.map((row) => (
          <div
            key={`${step}-${row.label}`}
            className="flex min-h-12 items-center justify-between gap-3 rounded-[6px] border border-border bg-surface-strong px-3 py-2"
          >
            <span className="min-w-0 text-[12px] font-medium text-muted">{row.label}</span>
            <Badge tone={row.tone}>{row.value}</Badge>
          </div>
        ))}
      </div>

      <div className="rounded-[6px] border border-border bg-background p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-foreground">
              {step === "verify" ? "Setup health" : "Controls"}
            </h3>
            <p className="mt-1 text-[13px] leading-5 text-muted">
              {step === "repository"
                ? "Repository selection controls will appear here when repository setup is wired."
                : step === "verify"
                  ? "Review the health summary, then complete setup when the required signals are ready."
                  : "Use the linked settings area for now; this step will receive inline controls in a later integration issue."}
            </p>
          </div>
          {primaryHref ? (
            <Link className="ui-button shrink-0" href={primaryHref}>
              Open settings
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function StepRail({
  canManage,
  items,
  onSelect,
}: {
  canManage: boolean;
  items: ReturnType<typeof getOnboardingStepRailItems>;
  onSelect: (step: WorkspaceOnboardingStep) => void;
}) {
  return (
    <ol className="space-y-2">
      {items.map((step) => (
        <li key={step.id}>
          <button
            type="button"
            aria-current={step.displayState === "active" ? "step" : undefined}
            className={cn(
              "flex w-full items-center gap-3 rounded-[8px] border px-3 py-2.5 text-left transition-colors",
              railStateClasses[step.displayState],
              (!canManage || !step.isNavigable) && "cursor-not-allowed",
            )}
            disabled={!canManage || !step.isNavigable}
            onClick={() => onSelect(step.id)}
          >
            <StepStateIcon state={step.displayState} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold">{step.title}</span>
              <span className="mt-0.5 block text-[11px] text-current opacity-75">
                {stepStateLabels[step.displayState]}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function MobileStepControl({
  canManage,
  items,
  onSelect,
}: {
  canManage: boolean;
  items: ReturnType<typeof getOnboardingStepRailItems>;
  onSelect: (step: WorkspaceOnboardingStep) => void;
}) {
  return (
    <div className="border-b border-border bg-surface px-3 py-2 lg:hidden">
      <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Setup steps">
        {items.map((step) => (
          <button
            key={step.id}
            type="button"
            aria-current={step.displayState === "active" ? "step" : undefined}
            className={cn(
              "inline-flex h-9 min-w-[112px] items-center justify-center gap-1.5 rounded-[6px] border px-2 text-[12px] font-medium",
              railStateClasses[step.displayState],
              (!canManage || !step.isNavigable) && "cursor-not-allowed",
            )}
            disabled={!canManage || !step.isNavigable}
            onClick={() => onSelect(step.id)}
          >
            <StepStateIcon state={step.displayState} />
            <span className="truncate">{step.shortTitle}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SetupHealthSummary({ health }: { health: OnboardingSetupHealth }) {
  return (
    <aside className="ui-panel h-fit p-4">
      <h2 className="text-[14px] font-semibold text-foreground">Setup health</h2>
      <div className="mt-4 space-y-3">
        {setupHealthItems(health).map((item) => (
          <div key={item.label} className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[12px] font-medium text-foreground">{item.label}</p>
              <p className="mt-0.5 truncate text-[11px] text-muted">{item.detail}</p>
            </div>
            <Badge tone={item.tone}>{item.value}</Badge>
          </div>
        ))}
      </div>
    </aside>
  );
}

export function OnboardingPageClient({ initialData }: OnboardingPageClientProps) {
  const router = useRouter();
  const [data, setData] = useState(initialData);
  const [error, setError] = useState<string | null>(null);
  const [savingAction, setSavingAction] = useState<string | null>(null);
  const saveInFlightRef = useRef(false);
  const onboarding = data.onboarding;
  const activeStep = ONBOARDING_STEPS.find((step) => step.id === onboarding.currentStep)!;
  const railItems = useMemo(() => getOnboardingStepRailItems(onboarding), [onboarding]);
  const canGoBack = onboardingStepIndex(onboarding.currentStep) > 0;
  const isCompleted = onboarding.status === "completed";
  const isSaving = savingAction !== null;
  const skipAllowed = canSkipOnboardingStep(onboarding.currentStep);

  async function persistOnboarding(payload: WorkspaceOnboardingUpdatePayload, action: string) {
    if (!data.canManage || saveInFlightRef.current) return null;

    saveInFlightRef.current = true;
    setSavingAction(action);
    setError(null);

    try {
      const response = await fetch(`/api/workspaces/${data.workspace.id}/onboarding`, {
        body: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Failed to save onboarding state.");
      }

      const nextData = (await response.json()) as WorkspaceOnboardingData;
      setData(nextData);
      router.refresh();
      return nextData;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to save onboarding state.");
      return null;
    } finally {
      saveInFlightRef.current = false;
      setSavingAction(null);
    }
  }

  async function continueSetup() {
    await persistOnboarding(buildOnboardingContinuePatch(onboarding), "continue");
  }

  async function skipStep() {
    const patch = buildOnboardingSkipPatch(onboarding);
    if (!patch) return;
    await persistOnboarding(patch, "skip");
  }

  async function goBack() {
    const previousStep = ONBOARDING_STEPS[onboardingStepIndex(onboarding.currentStep) - 1]?.id;
    if (!previousStep) return;
    const patch = buildOnboardingRailNavigationPatch(onboarding, previousStep);
    if (!patch) return;
    await persistOnboarding(patch, "back");
  }

  async function selectStep(step: WorkspaceOnboardingStep) {
    const patch = buildOnboardingRailNavigationPatch(onboarding, step);
    if (!patch) return;
    await persistOnboarding(patch, `rail:${step}`);
  }

  async function exitSetup() {
    const patch = buildOnboardingExitPatch(onboarding);
    const nextData = patch ? await persistOnboarding(patch, "exit") : data;
    if (nextData) {
      router.push(workspaceBasePath(data.workspace.slug));
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex min-h-14 items-center justify-between gap-3 border-b border-border bg-surface px-4 sm:px-6">
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-muted">Workspace setup</p>
          <h1 className="truncate text-[15px] font-semibold text-foreground">
            {data.workspace.name}
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!data.canManage ? <Badge tone="neutral">Read only</Badge> : null}
          <button
            type="button"
            className="ui-button"
            disabled={!data.canManage || isSaving}
            onClick={() => void exitSetup()}
          >
            {savingAction === "exit" ? "Exiting..." : "Exit setup"}
          </button>
        </div>
      </header>

      <MobileStepControl
        canManage={data.canManage && !isSaving}
        items={railItems}
        onSelect={selectStep}
      />

      <main
        id="main-content"
        className="grid flex-1 grid-cols-1 gap-4 p-4 pb-24 lg:grid-cols-[220px_minmax(0,1fr)_280px] lg:p-6 lg:pb-24"
      >
        <aside className="hidden lg:block">
          <div className="sticky top-6">
            <p className="mb-3 text-[11px] font-medium text-muted">Progress</p>
            <StepRail
              canManage={data.canManage && !isSaving}
              items={railItems}
              onSelect={selectStep}
            />
          </div>
        </aside>

        <section className="ui-panel min-w-0 p-5 sm:p-6">
          <div className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  tone={
                    isCompleted
                      ? "success"
                      : onboarding.status === "dismissed"
                        ? "neutral"
                        : "accent"
                  }
                >
                  {isCompleted
                    ? "Completed"
                    : onboarding.status === "dismissed"
                      ? "Dismissed"
                      : onboarding.status === "not_started"
                        ? "Not started"
                        : "In progress"}
                </Badge>
                <span className="text-[12px] text-muted">
                  Step {onboardingStepIndex(activeStep.id) + 1} of {ONBOARDING_STEPS.length}
                </span>
              </div>
              <h2 className="mt-3 text-[24px] font-semibold text-foreground">{activeStep.title}</h2>
              <p className="mt-1 max-w-2xl text-[13px] leading-5 text-muted">
                {activeStep.description}
              </p>
            </div>
            <Badge
              tone={
                railItems.find((step) => step.id === activeStep.id)?.displayState === "completed"
                  ? "success"
                  : railItems.find((step) => step.id === activeStep.id)?.displayState === "skipped"
                    ? "warning"
                    : "accent"
              }
            >
              {
                stepStateLabels[
                  railItems.find((step) => step.id === activeStep.id)?.displayState ?? "active"
                ]
              }
            </Badge>
          </div>

          {error ? (
            <div
              className="mt-5 rounded-[6px] border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] text-danger"
              role="alert"
            >
              {error}
            </div>
          ) : null}

          <div className="mt-6">
            <StepBody
              health={data.setupHealth}
              step={activeStep.id}
              workspaceSlug={data.workspace.slug}
            />
          </div>
        </section>

        <SetupHealthSummary health={data.setupHealth} />
      </main>

      <footer className="sticky bottom-0 z-20 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-[1280px] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 text-[12px] text-muted">
            {data.canManage
              ? "Progress is saved to this workspace."
              : "Ask a workspace admin to update setup progress."}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="ui-button"
              disabled={!data.canManage || !canGoBack || isSaving}
              onClick={() => void goBack()}
            >
              {savingAction === "back" ? "Saving..." : "Back"}
            </button>
            {skipAllowed && !isCompleted ? (
              <button
                type="button"
                className="ui-button"
                disabled={!data.canManage || isSaving}
                onClick={() => void skipStep()}
              >
                {savingAction === "skip" ? "Saving..." : "Skip"}
              </button>
            ) : null}
            <button
              type="button"
              className="ui-button-primary"
              disabled={!data.canManage || isCompleted || isSaving}
              onClick={() => void continueSetup()}
            >
              {isCompleted
                ? "Setup complete"
                : savingAction === "continue"
                  ? "Saving..."
                  : activeStep.id === "verify"
                    ? "Complete setup"
                    : "Continue"}
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
