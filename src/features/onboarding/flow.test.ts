import { describe, expect, it } from "vitest";

import {
  buildOnboardingContinuePatch,
  buildOnboardingExitPatch,
  buildOnboardingRailNavigationPatch,
  buildOnboardingSkipPatch,
  getOnboardingStepRailItems,
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
    skippedSteps: [],
    status: "not_started",
    updatedAt: "2026-05-16T18:00:00.000Z",
    workspaceId: "workspace-1",
    ...overrides,
  };
}

describe("onboarding flow helpers", () => {
  it("maps completed, skipped, active, and blocked rail states from server state", () => {
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
      ["pipeline", "active"],
      ["linear", "blocked"],
      ["runtime", "blocked"],
      ["verify", "blocked"],
    ]);
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

  it("allows rail navigation backward and to skipped steps but blocks future steps", () => {
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
    expect(buildOnboardingRailNavigationPatch(state, "verify")).toBeNull();
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
});
