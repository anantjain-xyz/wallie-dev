import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildWorkspaceOnboardingUpdatePayload } from "@/features/onboarding/data";

describe("buildWorkspaceOnboardingUpdatePayload", () => {
  const now = new Date("2026-05-16T18:00:00.000Z");

  it("sets completion metadata and clears dismissal metadata when completing setup", () => {
    expect(
      buildWorkspaceOnboardingUpdatePayload(
        {
          completedSteps: ["github", "repository", "pipeline", "linear", "runtime", "verify"],
          currentStep: "verify",
          status: "completed",
        },
        now,
      ),
    ).toEqual({
      completed_at: "2026-05-16T18:00:00.000Z",
      completed_steps: ["github", "repository", "pipeline", "linear", "runtime", "verify"],
      current_step: "verify",
      dismissed_at: null,
      status: "completed",
    });
  });

  it("clears dismissal metadata when resuming setup", () => {
    expect(buildWorkspaceOnboardingUpdatePayload({ status: "in_progress" }, now)).toEqual({
      dismissed_at: null,
      status: "in_progress",
    });
  });

  it("records dismissal metadata when dismissing setup", () => {
    expect(buildWorkspaceOnboardingUpdatePayload({ status: "dismissed" }, now)).toEqual({
      dismissed_at: "2026-05-16T18:00:00.000Z",
      status: "dismissed",
    });
  });
});
