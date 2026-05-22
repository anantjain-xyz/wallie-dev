import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

import { PATCH, POST } from "./route";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

function postWith(body: unknown) {
  return new Request("http://localhost/api/agent-config", {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function grantAccess() {
  mocked.requireWorkspaceAccessById.mockResolvedValueOnce({
    ok: true,
    context: {
      currentMember: { id: "m1", role: "owner", is_active: true, kind: "human" },
      workspace: { id: WORKSPACE_ID, name: "wallie", slug: "wallie" },
      user: { id: "u1" },
    },
  });
}

function setupSuccessfulUpsert() {
  const upsert = vi.fn().mockResolvedValue({ error: null });
  mocked.createSupabaseAdminClient.mockReturnValue({
    from: () => ({ upsert }),
  });
  return upsert;
}

describe("POST /api/agent-config — value validation", () => {
  it("rejects negative stall_timeout_ms regardless of access", async () => {
    const response = await POST(
      postWith({ key: "stall_timeout_ms", value: -300_000, workspaceId: WORKSPACE_ID }),
    );

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toMatch(/at least 30000/);
    expect(mocked.requireWorkspaceAccessById).not.toHaveBeenCalled();
  });

  it('rejects model = "lol"', async () => {
    const response = await POST(
      postWith({ key: "agent_model", value: "lol", workspaceId: WORKSPACE_ID }),
    );

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toMatch(/must start with/);
  });

  it("rejects max_retries above 10", async () => {
    const response = await POST(
      postWith({ key: "max_retries", value: 25, workspaceId: WORKSPACE_ID }),
    );

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toMatch(/at most 10/);
  });

  it("rejects unknown agent_provider", async () => {
    const response = await POST(
      postWith({ key: "agent_provider", value: "openai", workspaceId: WORKSPACE_ID }),
    );

    expect(response.status).toBe(400);
  });

  it("rejects unknown keys", async () => {
    const response = await POST(
      postWith({ key: "secret_key", value: "value", workspaceId: WORKSPACE_ID }),
    );

    expect(response.status).toBe(400);
  });

  it("rejects malformed JSON", async () => {
    const response = await POST(postWith("{not json"));
    expect(response.status).toBe(400);
  });

  it("accepts a valid agent_model with admin access", async () => {
    grantAccess();
    setupSuccessfulUpsert();

    const response = await POST(
      postWith({
        key: "agent_model",
        value: "claude-sonnet-4-20250514",
        workspaceId: WORKSPACE_ID,
      }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { entry: { key: string; value: unknown } };
    expect(payload.entry).toEqual({
      key: "agent_model",
      value: "claude-sonnet-4-20250514",
    });
  });

  it("accepts a valid integer stall timeout with admin access", async () => {
    grantAccess();
    setupSuccessfulUpsert();

    const response = await POST(
      postWith({ key: "stall_timeout_ms", value: 600_000, workspaceId: WORKSPACE_ID }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { entry: { key: string; value: unknown } };
    expect(payload.entry).toEqual({ key: "stall_timeout_ms", value: 600_000 });
  });

  it("normalizes the legacy claude_code agent_provider alias before persisting", async () => {
    grantAccess();
    const upsert = setupSuccessfulUpsert();

    const response = await POST(
      postWith({ key: "agent_provider", value: "claude_code", workspaceId: WORKSPACE_ID }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { entry: { key: string; value: unknown } };
    expect(payload.entry).toEqual({ key: "agent_provider", value: "claude-code" });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ key: "agent_provider", value_json: "claude-code" }),
      { onConflict: "workspace_id,key" },
    );
  });

  it("forwards the access-layer status when the caller is unauthorised", async () => {
    mocked.requireWorkspaceAccessById.mockResolvedValueOnce({
      ok: false,
      error: "forbidden",
      status: 403,
    });

    const response = await POST(
      postWith({ key: "max_retries", value: 3, workspaceId: WORKSPACE_ID }),
    );

    expect(response.status).toBe(403);
  });
});

describe("PATCH /api/agent-config — recommended defaults", () => {
  it("applies only missing defaults and preserves existing values", async () => {
    grantAccess();
    const upsert = vi.fn().mockResolvedValue({ error: null });
    mocked.createSupabaseAdminClient.mockReturnValue({
      from: (table: string) => {
        if (table !== "workspace_agent_config") throw new Error(`unexpected table ${table}`);
        return {
          select: () => ({
            eq: vi.fn().mockResolvedValue({
              data: [{ key: "agent_provider" }, { key: "agent_model" }],
              error: null,
            }),
          }),
          upsert,
        };
      },
    });

    const response = await PATCH(
      new Request("http://localhost/api/agent-config", {
        body: JSON.stringify({ workspaceId: WORKSPACE_ID }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      applied: [
        { key: "concurrency_limit", value: 1 },
        { key: "stall_timeout_ms", value: 900000 },
        { key: "max_retries", value: 3 },
      ],
      skippedKeys: [],
    });
    expect(upsert).toHaveBeenCalledWith(
      [
        { key: "concurrency_limit", value_json: 1, workspace_id: WORKSPACE_ID },
        { key: "stall_timeout_ms", value_json: 900000, workspace_id: WORKSPACE_ID },
        { key: "max_retries", value_json: 3, workspace_id: WORKSPACE_ID },
      ],
      { onConflict: "workspace_id,key" },
    );
  });

  it("skips missing defaults with user-edited drafts", async () => {
    grantAccess();
    const upsert = vi.fn().mockResolvedValue({ error: null });
    mocked.createSupabaseAdminClient.mockReturnValue({
      from: () => ({
        select: () => ({
          eq: vi.fn().mockResolvedValue({ data: [], error: null }),
        }),
        upsert,
      }),
    });

    const response = await PATCH(
      new Request("http://localhost/api/agent-config", {
        body: JSON.stringify({ skipKeys: ["agent_model"], workspaceId: WORKSPACE_ID }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { applied: Array<{ key: string }> };
    expect(payload.applied.map((entry) => entry.key)).toEqual([
      "concurrency_limit",
      "stall_timeout_ms",
      "max_retries",
      "agent_provider",
    ]);
    expect(upsert).not.toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ key: "agent_model" })]),
      expect.anything(),
    );
  });

  it("uses the configured provider's recommended model for missing agent_model defaults", async () => {
    grantAccess();
    const upsert = vi.fn().mockResolvedValue({ error: null });
    mocked.createSupabaseAdminClient.mockReturnValue({
      from: () => ({
        select: () => ({
          eq: vi.fn().mockResolvedValue({
            data: [{ key: "agent_provider", value_json: "claude-code" }],
            error: null,
          }),
        }),
        upsert,
      }),
    });

    const response = await PATCH(
      new Request("http://localhost/api/agent-config", {
        body: JSON.stringify({ workspaceId: WORKSPACE_ID }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { applied: Array<{ key: string; value: unknown }> };
    expect(payload.applied).toContainEqual({
      key: "agent_model",
      value: "claude-opus-4-7[1m]",
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.arrayContaining([
        { key: "agent_model", value_json: "claude-opus-4-7[1m]", workspace_id: WORKSPACE_ID },
      ]),
      { onConflict: "workspace_id,key" },
    );
  });
});
