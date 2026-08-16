import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  ensureProfileForUser: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
  resolveAuthenticatedHomePath: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));

vi.mock("@/lib/supabase/auth", () => ({
  getSupabaseUserOrNull: mocked.getSupabaseUserOrNull,
}));

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");

  return {
    ...actual,
    ensureProfileForUser: mocked.ensureProfileForUser,
    resolveAuthenticatedHomePath: mocked.resolveAuthenticatedHomePath,
  };
});

import { GET } from "./route";

describe("GET /auth/callback", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function setupAuthenticatedCallback() {
    const supabase = {
      auth: {
        exchangeCodeForSession: mocked.exchangeCodeForSession,
      },
    };
    const user = { id: "user-123" };

    mocked.createSupabaseServerClient.mockResolvedValue(supabase);
    mocked.exchangeCodeForSession.mockResolvedValue({ error: null });
    mocked.getSupabaseUserOrNull.mockResolvedValue(user);

    return { supabase, user };
  }

  it("defers OAuth profile seeding until invitation acceptance", async () => {
    setupAuthenticatedCallback();

    const response = await GET(
      new NextRequest(
        "http://localhost:3000/auth/callback?code=test-code&next=%2Finvite%2Fraw-token",
      ),
    );

    expect(mocked.ensureProfileForUser).not.toHaveBeenCalled();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/invite/raw-token");
  });

  it("still seeds profiles before ordinary authenticated redirects", async () => {
    const { supabase, user } = setupAuthenticatedCallback();

    const response = await GET(
      new NextRequest("http://localhost:3000/auth/callback?code=test-code&next=%2Fw%2Facme"),
    );

    expect(mocked.ensureProfileForUser).toHaveBeenCalledWith(supabase, user);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/w/acme");
  });
});
