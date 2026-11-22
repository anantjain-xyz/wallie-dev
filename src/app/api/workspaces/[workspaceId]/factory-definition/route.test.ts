import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  mutateFactoryDefinition: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
}));

vi.mock("@/lib/factory-definitions/mutations", () => ({
  mutateFactoryDefinition: mocked.mutateFactoryDefinition,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));
vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

import { GET as GET_SCOPED, POST as POST_SCOPED } from "../factories/[factoryId]/definition/route";
import { GET, POST } from "./route";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const factoryId = "00000000-0000-4000-8000-000000000002";
const actorUserId = "00000000-0000-4000-8000-000000000003";
const draftId = "00000000-0000-4000-8000-000000000004";
const revisionId = "00000000-0000-4000-8000-000000000005";
const now = "2026-11-15T00:00:00Z";
const routeUrl = `http://localhost/api/workspaces/${workspaceId}/factory-definition`;
const context = () => ({ params: Promise.resolve({ workspaceId }) });
const scopedContext = { params: Promise.resolve({ workspaceId, factoryId }) };
const scopedUrl = `http://localhost/api/workspaces/${workspaceId}/factories/${factoryId}/definition`;

function authorized(from = vi.fn()) {
  mocked.requireWorkspaceAccessById.mockResolvedValue({
    ok: true,
    context: { workspace: { id: workspaceId }, user: { id: actorUserId }, supabase: { from } },
  });
  return from;
}

function tableQuery(data: unknown, error: unknown = null) {
  const result = Promise.resolve({ data, error });
  const query = {
    eq: vi.fn(),
    limit: vi.fn(),
    lte: vi.fn(),
    maybeSingle: vi.fn().mockReturnValue(result),
    order: vi.fn(),
    select: vi.fn(),
    then: result.then.bind(result),
  };
  for (const method of [query.eq, query.limit, query.lte, query.order, query.select]) {
    method.mockReturnValue(query);
  }
  return query;
}

function activation(activationNumber: number) {
  return {
    id: `activation-${activationNumber}`,
    revision_id: revisionId,
    activation_number: activationNumber,
    previous_activation_number: activationNumber === 1 ? null : activationNumber - 1,
    created_at: now,
  };
}

function activationSummary(row: ReturnType<typeof activation>) {
  return {
    id: row.id,
    revisionId: row.revision_id,
    activationNumber: row.activation_number,
    previousActivationNumber: row.previous_activation_number,
    createdAt: row.created_at,
  };
}

function post(body: unknown) {
  return POST(
    new Request(routeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    context(),
  );
}

beforeEach(() => vi.resetAllMocks());

describe("GET factory activation history", () => {
  it("uses member-scoped reads and returns the observed current activation on a paged response", async () => {
    const current = activation(12);
    const older = [activation(8), activation(7), activation(6)];
    const factory = tableQuery({ id: factoryId });
    const head = tableQuery(current);
    const page = tableQuery(older);
    const from = authorized(
      vi.fn().mockReturnValueOnce(factory).mockReturnValueOnce(head).mockReturnValueOnce(page),
    );

    const response = await GET(
      new Request(`${routeUrl}?beforeActivationNumber=9&limit=2`),
      context(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      factoryId,
      currentActivation: activationSummary(current),
      activations: older.slice(0, 2).map(activationSummary),
      nextBeforeActivationNumber: 7,
    });
    expect(mocked.requireWorkspaceAccessById).toHaveBeenCalledWith(workspaceId);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
    expect(from.mock.calls).toEqual([
      ["factories"],
      ["factory_definition_activations"],
      ["factory_definition_activations"],
    ]);
    expect(factory.eq.mock.calls).toEqual([
      ["workspace_id", workspaceId],
      ["status", "active"],
      ["is_default", true],
    ]);
    for (const query of [head, page]) {
      expect(query.eq.mock.calls).toEqual([
        ["workspace_id", workspaceId],
        ["factory_id", factoryId],
      ]);
      expect(query.order).toHaveBeenCalledWith("activation_number", { ascending: false });
    }
    expect(head.limit).toHaveBeenCalledWith(1);
    expect(page.lte).toHaveBeenCalledWith("activation_number", 8);
    expect(page.limit).toHaveBeenCalledWith(3);
  });

  it("keeps the explicit factory constraint and never falls back after an unavailable lookup", async () => {
    const factory = tableQuery(null);
    const from = authorized(vi.fn().mockReturnValueOnce(factory));
    const response = await GET_SCOPED(new Request(scopedUrl), scopedContext);
    expect(response.status).toBe(404);
    expect(from.mock.calls).toEqual([["factories"]]);
    expect(factory.eq.mock.calls).toEqual([
      ["workspace_id", workspaceId],
      ["status", "active"],
      ["id", factoryId],
    ]);
  });

  it("passes the exact factory to the shared mutation", async () => {
    authorized();
    const client = {};
    const command = { action: "publish", draftId, expectedActivationNumber: 0 };
    mocked.createSupabaseAdminClient.mockReturnValue(client);
    mocked.mutateFactoryDefinition.mockResolvedValue({ ok: true, result: {} });
    const response = await POST_SCOPED(
      new Request(scopedUrl, { method: "POST", body: JSON.stringify(command) }),
      scopedContext,
    );
    expect(response.status).toBe(201);
    expect(mocked.mutateFactoryDefinition).toHaveBeenCalledWith({
      admin: client,
      workspaceId,
      factoryId,
      actorUserId,
      command,
    });
  });

  it("limits the first page to the current activation and uses a 25-item default", async () => {
    const factory = tableQuery({ id: factoryId });
    const head = tableQuery(activation(1));
    const page = tableQuery([activation(1)]);
    authorized(
      vi.fn().mockReturnValueOnce(factory).mockReturnValueOnce(head).mockReturnValueOnce(page),
    );

    const response = await GET(new Request(routeUrl), context());
    expect(await response.json()).toEqual({
      factoryId,
      currentActivation: activationSummary(activation(1)),
      activations: [activationSummary(activation(1))],
      nextBeforeActivationNumber: null,
    });
    expect(page.lte).toHaveBeenCalledWith("activation_number", 1);
    expect(page.limit).toHaveBeenCalledWith(26);
  });

  it("returns null current activation before the first publication", async () => {
    const from = authorized(
      vi
        .fn()
        .mockReturnValueOnce(tableQuery({ id: factoryId }))
        .mockReturnValueOnce(tableQuery(null)),
    );
    const response = await GET(new Request(routeUrl), context());
    expect(await response.json()).toEqual({
      factoryId,
      currentActivation: null,
      activations: [],
      nextBeforeActivationNumber: null,
    });
    expect(from).toHaveBeenCalledTimes(2);
  });

  it.each([
    "beforeActivationNumber=0",
    "beforeActivationNumber=1.2",
    "beforeActivationNumber=9007199254740992",
    "limit=101",
  ])("rejects an invalid history query before authorized reads (%s)", async (query) => {
    const response = await GET(new Request(`${routeUrl}?${query}`), context());
    expect(response.status).toBe(400);
    expect(mocked.requireWorkspaceAccessById).not.toHaveBeenCalled();
  });

  it("does not expose a default factory outside the signed-in member's access", async () => {
    mocked.requireWorkspaceAccessById.mockResolvedValue({
      ok: false,
      status: 404,
      error: "Workspace not found.",
    });
    const response = await GET(new Request(routeUrl), context());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Workspace not found." });
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });
});

describe("POST factory definition commands", () => {
  const draft = {
    id: draftId,
    baseActivationNumber: null,
    schemaVersion: 1,
    canonicalDigest: "a".repeat(64),
    createdAt: now,
  };
  const activated = activationSummary(activation(1));

  it.each([
    [
      {
        action: "draft",
        expectedActivationNumber: 0,
        source: { kind: "structured", value: { schemaVersion: 1 } },
      },
      { draft },
    ],
    [
      {
        action: "draft",
        expectedActivationNumber: 0,
        source: { kind: "json", text: '{"schemaVersion":1}' },
      },
      { draft },
    ],
    [{ action: "publish", expectedActivationNumber: 0, draftId }, { activation: activated }],
    [
      { action: "activate-routing", expectedActivationNumber: 0, draftId },
      { activation: activated },
    ],
    [
      {
        action: "activate-routing",
        expectedActivationNumber: 1,
        draftId,
        canary: { taskClassId: revisionId, candidateBps: 2_000 },
      },
      { activation: activated },
    ],
    [{ action: "rollback", expectedActivationNumber: 1, revisionId }, { activation: activated }],
    [
      { action: "rollback", expectedActivationNumber: 4, revisionId, targetActivationNumber: 2 },
      { activation: activated },
    ],
  ])(
    "uses signed-in authority and preserves the exact action payload (%j)",
    async (command, result) => {
      authorized();
      const admin = { rpc: vi.fn() };
      mocked.createSupabaseAdminClient.mockReturnValue(admin);
      mocked.mutateFactoryDefinition.mockResolvedValue({ ok: true, result });

      const response = await post(command);
      expect(response.status).toBe(201);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.json()).toEqual(result);
      expect(mocked.requireWorkspaceAccessById).toHaveBeenCalledWith(workspaceId, {
        requireManager: true,
      });
      expect(mocked.mutateFactoryDefinition).toHaveBeenCalledWith({
        admin,
        workspaceId,
        actorUserId,
        command,
      });
    },
  );

  it.each([
    { status: 401, error: "Sign in before managing workspace settings." },
    { status: 403, error: "Workspace admin access is required." },
  ])(
    "leaves the request body unread when workspace access is denied ($status)",
    async (failure) => {
      mocked.requireWorkspaceAccessById.mockResolvedValue({ ok: false, ...failure });
      const request = new Request(routeUrl, { method: "POST", body: "not valid JSON" });
      const response = await POST(request, context());
      expect(response.status).toBe(failure.status);
      expect(await response.json()).toEqual({ error: failure.error });
      expect(request.bodyUsed).toBe(false);
      expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
      expect(mocked.mutateFactoryDefinition).not.toHaveBeenCalled();
    },
  );

  it.each([
    { action: "publish", draftId },
    { action: "publish", expectedActivationNumber: 0.5, draftId },
    { action: "publish", expectedActivationNumber: 0, draftId, actorUserId },
    { action: "activate-routing", expectedActivationNumber: 0, draftId, reviewedTargets: [] },
    {
      action: "activate-routing",
      expectedActivationNumber: 1,
      draftId,
      canary: { taskClassId: revisionId, candidateBps: 10_000 },
    },
    {
      action: "publish",
      expectedActivationNumber: 1,
      draftId,
      canary: { taskClassId: revisionId, candidateBps: 2_000 },
    },
    { action: "rollback", expectedActivationNumber: 0, revisionId, definitionJson: "{}" },
    { action: "rollback", expectedActivationNumber: 3, revisionId, targetActivationNumber: 0 },
    { action: "draft", expectedActivationNumber: 0, source: { kind: "structured" } },
  ])("rejects malformed or caller-authorized commands (%j)", async (command) => {
    authorized();
    const response = await post(command);
    expect(response.status).toBe(400);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("rejects repeated authored keys in a structured command before compiling", async () => {
    authorized();
    const response = await POST(
      new Request(routeUrl, {
        method: "POST",
        body: '{"action":"draft","expectedActivationNumber":0,"source":{"kind":"structured","value":{"schemaVersion":1,"schemaVersion":2}}}',
      }),
      context(),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: expect.stringContaining("duplicate object key"),
    });
    expect(mocked.mutateFactoryDefinition).not.toHaveBeenCalled();
  });

  it("returns the compiler field diagnostics and activation conflict status", async () => {
    authorized();
    const diagnostics = [
      { path: ["repository"], code: "missing_reference", message: "Choose a repository." },
    ];
    mocked.mutateFactoryDefinition
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        error: "The revision is no longer compatible.",
        diagnostics,
      })
      .mockResolvedValueOnce({ ok: false, status: 409, error: "The active revision changed." });
    const command = { action: "publish", expectedActivationNumber: 0, draftId };
    const unavailable = await post(command);
    expect(unavailable.status).toBe(422);
    expect(await unavailable.json()).toEqual({
      error: "The revision is no longer compatible.",
      diagnostics,
    });
    const conflict = await post(command);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "The active revision changed." });
  });
});
