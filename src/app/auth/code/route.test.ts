import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { emailCodeAuthCookieName } from "@/lib/auth-email-code-cookie";

const mocked = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  ensureProfileForUser: vi.fn(),
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

import { POST } from "@/app/auth/code/route";

function createCodeRequest(input: { email: string; next?: string; token: string }) {
  const body = new FormData();

  body.set("next", input.next ?? "/");
  body.set("token", input.token);

  return new NextRequest("http://localhost:3000/auth/code", {
    body,
    headers: {
      cookie: `${emailCodeAuthCookieName}=${input.email}`,
    },
    method: "POST",
  });
}

function createDigitCodeRequest(input: { digits: string[]; email: string; next?: string }) {
  const body = new FormData();

  body.set("next", input.next ?? "/");

  for (const digit of input.digits) {
    body.append("tokenDigit", digit);
  }

  return new NextRequest("http://localhost:3000/auth/code", {
    body,
    headers: {
      cookie: `${emailCodeAuthCookieName}=${input.email}`,
    },
    method: "POST",
  });
}

describe("POST /auth/code", () => {
  afterEach(() => {
    mocked.createSupabaseServerClient.mockReset();
    mocked.ensureProfileForUser.mockReset();
    mocked.getSupabaseUserOrNull.mockReset();
    mocked.resolveAuthenticatedHomePath.mockReset();
    mocked.verifyOtp.mockReset();
  });

  it("verifies email OTP codes and redirects to the requested path", async () => {
    const user = { id: "user-123" };

    mocked.createSupabaseServerClient.mockResolvedValue({
      auth: {
        verifyOtp: mocked.verifyOtp,
      },
    });
    mocked.verifyOtp.mockResolvedValue({ error: null });
    mocked.getSupabaseUserOrNull.mockResolvedValue(user);

    const response = await POST(
      createCodeRequest({
        email: "Owner@Example.com",
        next: "/w/acme",
        token: "526316",
      }),
    );

    expect(mocked.verifyOtp).toHaveBeenCalledWith({
      email: "owner@example.com",
      token: "526316",
      type: "email",
    });
    expect(mocked.ensureProfileForUser).toHaveBeenCalledWith(expect.anything(), user);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/w/acme");
    expect(response.headers.get("set-cookie")).toContain(`${emailCodeAuthCookieName}=;`);
  });

  it("accepts pasted codes with spaces", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue({
      auth: {
        verifyOtp: mocked.verifyOtp,
      },
    });
    mocked.verifyOtp.mockResolvedValue({ error: null });
    mocked.getSupabaseUserOrNull.mockResolvedValue(null);
    mocked.resolveAuthenticatedHomePath.mockResolvedValue("/onboarding/workspace");

    const response = await POST(
      createCodeRequest({
        email: "owner@example.com",
        token: "526 316",
      }),
    );

    expect(mocked.verifyOtp).toHaveBeenCalledWith({
      email: "owner@example.com",
      token: "526316",
      type: "email",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/onboarding/workspace");
  });

  it("accepts codes submitted as separate OTP digits", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue({
      auth: {
        verifyOtp: mocked.verifyOtp,
      },
    });
    mocked.verifyOtp.mockResolvedValue({ error: null });
    mocked.getSupabaseUserOrNull.mockResolvedValue(null);
    mocked.resolveAuthenticatedHomePath.mockResolvedValue("/onboarding/workspace");

    const response = await POST(
      createDigitCodeRequest({
        digits: ["5", "2", "6", "3", "1", "6"],
        email: "owner@example.com",
      }),
    );

    expect(mocked.verifyOtp).toHaveBeenCalledWith({
      email: "owner@example.com",
      token: "526316",
      type: "email",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/onboarding/workspace");
  });

  it("keeps malformed codes on the login page", async () => {
    const response = await POST(
      createCodeRequest({
        email: "owner@example.com",
        next: "/w/acme",
        token: "123",
      }),
    );

    expect(mocked.createSupabaseServerClient).not.toHaveBeenCalled();
    expect(mocked.verifyOtp).not.toHaveBeenCalled();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?next=%2Fw%2Facme&error=email_code_failed",
    );
    expect(response.headers.get("set-cookie")).toContain(
      `${emailCodeAuthCookieName}=owner%40example.com`,
    );
  });

  it("keeps rejected codes on the login page", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue({
      auth: {
        verifyOtp: mocked.verifyOtp,
      },
    });
    mocked.verifyOtp.mockResolvedValue({
      error: { message: "Token has expired or is invalid" },
    });

    const response = await POST(
      createCodeRequest({
        email: "owner@example.com",
        next: "/w/acme",
        token: "526316",
      }),
    );

    expect(mocked.verifyOtp).toHaveBeenCalled();
    expect(mocked.getSupabaseUserOrNull).not.toHaveBeenCalled();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?next=%2Fw%2Facme&error=email_code_failed",
    );
    expect(response.headers.get("set-cookie")).toContain(
      `${emailCodeAuthCookieName}=owner%40example.com`,
    );
  });
});
