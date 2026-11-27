"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import { useOptionalRouteProgress } from "@/components/ui/route-progress";
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
  ONBOARDING_GROUPS,
  type OnboardingStepDisplayState,
} from "@/features/onboarding/flow";
import { reduceOnboardingMutationData } from "@/features/onboarding/mutation-reducer";
import { buildRepositorySetupHealth } from "@/features/onboarding/repository-health";
import {
  buildRuntimeReadiness,
  verifyBlockersFromChecklist,
  type RuntimeReadiness,
} from "@/features/onboarding/runtime-readiness";
import { ActiveOnboardingStep } from "@/features/onboarding/steps/active-step";
import type { OnboardingStepDraftState } from "@/features/onboarding/steps/types";
import { SetupCheck } from "@/features/onboarding/setup-check";
import {
  executionStepBlocker,
  getSetupVerificationChecklist,
  getVerificationRecovery,
  hasActiveGithubRepositories,
  repositoryStepBlocker,
} from "@/features/onboarding/verification-presentation";
import {
  mergeRepositoryOnboardingState,
  repositorySetupCanAdvance,
} from "@/features/repositories/repository-setup-controls";
import type { FlashMessage } from "@/features/settings/settings-types";
import type {
  OnboardingSetupHealth,
  WorkspaceOnboardingConflictResponse,
  WorkspaceOnboardingMutationAction,
  WorkspaceOnboardingMutationDelta,
  WorkspaceOnboardingMutationErrorResponse,
  WorkspaceOnboardingStep,
  WorkspaceOnboardingUpdatePayload,
} from "@/lib/onboarding/contracts";
import type { RepositoryOnboardingState } from "@/lib/repo-onboarding/contracts";
import type { RepositoryProfileState } from "@/lib/repo-inference/contracts";
import type { SandboxCapabilityCheckState } from "@/lib/sandbox-capabilities/contracts";
import { workspaceBasePath, workspaceSessionsPath, workspaceSettingsPath } from "@/lib/routes";
import { cn } from "@/lib/utils";

