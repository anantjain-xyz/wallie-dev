import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  createSupabaseServerClient: vi.fn(),
  encryptSecretValue: vi.fn((value: string) => `encrypted:${value}`),
  getSupabaseUserOrNull: vi.fn(),
  listOpenCodeProviderCredentialMeta: vi.fn(),
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

vi.mock("@/lib/opencode/tokens", () => ({
  listOpenCodeProviderCredentialMeta: mocked.listOpenCodeProviderCredentialMeta,
}));

import { DELETE, PUT } from "./route";

const USER_ID = "user-1";

function putRequest(body: unknown) {
  return new Request("http://localhost/api/opencode/providers/opencode-go", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
}

function context(providerId: string) {
  return { params: Promise.resolve({ providerId }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.createSupabaseServerClient.mockResolvedValue({});
  mocked.getSupabaseUserOrNull.mockResolvedValue({ id: USER_ID });
  mocked.listOpenCodeProviderCredentialMeta.mockResolvedValue([
    { providerId: "opencode-go", updatedAt: "2026-09-01T00:00:00.000Z" },
  ]);
});

describe("/api/opencode/providers/[providerId]", () => {
  it("stores a provider key encrypted and never echoes it", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    mocked.createSupabaseAdminClient.mockReturnValue({ from: () => ({ upsert }) });
    const key = "opencode-go-key-1234567890";

    const response = await PUT(putRequest({ credential: key }), context("opencode-go"));

    expect(response.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        encrypted_api_key: `encrypted:${key}`,
        provider_id: "opencode-go",
        user_id: USER_ID,
      }),
      { onConflict: "user_id,provider_id" },
    );
    const body = await response.json();
    expect(body).toEqual({
      checkedAt: expect.any(String),
      providerId: "opencode-go",
      providers: [{ providerId: "opencode-go", updatedAt: "2026-09-01T00:00:00.000Z" }],
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(JSON.stringify(body)).not.toContain(key);
  });

  it("rejects the reserved Zen provider id", async () => {
    const response = await PUT(
      putRequest({ credential: "opencode-go-key-1234567890" }),
      context("opencode"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: expect.stringContaining("reserved"),
    });
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("rejects malformed provider ids", async () => {
    const response = await PUT(
      putRequest({ credential: "opencode-go-key-1234567890" }),
      context("OpenRouter"),
    );

    expect(response.status).toBe(400);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("deletes the matching provider key for the current user", async () => {
    const eqProvider = vi.fn().mockResolvedValue({ error: null });
    const eqUser = vi.fn(() => ({ eq: eqProvider }));
    const deleteFn = vi.fn(() => ({ eq: eqUser }));
    mocked.createSupabaseAdminClient.mockReturnValue({ from: () => ({ delete: deleteFn }) });

    const response = await DELETE(new Request("http://localhost"), context("opencode-go"));

    expect(response.status).toBe(204);
    expect(eqUser).toHaveBeenCalledWith("user_id", USER_ID);
    expect(eqProvider).toHaveBeenCalledWith("provider_id", "opencode-go");
  });
});
