import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  loadDefaultPipelineConfigurationForWorkspace: vi.fn(),
  loadSettingsFactoryDefinitionState: vi.fn(),
  mutateSettingsFactoryDefinition: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));
vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));
vi.mock("@/lib/pipeline/stages", () => ({
  loadDefaultPipelineConfigurationForWorkspace: mocked.loadDefaultPipelineConfigurationForWorkspace,
}));
vi.mock("@/lib/factory-definitions/settings", () => ({
  loadSettingsFactoryDefinitionState: mocked.loadSettingsFactoryDefinitionState,
  mutateSettingsFactoryDefinition: mocked.mutateSettingsFactoryDefinition,
}));

import { GET, POST } from "./route";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const actorUserId = "00000000-0000-4000-8000-000000000002";
const draftId = "00000000-0000-4000-8000-000000000003";
const routeUrl = `http://localhost/api/workspaces/${workspaceId}/factory-definition/settings`;
const context = (id = workspaceId) => ({ params: Promise.resolve({ workspaceId: id }) });

function authorized() {
  const supabase = { from: vi.fn() };
  mocked.requireWorkspaceAccessById.mockResolvedValue({
    ok: true,
    context: { workspace: { id: workspaceId }, user: { id: actorUserId }, supabase },
  });
  return supabase;
}

describe("GET factory definition settings", () => {
  beforeEach(() => vi.resetAllMocks());

  it("loads scoped state for workspace members without creating an admin client", async () => {
    const supabase = authorized();
    const state = {
      factoryId: "00000000-0000-4000-8000-000000000010",
      expectedActivationNumber: 1,
      currentActivation: null,
      latestDraft: null,
      activeDefinition: null,
      defaultRepositoryId: null,
      executionPolicy: null,
      deliveryPolicy: null,
      liveExecutionPolicyRevision: 0,
      liveDeliveryPolicyRevision: 0,
    };
    const pipeline = {
      id: "00000000-0000-4000-8000-000000000011",
      isDefault: true,
      name: "Default",
      operatingRulesMd: "",
      stages: [],
      archivedStages: [],
    };
    mocked.loadSettingsFactoryDefinitionState.mockResolvedValue(state);
    mocked.loadDefaultPipelineConfigurationForWorkspace.mockResolvedValue(pipeline);

    const response = await GET(new Request(routeUrl), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ state, pipeline });
    expect(mocked.requireWorkspaceAccessById).toHaveBeenCalledWith(workspaceId);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
    expect(mocked.loadSettingsFactoryDefinitionState).toHaveBeenCalledWith(supabase, workspaceId);
  });

  it("rejects invalid workspace IDs before checking access", async () => {
    const response = await GET(new Request(routeUrl), context("not-a-uuid"));
    expect(response.status).toBe(400);
    expect(mocked.requireWorkspaceAccessById).not.toHaveBeenCalled();
  });
});

describe("POST factory definition settings", () => {
  beforeEach(() => vi.resetAllMocks());

  it("requires manager access before reading the request body", async () => {
    mocked.requireWorkspaceAccessById.mockResolvedValue({
      ok: false,
      status: 403,
      error: "Workspace admin access is required.",
    });
    const request = new Request(routeUrl, { method: "POST", body: "invalid{" });
    const response = await POST(request, context());
    expect(response.status).toBe(403);
    expect(request.bodyUsed).toBe(false);
    expect(mocked.mutateSettingsFactoryDefinition).not.toHaveBeenCalled();
  });

  it("rejects duplicate object keys before mutating", async () => {
    authorized();
    const response = await POST(
      new Request(routeUrl, {
        method: "POST",
        body: '{"action":"publish","expectedActivationNumber":1,"expectedActivationNumber":2,"draftId":"00000000-0000-4000-8000-000000000003"}',
      }),
      context(),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: expect.stringContaining("duplicate object key"),
    });
    expect(mocked.mutateSettingsFactoryDefinition).not.toHaveBeenCalled();
  });

  it("delegates draft and publish commands and propagates 409 conflicts and 422 field diagnostics", async () => {
    authorized();
    const admin = { rpc: vi.fn() };
    mocked.createSupabaseAdminClient.mockReturnValue(admin);

    const command = {
      action: "draft" as const,
      expectedActivationNumber: 1,
      expectedDraftId: null,
      patch: {
        kind: "sandbox-provider" as const,
        sandboxProvider: "e2b" as const,
      },
    };
    mocked.mutateSettingsFactoryDefinition.mockResolvedValueOnce({
      ok: true,
      result: { state: { expectedActivationNumber: 1 }, sandboxProvider: "e2b" },
    });

    const okRes = await POST(
      new Request(routeUrl, { method: "POST", body: JSON.stringify(command) }),
      context(),
    );
    expect(okRes.status).toBe(201);
    expect(mocked.mutateSettingsFactoryDefinition).toHaveBeenCalledWith({
      admin,
      workspaceId,
      actorUserId,
      command,
    });

    mocked.mutateSettingsFactoryDefinition.mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "Another configuration draft was saved. Reload before retrying.",
    });
    const conflictRes = await POST(
      new Request(routeUrl, {
        method: "POST",
        body: JSON.stringify({
          action: "publish",
          expectedActivationNumber: 1,
          draftId,
        }),
      }),
      context(),
    );
    expect(conflictRes.status).toBe(409);
    expect(await conflictRes.json()).toEqual({
      error: "Another configuration draft was saved. Reload before retrying.",
    });

    mocked.mutateSettingsFactoryDefinition.mockResolvedValueOnce({
      ok: false,
      status: 422,
      error: "Review the factory definition before retrying.",
      diagnostics: [
        {
          path: ["agent", "model"],
          code: "unsupported_capability",
          message: 'Choose a model supported by "codex".',
        },
      ],
    });
    const invalidRes = await POST(
      new Request(routeUrl, { method: "POST", body: JSON.stringify(command) }),
      context(),
    );
    expect(invalidRes.status).toBe(422);
    expect(await invalidRes.json()).toEqual({
      error: "Review the factory definition before retrying.",
      diagnostics: [
        {
          path: ["agent", "model"],
          code: "unsupported_capability",
          message: 'Choose a model supported by "codex".',
        },
      ],
      fieldErrors: {
        agent_model: 'Choose a model supported by "codex".',
      },
    });
  });
});
