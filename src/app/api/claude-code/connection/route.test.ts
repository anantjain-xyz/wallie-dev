import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  createSupabaseServerClient: vi.fn(),
  encryptSecretValue: vi.fn((value: string) => `encrypted:${value}`),
  getSupabaseUserOrNull: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));

vi.mock("@/lib/supabase/auth", () => ({
  getSupabaseUserOrNull: mocked.getSupabaseUserOrNull,
}));

vi.mock("@/lib/secrets/crypto", () => ({
  encryptSecretValue: mocked.encryptSecretValue,
}));

import { DELETE, GET, POST } from "./route";

const USER_ID = "user-1";

function request(body: unknown) {
  return new Request("http://localhost/api/claude-code/connection", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.createSupabaseServerClient.mockResolvedValue({});
  mocked.getSupabaseUserOrNull.mockResolvedValue({ id: USER_ID });
});

describe("/api/claude-code/connection", () => {
  it("returns disconnected status when no credential is saved", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    mocked.createSupabaseAdminClient.mockReturnValue({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connected: false });
  });

  it("returns saved credential metadata without returning the secret", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: { updated_at: "2026-05-18T00:00:00.000Z" },
      error: null,
    });
    mocked.createSupabaseAdminClient.mockReturnValue({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
    });

    const response = await GET();

    expect(await response.json()).toEqual({
      connected: true,
      updatedAt: "2026-05-18T00:00:00.000Z",
    });
  });

  it("saves an Anthropic API key encrypted", async () => {
    const single = vi.fn().mockResolvedValue({
      data: { updated_at: "2026-05-18T00:00:00.000Z" },
      error: null,
    });
    const select = vi.fn(() => ({ single }));
    const upsert = vi.fn(() => ({ select }));
    mocked.createSupabaseAdminClient.mockReturnValue({ from: () => ({ upsert }) });

    const response = await POST(request({ credential: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz" }));

    expect(response.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        encrypted_api_key: "encrypted:sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
        user_id: USER_ID,
      }),
      { onConflict: "user_id" },
    );
    const payload = await response.json();
    expect(JSON.stringify(payload)).not.toContain("sk-ant-api03");
  });

  it("rejects malformed Anthropic API keys", async () => {
    const response = await POST(request({ credential: "not-an-anthropic-key" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Anthropic API keys should start with sk-ant-.",
    });
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("deletes the current user's saved credential", async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const deleteFn = vi.fn(() => ({ eq }));
    mocked.createSupabaseAdminClient.mockReturnValue({ from: () => ({ delete: deleteFn }) });

    const response = await DELETE();

    expect(response.status).toBe(204);
    expect(eq).toHaveBeenCalledWith("user_id", USER_ID);
  });
});