type OnboardingPageClientProps = {
  initialData: WorkspaceOnboardingData;
  initialNow?: string;
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

const railStateClasses: Record<OnboardingStepDisplayState, string> = {
  available: "text-muted hover:bg-control-hover hover:text-foreground",
  blocked: "text-muted opacity-55",
  completed: "text-muted hover:bg-control-hover hover:text-foreground",
  skipped: "text-muted hover:bg-control-hover hover:text-foreground",
};

function StepNavigation({
  canSelect,
  isCompleted,
  items,
  onSelect,
}: {
  canSelect: boolean;
  isCompleted: boolean;
  items: ReturnType<typeof getOnboardingStepRailItems>;
  onSelect: (step: WorkspaceOnboardingStep, returnFocus: HTMLElement) => void;
}) {
  return (
    <nav aria-label="Setup steps">
      <ul className="space-y-4">
        {ONBOARDING_GROUPS.map((group) => (
          <li key={group.title}>
            <p className="mb-1 px-3 text-[13px] font-semibold text-foreground">{group.title}</p>
            <ul className="grid grid-cols-2 gap-1 lg:grid-cols-1">
              {items
                .filter((step) => group.steps.includes(step.id))
                .map((step) => (
                  <li className="min-w-0" key={step.id}>
                    <button
                      type="button"
                      aria-current={step.isActive ? "step" : undefined}
                      className={cn(
                        "flex min-h-11 w-full min-w-0 items-center justify-between gap-2 rounded-[6px] px-3 py-2 text-left text-[13px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 disabled:cursor-not-allowed",
                        step.isActive
                          ? "bg-accent-soft text-accent"
                          : railStateClasses[step.displayState],
                      )}
                      disabled={!canSelect || !step.isNavigable}
                      onClick={(event) => onSelect(step.id, event.currentTarget)}
                    >
                      <span className="min-w-0">
                        {step.shortTitle}
                        {step.id === "linear" ? (
                          <span className="text-xs font-normal text-muted"> (optional)</span>
                        ) : null}
                      </span>
                      {step.displayState === "completed" && !isCompleted ? (
                        <SetupCheck />
                      ) : step.displayState === "skipped" ? (
                        <span className="type-annotation shrink-0">Skipped</span>
                      ) : null}
                    </button>
                  </li>
                ))}
            </ul>
          </li>
        ))}
      </ul>
    </nav>
  );
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
    cursorConnection: data.setupHealth.cursorConnection,
    openCodeConnection: data.setupHealth.openCodeConnection,
    primaryRepositoryId: data.setupHealth.primaryRepositoryProfile.repositoryId,
    repositorySetup: data.setupHealth.repositorySetup,
  });
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
  return data.setupHealth.githubInstallation.connected && hasActiveGithubRepositories(data.github);
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
  const [stepDraft, setStepDraft] = useState<
    (OnboardingStepDraftState & { step: WorkspaceOnboardingStep }) | null
  >(null);
  const [leaveAction, setLeaveAction] = useState<(() => void) | null>(null);
  const [isStartingVerification, setIsStartingVerification] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mobileStepsRef = useRef<HTMLDetailsElement>(null);
  const leaveFocusRef = useRef<HTMLElement | null>(null);
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
  const railItems = useMemo(() => getOnboardingStepRailItems(onboarding), [onboarding]);
  const canGoBack = onboardingStepIndex(onboarding.currentStep) > 0;
  const isCompleted = onboarding.status === "completed";
  const hasCompletedBefore = isCompleted || onboarding.completedAt !== null;
  const isSaving = savingAction !== null || isStartingVerification;
  const dirtyStep = data.canManage && stepDraft?.step === activeStep.id && stepDraft.dirty;
  const savingStep = stepDraft?.step === activeStep.id && stepDraft.pending;
  const navigationDisabled = isSaving || savingStep;
  const onStepDraftStateChange = useCallback(
    (draft: OnboardingStepDraftState) => setStepDraft({ ...draft, step: onboarding.currentStep }),
    [onboarding.currentStep],
  );
  const isVerifyingStep = activeStep.id === "verify";
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
  const githubContinueBlocked = activeStep.id === "github" && !canCompleteGitHubSetupStep(data);
  const repositoryContinueBlocked =
    activeStep.id === "repository" && !canCompleteRepositoryStep(data);
  const sandboxContinueBlocked =
    activeStep.id === "sandbox" &&
    !activeStepAlreadyResolved &&
    !(
      data.setupHealth.sandboxConnection?.connected ??
      data.setupHealth.vercelSandboxConnection.connected
    );
  const runtimeCompletionBlocked =
    activeStep.id === "runtime" &&
    !activeStepAlreadyResolved &&
    (!runtimeCompletionState.readiness.canComplete ||
      runtimeCompletionState.hasInvalidDrafts ||
      runtimeCompletionState.hasUnsavedDrafts ||
      !(
        data.setupHealth.sandboxConnection?.connected ??
        data.setupHealth.vercelSandboxConnection.connected
      ));
  const verifyChecklist = getSetupVerificationChecklist(data);
  const firstBlocker = verifyChecklist.find((item) => !item.passed);
  const verifyCompletionBlocked = Boolean(firstBlocker);
  const verificationRunning = data.setupHealth.latestSandboxCapabilityCheck?.status === "running";
  const prerequisite = getVerificationRecovery(data, firstBlocker);
  const sessionsDestination = workspaceSessionsPath(data.workspace.slug);
  const afterCompletionDestination = hasCompletedBefore
    ? sessionsDestination
    : `${workspaceBasePath(data.workspace.slug)}?create=1`;
  const stepGroup = ONBOARDING_GROUPS.find((group) => group.steps.includes(activeStep.id))!;
  const stepBlocker =
    activeStep.id === "repository"
      ? repositoryStepBlocker(data)
      : activeStep.id === "sandbox" || activeStep.id === "runtime"
        ? executionStepBlocker(activeStep.id, runtimeCompletionState, verifyChecklist)
        : null;
  const skipAllowed = canSkipOnboardingStep(onboarding.currentStep);

  useEffect(() => {
    if (previousStepRef.current === onboarding.currentStep) return;
    previousStepRef.current = onboarding.currentStep;
    if (mobileStepsRef.current) mobileStepsRef.current.open = false;
    scrollOnboardingSetupToTop();
    headingRef.current?.focus({ preventScroll: true });
  }, [onboarding.currentStep]);

  useEffect(() => {
    if (!dirtyStep && !savingStep) return;
    function beforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirtyStep, savingStep]);

  function requestLeave(action: () => void, returnFocus?: HTMLElement) {
    if (navigationDisabled || saveInFlightRef.current || leaveAction) return;
    if (dirtyStep) {
      const focused = document.activeElement;
      leaveFocusRef.current =
        returnFocus ??
        (focused instanceof HTMLElement && focused !== document.body
          ? focused
          : headingRef.current);
      setLeaveAction(() => action);
    } else {
      action();
    }
  }

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
      startNavigation(afterCompletionDestination);
      router.replace(afterCompletionDestination);
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

  function requestStep(step: WorkspaceOnboardingStep, returnFocus?: HTMLElement) {
    if (step !== onboarding.currentStep) requestLeave(() => void selectStep(step), returnFocus);
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
      const destination = hasCompletedBefore
        ? sessionsDestination
        : workspaceBasePath(data.workspace.slug);
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

  function guardLink(event: { preventDefault: () => void }, destination: string) {
    if (navigationDisabled || saveInFlightRef.current || leaveAction) {
      event.preventDefault();
    } else if (dirtyStep) {
      event.preventDefault();
      requestLeave(() => {
        startNavigation(destination);
        router.push(destination);
      });
    } else {
      startNavigation(destination);
    }
  }

  const sessionsLink = isCompleted ? (
    <Link
      aria-disabled={navigationDisabled || undefined}
      className={cn(
        "min-h-11 aria-disabled:cursor-wait aria-disabled:opacity-60",
        isVerifyingStep && !firstBlocker ? "ui-button-primary" : "ui-button",
      )}
      href={sessionsDestination}
      onNavigate={(event) => guardLink(event, sessionsDestination)}
    >
      Back to sessions
    </Link>
  ) : null;
  const verificationActions =
    isVerifyingStep && (data.canManage || isCompleted) ? (
      <div className="flex flex-wrap items-center gap-2">
        {data.canManage ? (
          prerequisite ? (
            <button
              className="ui-button-primary min-h-11"
              data-step-link={prerequisite.step}
              disabled={navigationDisabled}
              onClick={() => requestStep(prerequisite.step)}
              type="button"
            >
              {prerequisite.action}
            </button>
          ) : firstBlocker ? (
            <button
              className="ui-button-primary min-h-11"
              disabled={navigationDisabled || verificationRunning}
              form="onboarding-verification"
              type="submit"
            >
              <ActionButtonLabel
                idle={
                  verificationRunning
                    ? "Checking…"
                    : firstBlocker.statusLabel === "Failed"
                      ? "Retry verification"
                      : data.setupHealth.latestSandboxCapabilityCheck
                        ? "Verify again"
                        : "Verify setup"
                }
                pending={isStartingVerification}
                pendingLabel="Starting…"
              />
            </button>
          ) : !isCompleted ? (
            <button
              className="ui-button-primary min-h-11"
              disabled={navigationDisabled}
              onClick={() => void completeOnboarding()}
              type="button"
            >
              <ActionButtonLabel
                idle={hasCompletedBefore ? "Finish setup" : "Create your first task"}
                pending={savingAction === "complete"}
                pendingLabel="Saving…"
              />
            </button>
          ) : null
        ) : null}
        {sessionsLink}
      </div>
    ) : null;
  const stepNavigation = (
    <StepNavigation
      canSelect={!navigationDisabled}
      isCompleted={isCompleted}
      items={railItems}
      onSelect={requestStep}
    />
  );
  const linearSettingsDestination = `${workspaceSettingsPath(data.workspace.slug, {
    category: "integrations",
  })}#linear`;

  return (
    <div className="min-h-[100svh] bg-sheet text-foreground">
      <div className="mx-auto w-full max-w-[1080px] pb-[max(2rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-5 sm:px-8 sm:pt-9">
        <header className="mb-5 sm:mb-8">
          <h1 className="type-page-title [overflow-wrap:anywhere]">Set up {data.workspace.name}</h1>
        </header>

        <main
          id="main-content"
          className="grid min-w-0 grid-cols-1 gap-8 lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-12"
        >
          <aside className="sticky top-8 hidden h-fit min-w-0 lg:block">{stepNavigation}</aside>
          <div className="min-w-0">
            <section aria-labelledby="onboarding-step-title" className="space-y-4">
              <div>
                <p className="type-label mb-1 text-muted" id="onboarding-step-position">
                  {stepGroup.title} · Step {onboardingStepIndex(activeStep.id) + 1} of{" "}
                  {ONBOARDING_STEPS.length}
                </p>
                <h2
                  aria-describedby="onboarding-step-position"
                  className="type-section-title scroll-mt-4 [text-wrap:balance]"
                  id="onboarding-step-title"
                  ref={headingRef}
                  tabIndex={-1}
                >
                  {activeStep.title}
                </h2>
                {activeStep.description ? (
                  <p className="mt-1 max-w-2xl text-[13px] leading-5 text-muted">
                    {activeStep.description}
                  </p>
                ) : null}
              </div>

              {error ? (
                <div
                  className="rounded-[6px] border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] text-danger"
                  role="alert"
                >
                  {error}
                </div>
              ) : null}

              {!isVerifyingStep && !data.canManage && activeStep.id !== "github" ? (
                <p className="text-[13px] leading-5 text-muted">
                  Workspace settings are read only. Ask a workspace owner or admin to make changes.
                </p>
              ) : null}
              {stepBlocker ? (
                <p className="border-l-2 border-warning pl-3 text-[13px] leading-5 text-foreground [overflow-wrap:anywhere]">
                  {stepBlocker}
                </p>
              ) : null}
              {skipAllowed && !isCompleted && data.canManage ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <button
                    type="button"
                    className="ui-button min-h-11"
                    disabled={navigationDisabled}
                    onClick={() => requestLeave(() => void skipStep())}
                  >
                    <ActionButtonLabel
                      idle={activeStep.id === "linear" ? "Skip Linear" : "Skip agent settings"}
                      pending={savingAction === "skip"}
                      pendingLabel="Saving…"
                    />
                  </button>
                  {activeStep.id === "linear" ? (
                    <span className="text-[13px] text-muted">
                      Connect later in{" "}
                      <Link
                        href={linearSettingsDestination}
                        onNavigate={(event) => guardLink(event, linearSettingsDestination)}
                        className="rounded-sm text-accent underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                      >
                        Settings → Linear
                      </Link>
                      .
                    </span>
                  ) : null}
                </div>
              ) : null}

              <ActiveOnboardingStep
                items={railItems}
                data={data}
                initialNow={renderNow}
                isSaving={isSaving}
                onCompleteStep={completeCurrentStep}
                onKeepPipeline={() => requestLeave(() => void continueSetup())}
                onPipelineCompleted={completePipelineStep}
                onDataChange={updateData}
                onDraftStateChange={onStepDraftStateChange}
                onRefresh={async (action) => {
                  await refreshOnboarding(action);
                }}
                onRepositoryOnboardingChange={updateRepositoryOnboarding}
                onRepositorySetupMessage={handleRepositorySetupMessage}
                onRuntimeStateChange={setRuntimeCompletionState}
                onVerificationPendingChange={setIsStartingVerification}
                onSelectStep={requestStep}
                onSelectGithubRepository={selectGithubRepository}
                step={activeStep.id}
                verificationActions={verificationActions}
              />

              {!isVerifyingStep &&
              !isCompleted &&
              data.canManage &&
              !requiresInlineCompletion &&
              !githubContinueBlocked ? (
                <button
                  className="ui-button-primary min-h-11"
                  disabled={
                    navigationDisabled ||
                    repositoryContinueBlocked ||
                    sandboxContinueBlocked ||
                    runtimeCompletionBlocked
                  }
                  onClick={() => requestLeave(() => void continueSetup())}
                  type="button"
                >
                  <ActionButtonLabel
                    idle="Continue"
                    pending={savingAction === "continue"}
                    pendingLabel="Saving…"
                  />
                </button>
              ) : null}
            </section>

            <details className="group mt-6 border-t border-border lg:hidden" ref={mobileStepsRef}>
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-sm text-[13px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [&::-webkit-details-marker]:hidden">
                <span className="text-muted group-open:rotate-90" aria-hidden="true">
                  ›
                </span>
                All setup steps
              </summary>
              <div className="pb-4">{stepNavigation}</div>
            </details>

            {!isCompleted || !isVerifyingStep ? (
              <footer className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-3 lg:mt-8">
                {data.canManage && canGoBack && !isCompleted ? (
                  <button
                    type="button"
                    className="ui-button min-h-11"
                    disabled={navigationDisabled}
                    onClick={() => requestLeave(() => void goBack())}
                  >
                    <ActionButtonLabel
                      idle="Back"
                      pending={savingAction === "back"}
                      pendingLabel="Saving…"
                    />
                  </button>
                ) : null}
                {isCompleted ? (
                  <>
                    <button
                      className="ui-button min-h-11"
                      disabled={navigationDisabled}
                      onClick={() => requestStep("verify")}
                      type="button"
                    >
                      Review readiness
                    </button>
                    {sessionsLink}
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="ui-button min-h-11"
                      aria-describedby={data.canManage ? "onboarding-exit-hint" : undefined}
                      disabled={navigationDisabled}
                      onClick={() => requestLeave(() => void exitSetup())}
                    >
                      <ActionButtonLabel
                        idle={hasCompletedBefore ? "Back to sessions" : "Exit setup"}
                        pending={savingAction === "exit"}
                        pendingLabel="Exiting…"
                      />
                    </button>
                    {data.canManage ? (
                      <p className="text-xs leading-4 text-muted" id="onboarding-exit-hint">
                        You can resume saved progress later.
                      </p>
                    ) : null}
                  </>
                )}
              </footer>
            ) : null}
          </div>
        </main>
      </div>
      <DestructiveConfirmationDialog
        actionLabel="Discard changes"
        cancelLabel="Keep editing"
        description="Your unsaved changes on this step will be lost. Saved setup progress will be kept."
        onConfirm={() => {
          leaveFocusRef.current = null;
          setLeaveAction(null);
          leaveAction?.();
        }}
        onOpenChange={(open) => {
          if (!open) setLeaveAction(null);
        }}
        open={leaveAction !== null}
        pending={false}
        pendingLabel="Discarding…"
        restoreFocusRef={leaveFocusRef}
        title="Discard unsaved changes?"
      />
    </div>
  );
}
