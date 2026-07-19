"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { TimeDisplay } from "@/components/shared/time-display";
import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { useOptionalRouteProgress } from "@/components/ui/route-progress";
import { Status, configurationStatusFromTone } from "@/components/ui/status";
import { useOptionalToast } from "@/components/ui/toast";
import type { WorkspaceGitHubData, WorkspaceGitHubRepository } from "@/features/github/data";
import type { WorkspaceOnboardingData } from "@/features/onboarding/data";
import {
  buildOnboardingAdvancePatch,
  buildOnboardingContinuePatch,
  buildOnboardingExitPatch,
  buildOnboardingRailNavigationPatch,
  buildOnboardingRepositorySelectionPatch,
  buildOnboardingSkipPatch,
  buildOnboardingStepCompletionPatch,
  canSkipOnboardingStep,
  getOnboardingStepRailItems,
  onboardingStepIndex,
  ONBOARDING_STEPS,
} from "@/features/onboarding/flow";
import { reduceOnboardingMutationData } from "@/features/onboarding/mutation-reducer";
import {
  OnboardingMobileStepNav,
  OnboardingProgressHeader,
  OnboardingStepRail,
  focusOnboardingTarget,
} from "@/features/onboarding/onboarding-shell";
import {
  buildOnboardingPrimaryAction,
  deriveOnboardingStepHealthFlags,
  shouldResumeToFirstIncompleteRequired,
} from "@/features/onboarding/progress";
import { buildRepositorySetupHealth } from "@/features/onboarding/repository-health";
import {
  buildRuntimeReadiness,
  buildVerifyChecklist,
  verifyBlockersFromChecklist,
  type RuntimeReadiness,
} from "@/features/onboarding/runtime-readiness";
import { ActiveOnboardingStep } from "@/features/onboarding/steps/active-step";
import {
  mergeRepositoryOnboardingState,
  repositorySetupCanAdvance,
} from "@/features/repositories/repository-setup-controls";
import type { FlashMessage } from "@/features/settings/settings-types";
import { codexCredentialTypeLabel } from "@/lib/codex/contracts";
import type {
  OnboardingSetupHealth,
  WorkspaceOnboardingConflictResponse,
  WorkspaceOnboardingMutationAction,
  WorkspaceOnboardingMutationDelta,
  WorkspaceOnboardingMutationErrorResponse,
  WorkspaceOnboardingStep,
  WorkspaceOnboardingUpdatePayload,
} from "@/lib/onboarding/contracts";
import { normalizeAgentProviderName } from "@/lib/agent-config/contracts";
import type { RepositoryOnboardingState } from "@/lib/repo-onboarding/contracts";
import type { RepositoryProfileState } from "@/lib/repo-inference/contracts";
import type { SandboxCapabilityCheckState } from "@/lib/sandbox-capabilities/contracts";
import { workspaceBasePath } from "@/lib/routes";

type OnboardingPageClientProps = {
  initialData: WorkspaceOnboardingData;
  initialNow?: string;
};

type HealthTone = "accent" | "danger" | "neutral" | "success" | "warning";

type HealthSummaryItem = {
  detail: ReactNode;
  label: string;
  tone: HealthTone;
  value: string;
};

type EditableProfile = RepositoryProfileState;
type OnboardingDataUpdate =
  | WorkspaceOnboardingData
  | ((currentData: WorkspaceOnboardingData) => WorkspaceOnboardingData);

type PersistOnboardingAction = {
  action: WorkspaceOnboardingMutationAction;
  savingAction: string;
  step: WorkspaceOnboardingStep;
};

type RuntimeCompletionState = {
  hasInvalidDrafts: boolean;
  hasUnsavedDrafts: boolean;
  readiness: RuntimeReadiness;
};

function presenceBadge(configured: boolean) {
  return configured
    ? { tone: "success" as const, value: "Saved" }
    : { tone: "warning" as const, value: "Missing" };
}

function applyGithubHealth(
  health: OnboardingSetupHealth,
  github: WorkspaceGitHubData,
  selectedGithubRepositoryId: string | null,
): OnboardingSetupHealth {
  return {
    ...health,
    githubInstallation: {
      connected: Boolean(github.installation && !github.installation.suspended),
      installationId: github.installation?.installationId ?? null,
      status: github.installation ? "present" : "missing",
      suspended: github.installation?.suspended ?? null,
      targetName: github.installation?.targetName ?? null,
      updatedAt: github.installation?.updatedAt ?? null,
    },
    ...buildRepositorySetupHealth(github, selectedGithubRepositoryId),
  };
}

