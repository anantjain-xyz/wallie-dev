import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { getOnboardingStepRailItems } from "@/features/onboarding/flow";
import type { WorkspaceOnboardingState } from "@/lib/onboarding/contracts";

import { nextPreloadableStep, StepLoading } from "./active-step";

function onboarding(overrides: Partial<WorkspaceOnboardingState> = {}): WorkspaceOnboardingState {
  return {
    completedAt: null,
    completedSteps: [],
    createdAt: "2026-07-18T00:00:00.000Z",
    currentStep: "github",
    dismissedAt: null,
    id: "onboarding-1",
    selectedGithubRepositoryId: null,
    skippedSteps: [],
    status: "in_progress",
    updatedAt: "2026-07-18T00:00:00.000Z",
    workspaceId: "workspace-1",
    ...overrides,
  };
}

describe("deferred onboarding steps", () => {
  it("preloads the next valid branch without loading skipped or blocked steps", () => {
    const items = getOnboardingStepRailItems(
      onboarding({ currentStep: "repository", skippedSteps: ["linear"] }),
    ).map((item) =>
      item.id === "pipeline" ? { ...item, displayState: "blocked" as const } : item,
    );

    expect(nextPreloadableStep("repository", items)).toBe("runtime");
  });

  it("does not preload after the final valid step", () => {
    expect(nextPreloadableStep("verify", getOnboardingStepRailItems(onboarding()))).toBeNull();
  });

  it("uses a geometry-stable loading surface", () => {
    const html = renderToStaticMarkup(createElement(StepLoading));
    expect(html).toContain('aria-label="Loading setup step"');
    expect(html).toContain("min-h-[420px]");
  });
});
