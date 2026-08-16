import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  createSupabaseServerClient: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/supabase/auth", () => ({
  getSupabaseUserOrNull: mocked.getSupabaseUserOrNull,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));

import { PATCH } from "./route";

function requestWith(body: unknown) {
  return new Request("http://localhost/api/profile", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
}

describe("PATCH /api/profile", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("requires authentication", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue({});
    mocked.getSupabaseUserOrNull.mockResolvedValue(null);

    const response = await PATCH(requestWith({ fullName: "Anant Jain" }));

    expect(response.status).toBe(401);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("rejects blank and oversized names", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue({});
    mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-1" });

    const blankResponse = await PATCH(requestWith({ fullName: "   " }));
    const longResponse = await PATCH(requestWith({ fullName: "a".repeat(101) }));

    expect(blankResponse.status).toBe(400);
    expect(longResponse.status).toBe(400);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("updates only the authenticated user's account-wide name", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue({});
    mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-1" });
    mocked.rpc.mockResolvedValue({ data: {}, error: null });
    mocked.createSupabaseAdminClient.mockReturnValue({ rpc: mocked.rpc });

    const response = await PATCH(requestWith({ fullName: "  Anant Jain  " }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ profile: { fullName: "Anant Jain" } });
    expect(mocked.rpc).toHaveBeenCalledWith("update_user_display_name", {
      actor_full_name: "Anant Jain",
      actor_user_id: "user-1",
    });
  });
});