function runtimeReadinessFromData(data: WorkspaceOnboardingData) {
  return buildRuntimeReadiness({
    agentConfig: data.agentConfig,
    claudeCodeConnection: data.setupHealth.claudeCodeConnection,
    codexConnection: data.setupHealth.codexConnection,
    primaryRepositoryId: data.setupHealth.primaryRepositoryProfile.repositoryId,
    repositorySetup: data.setupHealth.repositorySetup,
  });
}

export function setupHealthItems(
  health: OnboardingSetupHealth,
  initialNow = "1970-01-01T00:00:00.000Z",
): HealthSummaryItem[] {
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
  // Routing rows are seeded with workspace defaults, so `configured` is true even
  // before a Linear key exists. Only show the green "Saved" state once the key is
  // present; otherwise surface the default routes as a neutral "Defaults" badge so a
  // fresh workspace never reads as configured.
  const linearRouting = !health.linearRouting.configured
    ? { tone: "warning" as const, value: "Missing" }
    : health.linearKey.configured
      ? { tone: "success" as const, value: "Saved" }
      : { tone: "neutral" as const, value: "Defaults" };
  const agentConfig = presenceBadge(health.agentConfig.configured);
  const selectedProvider =
    typeof health.agentConfig.values.agent_provider === "string"
      ? (normalizeAgentProviderName(health.agentConfig.values.agent_provider) ?? "codex")
      : "codex";
  const providerCredential =
    selectedProvider === "claude-code"
      ? {
          connected: health.claudeCodeConnection.connected,
          credentialLabel: health.claudeCodeConnection.connected ? "Anthropic API key" : null,
          expired: false,
          updatedAt: health.claudeCodeConnection.updatedAt,
        }
      : {
          connected: health.codexConnection.connected,
          credentialLabel: health.codexConnection.credentialType
            ? codexCredentialTypeLabel(health.codexConnection.credentialType)
            : null,
          expired: health.codexConnection.status === "expired",
          updatedAt: health.codexConnection.updatedAt,
        };
  const providerCredentialBadge = providerCredential.connected
    ? { tone: "success" as const, value: "Connected" }
    : providerCredential.expired
      ? { tone: "danger" as const, value: "Expired" }
      : { tone: "warning" as const, value: "Missing" };
  const vercelSandbox = health.vercelSandboxConnection.connected
    ? {
        detail:
          health.vercelSandboxConnection.projectName ??
          health.vercelSandboxConnection.projectId ??
          "Vercel project connected",
        tone: "success" as const,
        value: "Connected",
      }
    : health.vercelSandboxConnection.status === "error"
      ? {
          detail:
            health.vercelSandboxConnection.lastValidationError ?? "Connection needs attention",
          tone: "danger" as const,
          value: "Error",
        }
      : {
          detail: "Vercel project required",
          tone: "warning" as const,
          value: "Missing",
        };
  const sandbox = health.latestSandboxCapabilityCheck
    ? !health.vercelSandboxConnection.connected
      ? { tone: "warning" as const, value: "Blocked" }
      : health.latestSandboxCapabilityCheck.status === "success"
        ? { tone: "success" as const, value: "Ready" }
        : health.latestSandboxCapabilityCheck.status === "running"
          ? { tone: "accent" as const, value: "Running" }
          : { tone: "danger" as const, value: "Error" }
    : { tone: "neutral" as const, value: "No check" };
  const sandboxDetail = !health.vercelSandboxConnection.connected ? (
    "Connect Vercel first"
  ) : health.latestSandboxCapabilityCheck ? (
    <>
      Checked{" "}
      <TimeDisplay
        initialNow={initialNow}
        value={health.latestSandboxCapabilityCheck.checkedAt}
        variant="relative"
      />
    </>
  ) : (
    "Run a capability check"
  );

  return [
    { detail: github.detail, label: "GitHub", tone: github.tone, value: github.value },
    {
      detail: health.selectedRepository.fullName ?? "No selected repository",
      label: "Repository",
      tone: health.selectedRepository.configured ? "success" : "warning",
      value: health.selectedRepository.configured ? "Selected" : "Missing",
    },
    {
      detail: health.primaryRepositoryProfile.fullName ?? "No saved profile",
      label: "Profile",
      tone: health.primaryRepositoryProfile.configured ? "success" : "warning",
      value: health.primaryRepositoryProfile.configured ? "Saved" : "Missing",
    },
    { detail: pipeline.detail, label: "Pipeline", tone: pipeline.tone, value: pipeline.value },
    {
      detail: health.linearKey.updatedAt ? "Credential stored" : "Workspace secret required",
      label: "Linear key",
      tone: linearKey.tone,
      value: linearKey.value,
    },
    {
      detail: !health.linearRouting.configured
        ? "Routing not mapped"
        : health.linearKey.configured
          ? "Routes saved"
          : "Default routes — add a Linear key",
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
      detail: providerCredential.expired
        ? "Provider credential expired"
        : providerCredential.connected && providerCredential.credentialLabel
          ? providerCredential.credentialLabel
          : "Provider credential required",
      label: "Provider access",
      tone: providerCredentialBadge.tone,
      value: providerCredentialBadge.value,
    },
    {
      detail: vercelSandbox.detail,
      label: "Vercel",
      tone: vercelSandbox.tone,
      value: vercelSandbox.value,
    },
    {
      detail: sandboxDetail,
      label: "Sandbox",
      tone: sandbox.tone,
      value: sandbox.value,
    },
  ];
}

