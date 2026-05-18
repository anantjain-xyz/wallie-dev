import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
  resolveAuthenticatedSettingsPath: vi.fn(),
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
    resolveAuthenticatedSettingsPath: mocked.resolveAuthenticatedSettingsPath,
  };
});

import { GET } from "@/app/auth/codex/route";

describe("GET /auth/codex", () => {
  beforeEach(() => {
    mocked.createSupabaseServerClient.mockResolvedValue({});
    mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-123" });
    mocked.resolveAuthenticatedSettingsPath.mockResolvedValue("/settings/integrations");
  });

  afterEach(() => {
    mocked.createSupabaseServerClient.mockReset();
    mocked.getSupabaseUserOrNull.mockReset();
    mocked.resolveAuthenticatedSettingsPath.mockReset();
  });

  it("redirects authenticated users back to settings with an unsupported OAuth flash", async () => {
    const response = await GET(new NextRequest("https://preview.wallie.cc/auth/codex"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://preview.wallie.cc/settings/integrations?codex_connect=oauth_unsupported",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("preserves a safe next path when redirecting authenticated users", async () => {
    const response = await GET(
      new NextRequest("http://localhost:3000/auth/codex?next=/w/acme/onboarding?step=runtime"),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/w/acme/onboarding?step=runtime&codex_connect=oauth_unsupported",
    );
  });

  it("sends unauthenticated users through login", async () => {
    mocked.getSupabaseUserOrNull.mockResolvedValue(null);

    const response = await GET(new NextRequest("http://localhost:3000/auth/codex?next=/settings"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("/login");
  });
});
