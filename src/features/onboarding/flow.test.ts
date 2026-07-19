import { describe, expect, it } from "vitest";

import {
  ONBOARDING_STEPS,
  buildOnboardingAdvancePatch,
  buildOnboardingContinuePatch,
  buildOnboardingExitPatch,
  buildOnboardingRailNavigationPatch,
  buildOnboardingRepositorySelectionPatch,
  buildOnboardingSkipPatch,
  buildOnboardingStepCompletionPatch,
  getOnboardingStepRailItems,
  mapOnboardingResumeState,
  shouldShowOnboardingResumeCta,
} from "@/features/onboarding/flow";
import type { WorkspaceOnboardingState } from "@/lib/onboarding/contracts";

function onboardingState(
  overrides: Partial<WorkspaceOnboardingState> = {},
): WorkspaceOnboardingState {
  return {
    completedAt: null,
    completedSteps: [],
    createdAt: "2026-05-16T18:00:00.000Z",
    currentStep: "github",
    dismissedAt: null,
    id: "onboarding-1",
    selectedGithubRepositoryId: null,
    skippedSteps: [],
    status: "not_started",
    updatedAt: "2026-05-16T18:00:00.000Z",
    workspaceId: "workspace-1",
    ...overrides,
  };
}

describe("onboarding flow helpers", () => {
  it("uses Connect terminology for Linear and agent provider setup labels", () => {
    expect(
      ONBOARDING_STEPS.filter((step) => step.id === "linear" || step.id === "runtime").map(
        ({ id, shortTitle, title }) => [id, title, shortTitle],
      ),
    ).toEqual([
      ["linear", "Connect Linear", "Linear"],
      ["runtime", "Connect Agent", "Agent"],
    ]);
  });

  it("maps completed, skipped, current, and upcoming rail states from server state", () => {
    const items = getOnboardingStepRailItems(
      onboardingState({
        completedSteps: ["github"],
        currentStep: "pipeline",
        skippedSteps: ["repository"],
        status: "in_progress",
      }),
    );

    expect(items.map((item) => [item.id, item.displayState])).toEqual([
      ["github", "completed"],
      ["repository", "skipped"],
      ["pipeline", "current"],
      ["linear", "upcoming"],
      ["runtime", "upcoming"],
      ["verify", "upcoming"],
    ]);
  });

  it("maps blocked and error rail states from health context without collapsing skipped", () => {
    const items = getOnboardingStepRailItems(
      onboardingState({
        completedSteps: ["github"],
        currentStep: "pipeline",
        skippedSteps: ["linear"],
        status: "in_progress",
      }),
      {
        blockedSteps: new Set(["verify"]),
        errorSteps: new Set(["runtime"]),
      },
    );

    expect(items.map((item) => [item.id, item.displayState])).toEqual([
      ["github", "completed"],
      ["repository", "upcoming"],
      ["pipeline", "current"],
      ["linear", "skipped"],
      ["runtime", "error"],
      ["verify", "blocked"],
    ]);
  });

  it("keeps the active step as error while preserving current-step identity for consumers", () => {
    const items = getOnboardingStepRailItems(
      onboardingState({
        completedSteps: ["github", "repository", "pipeline"],
        currentStep: "runtime",
        skippedSteps: ["linear"],
        status: "in_progress",
      }),
      {
        errorSteps: new Set(["runtime"]),
      },
    );

    expect(items.find((item) => item.id === "runtime")).toMatchObject({
      displayState: "error",
      id: "runtime",
    });
    expect(items.filter((item) => item.displayState === "current")).toEqual([]);
  });

  it("surfaces health errors over historical completion", () => {
    const items = getOnboardingStepRailItems(
      onboardingState({
        completedSteps: ["github", "repository", "pipeline"],
        currentStep: "verify",
        status: "in_progress",
      }),
      {
        errorSteps: new Set(["github"]),
      },
    );

    expect(items.find((item) => item.id === "github")?.displayState).toBe("error");
    expect(items.find((item) => item.id === "verify")?.displayState).toBe("current");
  });

  it("continues by completing the current step and persisting the next current step", () => {
    expect(
      buildOnboardingContinuePatch(
        onboardingState({
          currentStep: "repository",
          status: "not_started",
        }),
      ),
    ).toEqual({
      completedSteps: ["repository"],
      currentStep: "pipeline",
      skippedSteps: [],
      status: "in_progress",
    });
  });

  it("marks a non-final step complete without advancing current step", () => {
    expect(
      buildOnboardingStepCompletionPatch(
        onboardingState({
          currentStep: "repository",
          skippedSteps: ["repository"],
          status: "not_started",
        }),
      ),
    ).toEqual({
      completedSteps: ["repository"],
      skippedSteps: [],
      status: "in_progress",
    });
  });

  it("does not build a stay-put completion patch for the final step", () => {
    expect(
      buildOnboardingStepCompletionPatch(onboardingState({ currentStep: "verify" })),
    ).toBeNull();
  });

  it("can advance to the next step without completing the current step", () => {
    expect(
      buildOnboardingAdvancePatch(
        onboardingState({
          currentStep: "pipeline",
          status: "in_progress",
        }),
      ),
    ).toEqual({
      currentStep: "linear",
      status: "in_progress",
    });
  });

  it("selects a repository and clears stale repository-dependent completion", () => {
    expect(
      buildOnboardingRepositorySelectionPatch(
        onboardingState({
          completedSteps: ["github", "repository", "pipeline", "runtime", "verify"],
          selectedGithubRepositoryId: "repo-old",
          skippedSteps: ["linear", "runtime"],
          status: "completed",
        }),
        "repo-new",
      ),
    ).toEqual({
      completedSteps: ["github", "pipeline"],
      selectedGithubRepositoryId: "repo-new",
      skippedSteps: ["linear"],
      status: "in_progress",
    });
  });

  it("does not build a repository selection patch when the selected repo is unchanged", () => {
    expect(
      buildOnboardingRepositorySelectionPatch(
        onboardingState({ selectedGithubRepositoryId: "repo-1" }),
        "repo-1",
      ),
    ).toBeNull();
  });

  it("persists a fallback-equivalent repository selection without clearing progress", () => {
    expect(
      buildOnboardingRepositorySelectionPatch(
        onboardingState({
          completedSteps: ["github", "repository", "pipeline", "runtime", "verify"],
          selectedGithubRepositoryId: null,
          skippedSteps: ["linear"],
          status: "completed",
        }),
        "repo-1",
        "repo-1",
      ),
    ).toEqual({
      selectedGithubRepositoryId: "repo-1",
    });
  });

  it("clears the skipped mark when a previously skipped step is completed", () => {
    expect(
      buildOnboardingContinuePatch(
        onboardingState({
          currentStep: "linear",
          skippedSteps: ["linear"],
          status: "in_progress",
        }),
      ),
    ).toEqual({
      completedSteps: ["linear"],
      currentStep: "runtime",
      skippedSteps: [],
      status: "in_progress",
    });
  });

  it("completes onboarding from the verify step", () => {
    expect(
      buildOnboardingContinuePatch(
        onboardingState({
          completedSteps: ["github", "repository", "pipeline", "linear", "runtime"],
          currentStep: "verify",
          status: "in_progress",
        }),
      ),
    ).toEqual({
      completedSteps: ["github", "repository", "pipeline", "linear", "runtime", "verify"],
      currentStep: "verify",
      skippedSteps: [],
      status: "completed",
    });
  });

  it("only skips locally allowlisted placeholder steps", () => {
    expect(buildOnboardingSkipPatch(onboardingState({ currentStep: "pipeline" }))).toBeNull();
    expect(buildOnboardingSkipPatch(onboardingState({ currentStep: "linear" }))).toEqual({
      completedSteps: [],
      currentStep: "runtime",
      skippedSteps: ["linear"],
      status: "in_progress",
    });
  });

  it("clears the completed mark when a completed placeholder step is skipped again", () => {
    expect(
      buildOnboardingSkipPatch(
        onboardingState({
          completedSteps: ["github", "repository", "pipeline", "linear"],
          currentStep: "linear",
          status: "in_progress",
        }),
      ),
    ).toEqual({
      completedSteps: ["github", "repository", "pipeline"],
      currentStep: "runtime",
      skippedSteps: ["linear"],
      status: "in_progress",
    });
  });

  it("allows rail navigation to any setup step before completion", () => {
    const state = onboardingState({
      currentStep: "runtime",
      skippedSteps: ["linear"],
      status: "in_progress",
    });

    expect(buildOnboardingRailNavigationPatch(state, "pipeline")).toEqual({
      currentStep: "pipeline",
      status: "in_progress",
    });
    expect(buildOnboardingRailNavigationPatch(state, "linear")).toEqual({
      currentStep: "linear",
      status: "in_progress",
    });
    expect(buildOnboardingRailNavigationPatch(state, "verify")).toEqual({
      currentStep: "verify",
      status: "in_progress",
    });
  });

  it("does not persist rail navigation after onboarding is completed", () => {
    const state = onboardingState({
      completedSteps: ["github", "repository", "pipeline", "linear", "runtime", "verify"],
      currentStep: "verify",
      status: "completed",
    });

    expect(buildOnboardingRailNavigationPatch(state, "pipeline")).toBeNull();
  });

  it("builds exit patches and hides resume after completion", () => {
    expect(buildOnboardingExitPatch(onboardingState({ status: "in_progress" }))).toEqual({
      status: "dismissed",
    });
    expect(buildOnboardingExitPatch(onboardingState({ status: "completed" }))).toBeNull();
    expect(shouldShowOnboardingResumeCta(onboardingState({ status: "dismissed" }))).toBe(true);
    expect(shouldShowOnboardingResumeCta(onboardingState({ status: "completed" }))).toBe(false);
    expect(shouldShowOnboardingResumeCta(null)).toBe(false);
  });

  it("maps a missing onboarding row to setup-required resume state", () => {
    expect(mapOnboardingResumeState(null)).toEqual({
      currentStep: "github",
      status: "not_started",
    });
  });
});
