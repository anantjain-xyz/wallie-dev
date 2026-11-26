import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emailCodeAuthCookieName, emailSignInRetryCookieName } from "@/lib/auth-email-code-cookie";
import {
  createSessionSearchContinuation,
  readSessionSearchContinuation,
  sessionSearchCookieName,
} from "@/lib/session-search-continuation";

const mocked = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  signInWithOtp: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));

import { POST } from "@/app/auth/email/route";

function createEmailRequest(input: { email: string; next?: string; cookie?: string }) {
  const body = new FormData();

  body.set("email", input.email);
  body.set("next", input.next ?? "/");

  return new NextRequest("http://localhost:3000/auth/email", {
    body,
    headers: input.cookie
      ? { cookie: `${sessionSearchCookieName}=${encodeURIComponent(input.cookie)}` }
      : undefined,
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

  it("rotates the same-browser search marker without sending the filter to the email provider", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue({
      auth: { signInWithOtp: mocked.signInWithOtp },
    });
    mocked.signInWithOtp.mockResolvedValue({ error: null });
    const attempt = createSessionSearchContinuation(
      "/w/acme/sessions?scope=all",
      "private phrase",
    )!;
    const response = await POST(
      createEmailRequest({
        email: "member@example.test",
        next: attempt.next + "&q=other+private+phrase",
        cookie: attempt.cookie,
      }),
    );
    const sent = new URL(mocked.signInWithOtp.mock.calls[0]![0].options.emailRedirectTo);
    const login = new URL(response.headers.get("location")!);
    const next = sent.searchParams.get("next")!;
    expect(sent.href).not.toContain("private");
    expect(next).not.toContain("q=");
    expect(next).not.toBe(attempt.next);
    expect(login.searchParams.get("next")).toBe(next);
    expect(
      readSessionSearchContinuation(next, response.cookies.get(sessionSearchCookieName)?.value),
    ).toBe("private phrase");
    expect(readSessionSearchContinuation(next, attempt.cookie)).toBeNull();
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

  it("keeps the editable retry address without starting a pending code request when send fails", async () => {
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
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/w/acme");
    expect(location.searchParams.get("error")).toBe("email_sign_in_failed");
    expect(location.searchParams.get("retry")).toBeTruthy();
    expect(location.href).not.toContain("example.com");
    expect(response.cookies.get(emailSignInRetryCookieName)?.value).toBe(
      `${location.searchParams.get("retry")}:owner@example.com`,
    );
    expect(response.cookies.get(emailCodeAuthCookieName)).toBeUndefined();
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).not.toContain("Email rate limit exceeded");
  });
});
