import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  cookies: vi.fn(),
  createSupabaseServerClient: vi.fn(),
  ensureProfileForUser: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
  resolveAuthenticatedHomePath: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: mocked.redirect,
}));

vi.mock("next/headers", () => ({
  cookies: mocked.cookies,
}));

vi.mock("@/lib/auth", () => ({
  ensureProfileForUser: mocked.ensureProfileForUser,
  isWorkspaceInvitationPath: (path: string) => path.startsWith("/invite/"),
  normalizeNextPath: (value: string | null | undefined) => value || "/",
  resolveAuthenticatedHomePath: mocked.resolveAuthenticatedHomePath,
}));

vi.mock("@/lib/supabase/auth", () => ({
  getSupabaseUserOrNull: mocked.getSupabaseUserOrNull,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));

import LoginPage, { metadata } from "@/app/login/page";
import { emailCodeAuthCookieName, emailSignInRetryCookieName } from "@/lib/auth-email-code-cookie";

const originalVercelEnv = process.env.VERCEL_ENV;

function setupAuthenticatedUser() {
  mocked.cookies.mockResolvedValue({ get: vi.fn(() => undefined) });
  mocked.createSupabaseServerClient.mockResolvedValue({});
  mocked.getSupabaseUserOrNull.mockResolvedValue({
    email: "new@example.com",
    id: "user-1",
    user_metadata: {},
  });
  mocked.resolveAuthenticatedHomePath.mockResolvedValue("/w/acme");
}

describe("/login page", () => {
  beforeEach(() => {
    process.env.VERCEL_ENV = "production";
    mocked.cookies.mockResolvedValue({ get: vi.fn(() => undefined) });
    mocked.createSupabaseServerClient.mockResolvedValue({});
    mocked.getSupabaseUserOrNull.mockResolvedValue(null);
  });

  afterEach(() => {
    if (originalVercelEnv === undefined) {
      delete process.env.VERCEL_ENV;
    } else {
      process.env.VERCEL_ENV = originalVercelEnv;
    }

    mocked.cookies.mockReset();
    mocked.createSupabaseServerClient.mockReset();
    mocked.ensureProfileForUser.mockReset();
    mocked.getSupabaseUserOrNull.mockReset();
    mocked.redirect.mockClear();
    mocked.resolveAuthenticatedHomePath.mockReset();
  });

  it("honors invite next paths for already-authenticated users", async () => {
    setupAuthenticatedUser();

    await expect(
      LoginPage({
        searchParams: Promise.resolve({
          next: "/invite/invite-token",
        }),
      }),
    ).rejects.toThrow("redirect:/invite/invite-token");
    expect(mocked.ensureProfileForUser).not.toHaveBeenCalled();
  });

  it("keeps the authenticated home fallback for the default next path", async () => {
    setupAuthenticatedUser();

    await expect(
      LoginPage({
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("redirect:/w/acme");
    expect(mocked.ensureProfileForUser).toHaveBeenCalledTimes(1);
  });

  it("renders the sign-in email request by default", async () => {
    const html = renderToStaticMarkup(
      await LoginPage({
        searchParams: Promise.resolve({}),
      }),
    );

    expect(html).toContain("Send sign-in email");
    expect(html).toContain('name="email"');
    expect(html).toContain("you@company.com");
    expect(html).toContain("Sign in to Wallie");
    expect(html).toContain(
      "After you sign in, Wallie opens your workspace or asks you to create one.",
    );
    expect(html).toContain('id="main-content" tabindex="-1"');
    expect(html).toContain("data-wallie-mark");
    expect(html).not.toContain("wallie-logo-minimal.png");
    expect(html).not.toContain('aria-label="Wallie home"');
    expect((metadata.title as { absolute: string }).absolute).toBe("Sign in · Wallie");
  });

  it("renders auth feedback and the OTP form after requesting a code", async () => {
    mocked.cookies.mockResolvedValue({
      get: vi.fn(() => ({ value: "owner@example.com" })),
    });

    const html = renderToStaticMarkup(
      await LoginPage({
        searchParams: Promise.resolve({
          next: "/w/acme",
          status: "check_email",
        }),
      }),
    );

    expect(html).toContain("Open the sign-in link in your email, or enter the 6-digit code below.");
    expect(html).toMatch(/<h1[^>]*>Check your email<\/h1>/);
    expect(html).toContain("Verify code");
    expect(html).toContain('name="next" value="/w/acme"');
    expect(html).toContain('href="/login?next=%2Fw%2Facme"');
    expect(html).not.toContain("owner@example.com");
  });

  it("only fills the editable address after that email send failed", async () => {
    mocked.cookies.mockResolvedValue({
      get: (name: string) =>
        name === emailSignInRetryCookieName
          ? { value: "retry-attempt:Retry@Example.Test" }
          : name === emailCodeAuthCookieName
            ? { value: "old@example.test" }
            : undefined,
    });
    const html = await LoginPage({
      searchParams: Promise.resolve({ error: "email_sign_in_failed", retry: "retry-attempt" }),
    });
    expect(renderToStaticMarkup(html)).toContain('value="retry@example.test"');
    expect(renderToStaticMarkup(html)).not.toContain("old@example.test");
    expect(
      renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) })),
    ).not.toContain("retry@example.test");
    const anotherAttempt = await LoginPage({
      searchParams: Promise.resolve({ error: "email_sign_in_failed", retry: "another-attempt" }),
    });
    expect(renderToStaticMarkup(anotherAttempt)).not.toContain("retry@example.test");
  });
});
