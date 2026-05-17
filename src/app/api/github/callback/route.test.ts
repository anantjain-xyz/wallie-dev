import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  eq: vi.fn(),
  from: vi.fn(),
  neq: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from: mocked.from,
  }),
}));

import { activateOnboardingGitHubStep } from "./route";

describe("activateOnboardingGitHubStep", () => {
  it("does not downgrade completed onboarding rows", async () => {
    mocked.neq.mockResolvedValue({ data: null, error: null });
    mocked.eq.mockReturnValue({ neq: mocked.neq });
    mocked.update.mockReturnValue({ eq: mocked.eq });
    mocked.from.mockReturnValue({ update: mocked.update });

    await activateOnboardingGitHubStep({
      createdAt: new Date().toISOString(),
      source: "onboarding",
      userId: "user-1",
      version: 1,
      workspaceId: "workspace-1",
      workspaceSlug: "acme",
    });

    expect(mocked.from).toHaveBeenCalledWith("workspace_onboarding");
    expect(mocked.update).toHaveBeenCalledWith({
      current_step: "github",
      status: "in_progress",
    });
    expect(mocked.eq).toHaveBeenCalledWith("workspace_id", "workspace-1");
    expect(mocked.neq).toHaveBeenCalledWith("status", "completed");
  });

  it("does not touch onboarding rows for settings installs", async () => {
    vi.clearAllMocks();

    await activateOnboardingGitHubStep({
      createdAt: new Date().toISOString(),
      source: "settings",
      userId: "user-1",
      version: 1,
      workspaceId: "workspace-1",
      workspaceSlug: "acme",
    });

    expect(mocked.from).not.toHaveBeenCalled();
  });
});
