import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  ensureProfileForUser: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  ensureProfileForUser: mocked.ensureProfileForUser,
}));

vi.mock("@/lib/supabase/auth", () => ({
  getSupabaseUserOrNull: mocked.getSupabaseUserOrNull,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));

import { POST } from "./route";

function requestWith(body: unknown) {
  return new Request("http://localhost/api/workspaces", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

describe("POST /api/workspaces", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns the workspace onboarding redirect for newly created workspaces", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue({ rpc: mocked.rpc });
    mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-1" });
    mocked.rpc.mockResolvedValue({
      data: {
        id: "workspace-1",
        name: "Northwind Labs",
        slug: "northwind-labs",
      },
      error: null,
    });

    const response = await POST(requestWith({ name: "Northwind Labs", slug: "northwind-labs" }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      redirectTo: "/w/northwind-labs/onboarding",
      workspace: {
        id: "workspace-1",
        name: "Northwind Labs",
        slug: "northwind-labs",
      },
    });
    expect(mocked.rpc).toHaveBeenCalledWith("create_workspace", {
      requested_slug: "northwind-labs",
      workspace_name: "Northwind Labs",
    });
  });
});