function SetupHealthSummary({
  health,
  initialNow,
}: {
  health: OnboardingSetupHealth;
  initialNow: string;
}) {
  return (
    <aside aria-label="Setup health" className="h-fit min-w-0 lg:sticky lg:top-8">
      <h2 className="text-[13px] font-semibold tracking-tight text-foreground">Health</h2>
      <div className="mt-4 space-y-3">
        {setupHealthItems(health, initialNow).map((item) => (
          <div key={item.label} className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium text-foreground">{item.label}</p>
              <p className="mt-0.5 truncate type-annotation text-muted">{item.detail}</p>
            </div>
            <Status
              label={item.value}
              value={item.value === "Running" ? "running" : configurationStatusFromTone(item.tone)}
            />
          </div>
        ))}
      </div>
    </aside>
  );
}

export function isRepositorySelectionCurrent(
  latestSelectedRepositoryId: string | null,
  repositoryId: string,
) {
  return latestSelectedRepositoryId === repositoryId;
}

export function applySavedRepositoryProfileToData(
  currentData: WorkspaceOnboardingData,
  profile: EditableProfile,
  latestSandboxCapabilityCheck: SandboxCapabilityCheckState | null,
): WorkspaceOnboardingData {
  const nextGithub: WorkspaceGitHubData = {
    ...currentData.github,
    primaryProfile: profile,
    repositories: currentData.github.repositories.map((repository) => ({
      ...repository,
      profile:
        repository.id === profile.githubRepositoryId
          ? profile
          : repository.profile
            ? { ...repository.profile, isPrimary: false }
            : null,
    })),
  };

  return {
    ...currentData,
    github: nextGithub,
    setupHealth: applyGithubHealth(
      {
        ...currentData.setupHealth,
        latestSandboxCapabilityCheck,
      },
      nextGithub,
      currentData.onboarding.selectedGithubRepositoryId,
    ),
  };
}

export function applySavedPipelineToData(
  currentData: WorkspaceOnboardingData,
  pipeline: NonNullable<WorkspaceOnboardingData["pipeline"]>,
): WorkspaceOnboardingData {
  return {
    ...currentData,
    pipeline,
    setupHealth: {
      ...currentData.setupHealth,
      defaultPipeline: {
        configured: pipeline.stages.length > 0,
        pipelineId: pipeline.id,
        stageCount: pipeline.stages.length,
        status: pipeline.stages.length > 0 ? "ready" : "missing",
      },
    },
  };
}

export function buildRepositoryProfileCompletionPatch(
  onboarding: WorkspaceOnboardingData["onboarding"],
): WorkspaceOnboardingUpdatePayload | null {
  if (onboarding.currentStep !== "repository") return null;
  return buildOnboardingStepCompletionPatch(onboarding);
}

function selectedRepositoryFromData(data: WorkspaceOnboardingData) {
  const selectedRepositoryId =
    data.onboarding.selectedGithubRepositoryId ?? data.github.primaryProfile?.githubRepositoryId;
  if (!selectedRepositoryId) return null;
  return (
    data.github.repositories.find((repository) => repository.id === selectedRepositoryId) ?? null
  );
}

