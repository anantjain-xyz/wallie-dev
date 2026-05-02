import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CODEX_OAUTH_COOKIE } from "@/lib/codex/oauth";

const mocked = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
  resolveAuthenticatedSettingsPath: vi.fn(),
  encryptSecretValue: vi.fn(),
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

vi.mock("@/lib/secrets/crypto", () => ({
  encryptSecretValue: mocked.encryptSecretValue,
}));

import { GET } from "@/app/auth/codex/route";

describe("GET /auth/codex", () => {
  beforeEach(() => {
    mocked.createSupabaseServerClient.mockResolvedValue({});
    mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-123" });
    mocked.resolveAuthenticatedSettingsPath.mockResolvedValue("/settings/integrations");
    mocked.encryptSecretValue.mockReturnValue("encrypted-stash");
  });

  afterEach(() => {
    mocked.createSupabaseServerClient.mockReset();
    mocked.getSupabaseUserOrNull.mockReset();
    mocked.resolveAuthenticatedSettingsPath.mockReset();
    mocked.encryptSecretValue.mockReset();
    delete process.env.WALLIE_ALLOW_INSECURE_COOKIES;
  });

  it("sets Secure on the OAuth state cookie outside of NODE_ENV=production", async () => {
    vi.stubEnv("NODE_ENV", "preview");

    const response = await GET(new NextRequest("https://preview.wallie.cc/auth/codex"));

    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(new RegExp(`^${CODEX_OAUTH_COOKIE}=`));
    expect(setCookie).toMatch(/;\s*Secure(;|$)/i);
    expect(setCookie).toMatch(/;\s*HttpOnly(;|$)/i);
    expect(setCookie).toMatch(/;\s*SameSite=lax/i);

    vi.unstubAllEnvs();
  });

  it("omits Secure only when WALLIE_ALLOW_INSECURE_COOKIES=1 is explicitly set", async () => {
    process.env.WALLIE_ALLOW_INSECURE_COOKIES = "1";

    const response = await GET(new NextRequest("http://localhost:3000/auth/codex"));

    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(new RegExp(`^${CODEX_OAUTH_COOKIE}=`));
    expect(setCookie).not.toMatch(/;\s*Secure(;|$)/i);
  });
});
