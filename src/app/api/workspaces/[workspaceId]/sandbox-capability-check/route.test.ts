import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  after: vi.fn(),
  completeSandboxCapabilityCheck: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
  startSandboxCapabilityCheck: vi.fn(),
}));

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return {
    ...actual,
    after: mocked.after,
  };
});

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

vi.mock("@/lib/sandbox-capabilities/server", () => ({
  completeSandboxCapabilityCheck: mocked.completeSandboxCapabilityCheck,
  startSandboxCapabilityCheck: mocked.startSandboxCapabilityCheck,
}));

import { POST } from "./route";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const REPOSITORY_ID = "11111111-1111-4111-8111-111111111111";

function requestWith(body: unknown) {
  return new Request(`http://localhost/api/workspaces/${WORKSPACE_ID}/sandbox-capability-check`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function routeContext() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) };
}

function grantAccess() {
  mocked.requireWorkspaceAccessById.mockResolvedValue({
    context: {
      currentMember: { id: "member-1", is_active: true, kind: "human", role: "owner" },
      supabase: {},
      user: { id: "user-1" },
      workspace: { id: WORKSPACE_ID, name: "Wallie", slug: "wallie" },
    },
    ok: true,
  });
}

describe("POST /api/workspaces/[workspaceId]/sandbox-capability-check", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns a running check and schedules the sandbox probe after the response", async () => {
    grantAccess();
    const admin = {};
    const check = {
      capabilities: {},
      checkedAt: "2026-05-15T00:00:00.000Z",
      errorText: null,
      githubRepositoryId: REPOSITORY_ID,
      id: "check-1",
      status: "running",
    };
    const repository = {
      default_branch: "main",
      full_name: "acme/app",
      github_installation_id: "installation-row-1",
      id: REPOSITORY_ID,
      workspace_id: WORKSPACE_ID,
    };
    mocked.createSupabaseAdminClient.mockReturnValue(admin);
    mocked.startSandboxCapabilityCheck.mockResolvedValue({ check, repository });
    mocked.completeSandboxCapabilityCheck.mockResolvedValue({ ...check, status: "success" });

    const response = await POST(requestWith({ repositoryId: REPOSITORY_ID }), routeContext());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ check });
    expect(mocked.startSandboxCapabilityCheck).toHaveBeenCalledWith({
      admin,
      repositoryId: REPOSITORY_ID,
      workspaceId: WORKSPACE_ID,
    });
    expect(mocked.completeSandboxCapabilityCheck).not.toHaveBeenCalled();
    expect(mocked.after).toHaveBeenCalledTimes(1);

    const scheduled = mocked.after.mock.calls[0]![0] as () => Promise<void>;
    await scheduled();

    expect(mocked.completeSandboxCapabilityCheck).toHaveBeenCalledWith({
      admin,
      checkId: "check-1",
      repository,
      userId: "user-1",
      workspaceId: WORKSPACE_ID,
    });
  });
});
