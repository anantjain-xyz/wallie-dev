import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  afterEach(() => {
    mocked.createSupabaseServerClient.mockReset();
    mocked.signInWithOtp.mockReset();
  });

  it("redirects back to login with check-email status and normalized email", async () => {
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
        emailRedirectTo: "http://localhost:3000/auth/confirm?next=%2Fw%2Facme",
      },
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?next=%2Fw%2Facme&status=check_email&email=owner%40example.com",
    );
  });
});
