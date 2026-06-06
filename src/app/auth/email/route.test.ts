import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emailCodeAuthCookieName } from "@/lib/auth-email-code-cookie";

const mocked = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  signInWithOtp: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));

import { POST } from "@/app/auth/email/route";

function createEmailRequest(input: { email: string; next?: string }) {
  const body = new FormData();

  body.set("email", input.email);
  body.set("next", input.next ?? "/");

  return new NextRequest("http://localhost:3000/auth/email", {
    body,
    method: "POST",
  });
}

describe("POST /auth/email", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://wallie.dev");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mocked.createSupabaseServerClient.mockReset();
    mocked.signInWithOtp.mockReset();
  });

  it("redirects back to login with check-email status and stores normalized email in a cookie", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue({
      auth: {
        signInWithOtp: mocked.signInWithOtp,
      },
    });
    mocked.signInWithOtp.mockResolvedValue({ error: null });

    const response = await POST(
      createEmailRequest({
        email: "Owner@Example.com",
        next: "/w/acme",
      }),
    );

    expect(mocked.signInWithOtp).toHaveBeenCalledWith({
      email: "owner@example.com",
      options: {
        emailRedirectTo: "https://wallie.dev/auth/confirm?next=%2Fw%2Facme",
      },
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?next=%2Fw%2Facme&status=check_email",
    );
    expect(response.headers.get("set-cookie")).toContain(
      `${emailCodeAuthCookieName}=owner%40example.com`,
    );
  });

  it("keeps the email code cookie available when resend fails", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue({
      auth: {
        signInWithOtp: mocked.signInWithOtp,
      },
    });
    mocked.signInWithOtp.mockResolvedValue({
      error: { message: "Email rate limit exceeded" },
    });

    const response = await POST(
      createEmailRequest({
        email: "Owner@Example.com",
        next: "/w/acme",
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?next=%2Fw%2Facme&error=email_sign_in_failed",
    );
    expect(response.headers.get("set-cookie")).toContain(
      `${emailCodeAuthCookieName}=owner%40example.com`,
    );
  });
});
