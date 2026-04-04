import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  ensureProfileForUser: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
  resolveAuthenticatedHomePath: vi.fn(),
  verifyOtp: vi.fn(),
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

import { GET } from "@/app/auth/confirm/route";

describe("GET /auth/confirm", () => {
  afterEach(() => {
    mocked.exchangeCodeForSession.mockReset();
    mocked.verifyOtp.mockReset();
    mocked.createSupabaseServerClient.mockReset();
    mocked.getSupabaseUserOrNull.mockReset();
    mocked.ensureProfileForUser.mockReset();
    mocked.resolveAuthenticatedHomePath.mockReset();
  });

  it("exchanges PKCE codes from magic-link redirects", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue({
      auth: {
        exchangeCodeForSession: mocked.exchangeCodeForSession,
        verifyOtp: mocked.verifyOtp,
      },
    });
    mocked.exchangeCodeForSession.mockResolvedValue({ error: null });
    mocked.getSupabaseUserOrNull.mockResolvedValue(null);
    mocked.resolveAuthenticatedHomePath.mockResolvedValue("/onboarding/workspace");

    const response = await GET(
      new NextRequest("http://localhost:3000/auth/confirm?code=test-code&next=%2F"),
    );

    expect(mocked.exchangeCodeForSession).toHaveBeenCalledWith("test-code");
    expect(mocked.verifyOtp).not.toHaveBeenCalled();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/onboarding/workspace");
  });

  it("verifies token hashes when the redirect includes an OTP payload", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue({
      auth: {
        exchangeCodeForSession: mocked.exchangeCodeForSession,
        verifyOtp: mocked.verifyOtp,
      },
    });
    mocked.verifyOtp.mockResolvedValue({ error: null });
    mocked.getSupabaseUserOrNull.mockResolvedValue(null);

    const response = await GET(
      new NextRequest(
        "http://localhost:3000/auth/confirm?token_hash=test-hash&type=email&next=%2Fw%2Facme%2Fissues",
      ),
    );

    expect(mocked.verifyOtp).toHaveBeenCalledWith({
      token_hash: "test-hash",
      type: "email",
    });
    expect(mocked.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/w/acme/issues");
  });

  it("redirects back to login when the confirmation link is missing auth parameters", async () => {
    const response = await GET(new NextRequest("http://localhost:3000/auth/confirm?next=%2F"));

    expect(mocked.createSupabaseServerClient).not.toHaveBeenCalled();
    expect(mocked.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(mocked.verifyOtp).not.toHaveBeenCalled();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?error=auth_confirmation_failed&next=%2F",
    );
  });
});
