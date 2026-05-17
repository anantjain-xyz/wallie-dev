import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  completeWorkspaceOnboarding: vi.fn(),
}));

vi.mock("@/features/onboarding/data", () => ({
  completeWorkspaceOnboarding: mocked.completeWorkspaceOnboarding,
}));

import { POST } from "./route";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

function routeContext(workspaceId = WORKSPACE_ID) {
  return { params: Promise.resolve({ workspaceId }) };
}

describe("POST /api/workspaces/[workspaceId]/onboarding/complete", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns completed onboarding data on success", async () => {
    const data = {
      onboarding: {
        completedAt: "2026-05-16T18:00:00.000Z",
        completedSteps: ["github", "repository", "pipeline", "linear", "runtime", "verify"],
        currentStep: "verify",
        status: "completed",
      },
      workspace: { id: WORKSPACE_ID, name: "Wallie", slug: "wallie" },
    };
    mocked.completeWorkspaceOnboarding.mockResolvedValue({ data, ok: true });

    const response = await POST(new Request("http://localhost"), routeContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(data);
    expect(mocked.completeWorkspaceOnboarding).toHaveBeenCalledWith(WORKSPACE_ID);
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

    const response = await POST(new Request("http://localhost"), routeContext());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      blockers: [
        {
          detail: "Complete the Linear step.",
          id: "linear",
          label: "Linear completed",
          step: "linear",
        },
      ],
      error: "Onboarding verification is blocked.",
    });
  });

  it("rejects malformed workspace ids", async () => {
    const response = await POST(new Request("http://localhost"), routeContext("bad-id"));

    expect(response.status).toBe(400);
    expect(mocked.completeWorkspaceOnboarding).not.toHaveBeenCalled();
  });
});
