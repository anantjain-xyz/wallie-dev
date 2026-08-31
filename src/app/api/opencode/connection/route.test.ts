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
  return new Request("http://localhost/api/opencode/connection", {
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

describe("/api/opencode/connection", () => {
  it("returns disconnected status when no credential is saved", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    mocked.createSupabaseAdminClient.mockReturnValue({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connected: false });
  });

  it("returns saved metadata without returning the secret", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: { updated_at: "2026-08-30T00:00:00.000Z" },
      error: null,
    });
    mocked.createSupabaseAdminClient.mockReturnValue({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
    });

    const response = await GET();

    expect(await response.json()).toEqual({
      connected: true,
      updatedAt: "2026-08-30T00:00:00.000Z",
    });
  });

  it("applies length-only validation and stores the key encrypted", async () => {
    const single = vi.fn().mockResolvedValue({
      data: { updated_at: "2026-08-30T00:00:00.000Z" },
      error: null,
    });
    const select = vi.fn(() => ({ single }));
    const upsert = vi.fn(() => ({ select }));
    mocked.createSupabaseAdminClient.mockReturnValue({ from: () => ({ upsert }) });
    const arbitraryKey = "any-zen-key-format-12345";

    const response = await POST(request({ credential: arbitraryKey }));

    expect(response.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        encrypted_api_key: `encrypted:${arbitraryKey}`,
        user_id: USER_ID,
      }),
      { onConflict: "user_id" },
    );
    expect(JSON.stringify(await response.json())).not.toContain(arbitraryKey);
  });

  it("rejects only keys outside the allowed length", async () => {
    const response = await POST(request({ credential: "short" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Credential is too short." });
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("deletes the current user's key", async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const deleteFn = vi.fn(() => ({ eq }));
    mocked.createSupabaseAdminClient.mockReturnValue({ from: () => ({ delete: deleteFn }) });

    const response = await DELETE();

    expect(response.status).toBe(204);
    expect(eq).toHaveBeenCalledWith("user_id", USER_ID);
  });
});
