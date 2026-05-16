import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  ensureProfileForUser: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
  resolveAuthenticatedHomePath: vi.fn(),
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
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

import { POST } from "@/app/auth/password/route";

function createPasswordRequest(input: { email: string; next?: string; password: string }) {
  const body = new FormData();

  body.set("email", input.email);
  body.set("password", input.password);
  body.set("next", input.next ?? "/");

  return new NextRequest("http://localhost:3000/auth/password", {
    body,
    method: "POST",
  });
}

describe("POST /auth/password", () => {
  afterEach(() => {
    mocked.createSupabaseServerClient.mockReset();
    mocked.ensureProfileForUser.mockReset();
    mocked.getSupabaseUserOrNull.mockReset();
    mocked.resolveAuthenticatedHomePath.mockReset();
    mocked.signInWithPassword.mockReset();
    mocked.signUp.mockReset();
  });

  it("signs in existing dev users without attempting sign-up", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue({
      auth: {
        signInWithPassword: mocked.signInWithPassword,
        signUp: mocked.signUp,
      },
    });
    mocked.signInWithPassword.mockResolvedValue({ error: null });
    mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-123" });

    const response = await POST(
      createPasswordRequest({
        email: "Dev@Localhost.com",
        next: "/w/acme",
        password: "password",
      }),
    );

    expect(mocked.signInWithPassword).toHaveBeenCalledWith({
      email: "dev@localhost.com",
      password: "password",
    });
    expect(mocked.signUp).not.toHaveBeenCalled();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/w/acme");
  });

  it("creates a dev user when password sign-in reports invalid credentials", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue({
      auth: {
        signInWithPassword: mocked.signInWithPassword,
        signUp: mocked.signUp,
      },
    });
    mocked.signInWithPassword.mockResolvedValue({
      error: { code: "invalid_credentials", message: "Invalid login credentials" },
    });
    mocked.signUp.mockResolvedValue({ error: null });
    mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-123" });
    mocked.resolveAuthenticatedHomePath.mockResolvedValue("/onboarding/workspace");

    const response = await POST(
      createPasswordRequest({
        email: "dev@localhost.com",
        password: "password",
      }),
    );

    expect(mocked.signUp).toHaveBeenCalledWith({
      email: "dev@localhost.com",
      password: "password",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/onboarding/workspace");
  });

  it("keeps wrong-password failures on the unified login entry", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue({
      auth: {
        signInWithPassword: mocked.signInWithPassword,
        signUp: mocked.signUp,
      },
    });
    mocked.signInWithPassword.mockResolvedValue({
      error: { code: "invalid_credentials", message: "Invalid login credentials" },
    });
    mocked.signUp.mockResolvedValue({
      error: { code: "user_already_exists", message: "User already registered" },
    });

    const response = await POST(
      createPasswordRequest({
        email: "dev@localhost.com",
        next: "/w/acme",
        password: "password",
      }),
    );

    expect(mocked.signUp).toHaveBeenCalled();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?next=%2Fw%2Facme&error=password_auth_failed",
    );
  });

  it("treats sessionless fallback sign-up as failed auth", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue({
      auth: {
        signInWithPassword: mocked.signInWithPassword,
        signUp: mocked.signUp,
      },
    });
    mocked.signInWithPassword.mockResolvedValue({
      error: { code: "invalid_credentials", message: "Invalid login credentials" },
    });
    mocked.signUp.mockResolvedValue({ error: null });
    mocked.getSupabaseUserOrNull.mockResolvedValue(null);

    const response = await POST(
      createPasswordRequest({
        email: "dev@localhost.com",
        next: "/w/acme",
        password: "password",
      }),
    );

    expect(mocked.signUp).toHaveBeenCalledWith({
      email: "dev@localhost.com",
      password: "password",
    });
    expect(mocked.ensureProfileForUser).not.toHaveBeenCalled();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?next=%2Fw%2Facme&error=password_auth_failed",
    );
  });
});