function canCompleteGitHubSetupStep(data: WorkspaceOnboardingData) {
  return (
    data.setupHealth.githubInstallation.connected &&
    data.github.repositories.some((repository) => !repository.isArchived)
  );
}

function hasSelectedRepositoryProfile(data: WorkspaceOnboardingData) {
  const selectedRepositoryId =
    data.onboarding.selectedGithubRepositoryId ?? data.github.primaryProfile?.githubRepositoryId;
  return (
    Boolean(selectedRepositoryId) &&
    data.setupHealth.primaryRepositoryProfile.configured &&
    data.setupHealth.primaryRepositoryProfile.repositoryId === selectedRepositoryId
  );
}

function canCompleteRepositoryStep(data: WorkspaceOnboardingData) {
  return (
    hasSelectedRepositoryProfile(data) &&
    repositorySetupCanAdvance(data.setupHealth.repositorySetup.status)
  );
}

function selectOnboardingStepInData(
  currentData: WorkspaceOnboardingData,
  step: WorkspaceOnboardingStep,
): WorkspaceOnboardingData {
  if (currentData.onboarding.currentStep === step) return currentData;

  return {
    ...currentData,
    onboarding: {
      ...currentData.onboarding,
      currentStep: step,
      status:
        currentData.canManage && currentData.onboarding.status !== "completed"
          ? "in_progress"
          : currentData.onboarding.status,
    },
  };
}

export function scrollOnboardingSetupToTop(target?: {
  scrollTo: (options: ScrollToOptions) => void;
}) {
  const scrollTarget = target ?? (typeof window === "undefined" ? null : window);
  scrollTarget?.scrollTo({ behavior: "auto", left: 0, top: 0 });
}

