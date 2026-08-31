import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  completeWorkspaceOnboarding: vi.fn(),
}));

vi.mock("@/features/onboarding/data", () => ({
  completeWorkspaceOnboarding: mocked.completeWorkspaceOnboarding,
}));

import { POST } from "./route";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const UPDATED_AT = "2026-05-16T18:00:00.000Z";

function routeContext(workspaceId = WORKSPACE_ID) {
  return { params: Promise.resolve({ workspaceId }) };
}

function completionRequest() {
  return new Request("http://localhost", {
    body: JSON.stringify({ expectedUpdatedAt: UPDATED_AT }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

describe("POST /api/workspaces/[workspaceId]/onboarding/complete", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns a minimal completed onboarding delta on success", async () => {
    const data = {
      action: "complete",
      kind: "onboarding-mutation",
      onboarding: {
        completedAt: "2026-05-16T18:00:00.000Z",
        completedSteps: ["github", "repository", "pipeline", "linear", "runtime", "verify"],
        currentStep: "verify",
        dismissedAt: null,
        selectedGithubRepositoryId: null,
        skippedSteps: [],
        status: "completed",
      },
      setupHealth: {},
      step: "verify",
      updatedAt: UPDATED_AT,
      validationErrors: [],
    };
    mocked.completeWorkspaceOnboarding.mockResolvedValue({ data, ok: true });

    const response = await POST(completionRequest(), routeContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(data);
    expect(mocked.completeWorkspaceOnboarding).toHaveBeenCalledWith(WORKSPACE_ID, UPDATED_AT);
  });

  it("returns structured blockers when verification is incomplete", async () => {
    mocked.completeWorkspaceOnboarding.mockResolvedValue({
      blockers: [
        {
          detail: "Complete the Linear step.",
          id: "linear",
          label: "Linear completed",
          step: "linear",
        },
      ],
      error: "Onboarding verification is blocked.",
      ok: false,
      status: 409,
    });

    const response = await POST(completionRequest(), routeContext());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      action: "complete",
      blockers: [
        {
          detail: "Complete the Linear step.",
          id: "linear",
          label: "Linear completed",
          step: "linear",
        },
      ],
      error: "Onboarding verification is blocked.",
      kind: "onboarding-mutation-error",
      retryable: true,
      step: "verify",
      validationErrors: [{ field: "linear", message: "Complete the Linear step." }],
    });
  });

  it("rejects malformed workspace ids", async () => {
    const response = await POST(completionRequest(), routeContext("bad-id"));

    expect(response.status).toBe(400);
    expect(mocked.completeWorkspaceOnboarding).not.toHaveBeenCalled();
  });
});