export function OnboardingPageClient({ initialData, initialNow }: OnboardingPageClientProps) {
  const renderNow = initialNow ?? "1970-01-01T00:00:00.000Z";
  const router = useRouter();
  const { startNavigation } = useOptionalRouteProgress();
  const { pushToast } = useOptionalToast();
  const [data, setData] = useState(initialData);
  const [error, setError] = useState<string | null>(null);
  const [runtimeCompletionState, setRuntimeCompletionState] = useState<RuntimeCompletionState>(
    () => {
      const readiness = runtimeReadinessFromData(initialData);
      return {
        hasInvalidDrafts: false,
        hasUnsavedDrafts: false,
        readiness,
      };
    },
  );
  const [savingAction, setSavingAction] = useState<string | null>(null);
  const saveInFlightRef = useRef(false);
  const latestDataRef = useRef(data);
  const previousStepRef = useRef(initialData.onboarding.currentStep);
  const onboarding = data.onboarding;
  latestDataRef.current = data;
  const updateData = useCallback((update: OnboardingDataUpdate) => {
    setData((currentData) => {
      const nextData = typeof update === "function" ? update(currentData) : update;
      latestDataRef.current = nextData;
      return nextData;
    });
  }, []);
  const activeStep = ONBOARDING_STEPS.find((step) => step.id === onboarding.currentStep)!;
  const stepHealthFlags = useMemo(
    () => deriveOnboardingStepHealthFlags(data.setupHealth, onboarding),
    [data.setupHealth, onboarding],
  );
  const railItems = useMemo(
    () =>
      getOnboardingStepRailItems(onboarding, {
        blockedSteps: stepHealthFlags.blockedSteps,
        errorSteps: stepHealthFlags.errorSteps,
      }),
    [onboarding, stepHealthFlags],
  );
  const canGoBack = onboardingStepIndex(onboarding.currentStep) > 0;
  const isCompleted = onboarding.status === "completed";
  const isSaving = savingAction !== null;
  const activeStepAlreadyResolved =
    onboarding.completedSteps.includes(activeStep.id) ||
    onboarding.skippedSteps.includes(activeStep.id);
  const pipelineEditorUnavailable = activeStep.id === "pipeline" && !data.pipeline;
  const linearRoutingUnavailable =
    activeStep.id === "linear" && (!data.pipeline || data.pipeline.stages.length === 0);
  const inlineCompletionUnavailable = pipelineEditorUnavailable || linearRoutingUnavailable;
  const requiresInlineCompletion =
    (activeStep.id === "pipeline" || activeStep.id === "linear") &&
    !inlineCompletionUnavailable &&
    !activeStepAlreadyResolved;
  const inlineCompletionLabel =
    activeStep.id === "linear" ? "Finish Linear setup to continue" : "Save pipeline to continue";
  const githubContinueBlocked = activeStep.id === "github" && !canCompleteGitHubSetupStep(data);
  const repositoryContinueBlocked =
    activeStep.id === "repository" && !canCompleteRepositoryStep(data);
  const runtimeCompletionBlocked =
    activeStep.id === "runtime" &&
    !activeStepAlreadyResolved &&
    (!runtimeCompletionState.readiness.canComplete ||
      runtimeCompletionState.hasInvalidDrafts ||
      runtimeCompletionState.hasUnsavedDrafts ||
      !data.setupHealth.vercelSandboxConnection.connected);
  const verifyChecklist = buildVerifyChecklist({
    agentConfig: data.agentConfig,
    health: data.setupHealth,
    onboarding: data.onboarding,
  });
  const verifyBlockers = verifyBlockersFromChecklist(verifyChecklist);
  const verifyCompletionBlocked = activeStep.id === "verify" && verifyBlockers.length > 0;
  const skipAllowed = canSkipOnboardingStep(onboarding.currentStep);
  const primaryAction = buildOnboardingPrimaryAction({
    activeStepAlreadyResolved,
    activeStepId: activeStep.id,
    githubContinueBlocked,
    hasInvalidRuntimeDrafts: runtimeCompletionState.hasInvalidDrafts,
    hasUnsavedRuntimeDrafts: runtimeCompletionState.hasUnsavedDrafts,
    inlineCompletionLabel,
    isCompleted,
    repositoryContinueBlocked,
    requiresInlineCompletion,
    runtimeCompletionBlocked,
    runtimeReadiness: runtimeCompletionState.readiness,
    vercelConnected: data.setupHealth.vercelSandboxConnection.connected,
    verifyCompletionBlocked,
    verifyFirstBlockerLabel: verifyBlockers[0]?.label ?? null,
    verifyFirstBlockerStep: verifyBlockers[0]?.step ?? null,
  });
  const resumeAttemptedRef = useRef(false);

  useEffect(() => {
    if (previousStepRef.current === onboarding.currentStep) return;
    previousStepRef.current = onboarding.currentStep;
    scrollOnboardingSetupToTop();
  }, [onboarding.currentStep]);

  async function persistOnboarding(
    changes: WorkspaceOnboardingUpdatePayload,
    mutation: PersistOnboardingAction,
  ) {
    if (!data.canManage || saveInFlightRef.current) return null;

    saveInFlightRef.current = true;
    setSavingAction(mutation.savingAction);
    setError(null);

    try {
      const response = await fetch(`/api/workspaces/${data.workspace.id}/onboarding`, {
        body: JSON.stringify({
          action: mutation.action,
          changes,
          expectedUpdatedAt: latestDataRef.current.onboarding.updatedAt,
          step: mutation.step,
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });

      const body = (await response.json().catch(() => null)) as
        | WorkspaceOnboardingConflictResponse
        | WorkspaceOnboardingMutationDelta
        | WorkspaceOnboardingMutationErrorResponse
        | null;

      if (body?.kind === "onboarding-conflict") {
        const nextData = reduceOnboardingMutationData(latestDataRef.current, body);
        latestDataRef.current = nextData;
        setData(nextData);
        throw new Error(body.error);
      }

      if (!response.ok || body?.kind !== "onboarding-mutation") {
        const message = body && "error" in body ? body.error : "Failed to save onboarding state.";
        throw new Error(message);
      }

      const nextData = reduceOnboardingMutationData(latestDataRef.current, body);
      latestDataRef.current = nextData;
      setData(nextData);
      if (
        mutation.action === "continue" ||
        mutation.action === "skip" ||
        mutation.action === "step-complete"
      ) {
        pushToast({
          description:
            mutation.action === "skip"
              ? "Step skipped for now. You can revisit it anytime."
              : "Progress saved.",
          title: mutation.action === "skip" ? "Skipped for now" : "Setup updated",
          tone: "success",
        });
      }
      return nextData;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Failed to save onboarding state.";
      setError(message);
      pushToast({
        description: message,
        priority: "assertive",
        title: "Setup could not be saved.",
        tone: "danger",
      });
      return null;
    } finally {
      saveInFlightRef.current = false;
      setSavingAction(null);
    }
  }

  async function refreshOnboarding(action: string) {
    if (!data.canManage) return null;

    setSavingAction(action);
    setError(null);

    try {
      const response = await fetch(`/api/workspaces/${data.workspace.id}/onboarding`, {
        method: "GET",
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Failed to refresh onboarding state.");
      }

      const nextData = (await response.json()) as WorkspaceOnboardingData;
      latestDataRef.current = nextData;
      setData(nextData);
      return nextData;
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Failed to refresh onboarding state.";
      setError(message);
      pushToast({
        description: message,
        priority: "assertive",
        title: "Setup could not be refreshed.",
        tone: "danger",
      });
      return null;
    } finally {
      setSavingAction(null);
    }
  }

  async function completeCurrentStep(action: string) {
    const patch = buildOnboardingStepCompletionPatch(latestDataRef.current.onboarding);
    if (!patch) return;

    const nextData = await persistOnboarding(patch, {
      action: "step-complete",
      savingAction: action,
      step: latestDataRef.current.onboarding.currentStep,
    });
    if (!nextData) {
      throw new Error("Failed to save onboarding state.");
    }
  }

  async function completePipelineStep(
    action: string,
    pipeline: NonNullable<WorkspaceOnboardingData["pipeline"]>,
  ) {
    const nextData = applySavedPipelineToData(latestDataRef.current, pipeline);
    latestDataRef.current = nextData;
    setData(nextData);
    await completeCurrentStep(action);
  }

  async function continueSetup() {
    if (activeStep.id === "verify") {
      await completeOnboarding();
      return;
    }

    if (inlineCompletionUnavailable) {
      const patch = buildOnboardingAdvancePatch(onboarding);
      if (!patch) return;
      await persistOnboarding(patch, {
        action: "continue",
        savingAction: "continue",
        step: onboarding.currentStep,
      });
      return;
    }

    await persistOnboarding(buildOnboardingContinuePatch(onboarding), {
      action: "continue",
      savingAction: "continue",
      step: onboarding.currentStep,
    });
  }

  async function completeOnboarding() {
    if (!data.canManage || saveInFlightRef.current || verifyCompletionBlocked) return;

    saveInFlightRef.current = true;
    setSavingAction("complete");
    setError(null);

    try {
      const response = await fetch(`/api/workspaces/${data.workspace.id}/onboarding/complete`, {
        body: JSON.stringify({ expectedUpdatedAt: latestDataRef.current.onboarding.updatedAt }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = (await response.json().catch(() => null)) as
        | (WorkspaceOnboardingMutationErrorResponse & {
            blockers?: ReturnType<typeof verifyBlockersFromChecklist>;
          })
        | WorkspaceOnboardingConflictResponse
        | WorkspaceOnboardingMutationDelta
        | null;

      if (body?.kind === "onboarding-conflict") {
        const nextData = reduceOnboardingMutationData(latestDataRef.current, body);
        latestDataRef.current = nextData;
        setData(nextData);
        throw new Error(body.error);
      }

      if (!response.ok || body?.kind !== "onboarding-mutation") {
        const blockerText =
          body && "blockers" in body && body.blockers?.length
            ? ` Blocked: ${body.blockers.map((blocker) => blocker.label).join(", ")}.`
            : "";
        const message = body && "error" in body ? body.error : "Failed to complete onboarding.";
        throw new Error(message + blockerText);
      }

      const nextData = reduceOnboardingMutationData(latestDataRef.current, body);
      latestDataRef.current = nextData;
      setData(nextData);
      const destination = workspaceBasePath(data.workspace.slug);
      startNavigation(destination);
      router.push(destination);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Failed to complete onboarding.";
      setError(message);
      pushToast({
        description: message,
        priority: "assertive",
        title: "Setup could not be completed.",
        tone: "danger",
      });
    } finally {
      saveInFlightRef.current = false;
      setSavingAction(null);
    }
  }

  async function skipStep() {
    const patch = buildOnboardingSkipPatch(onboarding);
    if (!patch) return;
    await persistOnboarding(patch, {
      action: "skip",
      savingAction: "skip",
      step: onboarding.currentStep,
    });
  }

  async function goBack() {
    const previousStep = ONBOARDING_STEPS[onboardingStepIndex(onboarding.currentStep) - 1]?.id;
    if (!previousStep) return;
    const patch = buildOnboardingRailNavigationPatch(onboarding, previousStep);
    if (!patch) return;
    await persistOnboarding(patch, {
      action: "navigate",
      savingAction: "back",
      step: previousStep,
    });
  }

  async function selectStep(step: WorkspaceOnboardingStep) {
    const currentData = latestDataRef.current;
    const patch = buildOnboardingRailNavigationPatch(currentData.onboarding, step);
    const nextData = selectOnboardingStepInData(currentData, step);
    if (nextData !== currentData) {
      latestDataRef.current = nextData;
      setData(nextData);
    }
    if (!data.canManage || !patch) return;
    await persistOnboarding(patch, {
      action: "navigate",
      savingAction: `rail:${step}`,
      step,
    });
  }

  useEffect(() => {
    if (resumeAttemptedRef.current || !data.canManage || isCompleted) return;
    const resumeStep = shouldResumeToFirstIncompleteRequired(latestDataRef.current.onboarding);
    resumeAttemptedRef.current = true;
    if (!resumeStep) return;
    void selectStep(resumeStep);
    // Snap returning users once; later rail navigation must not re-trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.canManage, isCompleted]);

  function resolvePrimaryActionBlocker() {
    if (primaryAction.focusTargetId === null) return;
    if (activeStep.id === "verify" && verifyBlockers[0] && verifyBlockers[0].step !== "verify") {
      void selectStep(verifyBlockers[0].step);
      return;
    }
    focusOnboardingTarget(primaryAction.focusTargetId);
  }

  async function exitSetup() {
    const patch = data.canManage ? buildOnboardingExitPatch(onboarding) : null;
    const nextData = patch
      ? await persistOnboarding(patch, {
          action: "exit",
          savingAction: "exit",
          step: onboarding.currentStep,
        })
      : data;
    if (nextData) {
      const destination = workspaceBasePath(data.workspace.slug);
      startNavigation(destination);
      router.push(destination);
    }
  }

  async function selectGithubRepository(repository: WorkspaceGitHubRepository): Promise<boolean> {
    const patch = buildOnboardingRepositorySelectionPatch(
      latestDataRef.current.onboarding,
      repository.id,
      selectedRepositoryFromData(latestDataRef.current)?.id ?? null,
    );
    if (!patch) return true;

    return Boolean(
      await persistOnboarding(patch, {
        action: "repository-selection",
        savingAction: "repository-selection",
        step: "repository",
      }),
    );
  }

  function updateRepositoryOnboarding(repositoryId: string, onboarding: RepositoryOnboardingState) {
    updateData((currentData) => {
      const nextGithub = {
        ...currentData.github,
        repositories: mergeRepositoryOnboardingState(
          currentData.github.repositories,
          repositoryId,
          onboarding,
        ),
      };

      return {
        ...currentData,
        github: nextGithub,
        setupHealth: applyGithubHealth(
          currentData.setupHealth,
          nextGithub,
          currentData.onboarding.selectedGithubRepositoryId,
        ),
      };
    });
  }

  function handleRepositorySetupMessage(message: FlashMessage) {
    setError(message.kind === "error" ? message.text : null);
  }

  return (
    <div className="flex min-h-[100svh] flex-col overflow-x-hidden bg-sheet text-foreground">
      <header className="mx-auto flex w-full max-w-[1180px] flex-wrap items-start justify-between gap-x-6 gap-y-3 px-4 pb-6 pt-8 sm:px-8 sm:pt-10">
        <div className="min-w-0 space-y-3">
          <div className="space-y-2">
            <h1 className="type-page-title">Set up {data.workspace.name}</h1>
            <p className="max-w-2xl text-[14px] leading-6 text-muted">
              Finish the required connections before starting sessions.
            </p>
          </div>
          <OnboardingProgressHeader className="hidden max-w-xl lg:block" onboarding={onboarding} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!data.canManage ? <Status label="Read only" value="not_started" /> : null}
          <button
            type="button"
            className="ui-button"
            disabled={isSaving}
            onClick={() => void exitSetup()}
          >
            <ActionButtonLabel
              idle="Exit setup"
              pending={savingAction === "exit"}
              pendingLabel="Exiting…"
            />
          </button>
        </div>
      </header>

      <OnboardingMobileStepNav
        canSelect={!isSaving}
        items={railItems}
        onboarding={onboarding}
        onSelect={selectStep}
      />

      <main
        id="main-content"
        className="mx-auto grid w-full max-w-[1180px] flex-1 grid-cols-1 gap-10 px-4 pb-28 sm:px-8 lg:grid-cols-[200px_minmax(0,1fr)_260px] lg:gap-12"
      >
        <aside aria-label="Setup steps" className="hidden lg:block">
          <div className="sticky top-8">
            <OnboardingStepRail
              canSelect={!isSaving}
              currentStep={onboarding.currentStep}
              items={railItems}
              onSelect={selectStep}
            />
          </div>
        </aside>

        <section className="min-w-0">
          <div className="settings-section-header mb-6">
            <div className="min-w-0">
              <h2 className="type-section-title">{activeStep.title}</h2>
              <p className="mt-1 max-w-2xl text-[13px] leading-5 text-muted">
                {activeStep.description}
              </p>
            </div>
          </div>

          {error ? (
            <div
              className="mt-5 rounded-[6px] border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] text-danger"
              role="alert"
            >
              <p>{error}</p>
              <p className="mt-1 type-annotation text-danger/90">
                Refresh setup status, then repeat the action that failed.
              </p>
              <button
                type="button"
                className="ui-button mt-2"
                onClick={() => {
                  setError(null);
                  if (savingAction === null) {
                    void refreshOnboarding("refresh");
                  }
                }}
              >
                Refresh status
              </button>
            </div>
          ) : null}

          <div className="mt-6">
            <ActiveOnboardingStep
              items={railItems}
              data={data}
              isSaving={isSaving}
              onCompleteStep={completeCurrentStep}
              onPipelineCompleted={completePipelineStep}
              onDataChange={updateData}
              onRefresh={async (action) => {
                const nextData = await refreshOnboarding(action);
                if (!nextData) {
                  throw new Error("Failed to refresh onboarding state.");
                }
              }}
              onRepositoryOnboardingChange={updateRepositoryOnboarding}
              onRepositorySetupMessage={handleRepositorySetupMessage}
              onRuntimeStateChange={setRuntimeCompletionState}
              onSelectStep={(step) => void selectStep(step)}
              onSelectGithubRepository={selectGithubRepository}
              step={activeStep.id}
            />
          </div>
        </section>

        <SetupHealthSummary health={data.setupHealth} initialNow={renderNow} />
      </main>

      <footer className="sticky bottom-0 z-20 border-t border-border bg-sheet/95 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-[1180px] flex-col gap-2 sm:flex-row sm:items-center sm:justify-end sm:gap-3">
          {primaryAction.disabled && primaryAction.reason ? (
            <p
              className="min-w-0 text-xs leading-5 text-muted sm:mr-auto"
              data-onboarding-disabled-reason
              id="onboarding-primary-disabled-reason"
            >
              {primaryAction.reason}{" "}
              {primaryAction.reasonActionLabel ? (
                <button
                  type="button"
                  className="font-medium text-accent underline-offset-2 hover:underline"
                  onClick={resolvePrimaryActionBlocker}
                >
                  {primaryAction.reasonActionLabel}
                </button>
              ) : null}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              className="ui-button"
              disabled={!data.canManage || !canGoBack || isSaving}
              onClick={() => void goBack()}
            >
              <ActionButtonLabel
                idle="Back"
                pending={savingAction === "back"}
                pendingLabel="Saving…"
              />
            </button>
            {skipAllowed && !isCompleted ? (
              <button
                type="button"
                className="ui-button"
                disabled={!data.canManage || isSaving}
                onClick={() => void skipStep()}
              >
                <ActionButtonLabel
                  idle="Skip for now"
                  pending={savingAction === "skip"}
                  pendingLabel="Saving…"
                />
              </button>
            ) : null}
            <button
              type="button"
              className="ui-button-primary"
              aria-describedby={
                primaryAction.disabled && primaryAction.reason
                  ? "onboarding-primary-disabled-reason"
                  : undefined
              }
              disabled={!data.canManage || isSaving || primaryAction.disabled}
              onClick={() => void continueSetup()}
            >
              <ActionButtonLabel
                idle={primaryAction.idleLabel}
                pending={savingAction === "continue" || savingAction === "complete"}
                pendingLabel="Saving…"
              />
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
