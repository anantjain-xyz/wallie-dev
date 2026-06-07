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
  normalizeNextPath: (value: string | null | undefined) => value || "/",
  resolveAuthenticatedHomePath: mocked.resolveAuthenticatedHomePath,
}));

vi.mock("@/lib/supabase/auth", () => ({
  getSupabaseUserOrNull: mocked.getSupabaseUserOrNull,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));

import LoginPage from "@/app/login/page";

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
  });

  it("keeps the authenticated home fallback for the default next path", async () => {
    setupAuthenticatedUser();

    await expect(
      LoginPage({
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("redirect:/w/acme");
  });

  it("renders the email magic-link form by default", async () => {
    const html = renderToStaticMarkup(
      await LoginPage({
        searchParams: Promise.resolve({}),
      }),
    );

    expect(html).toContain("Send magic link");
    expect(html).toContain('name="email"');
    expect(html).toContain("you@company.com");
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

    expect(html).toContain("Check your inbox for a secure sign-in link");
    expect(html).toContain("Enter 6-digit code emailed to you");
    expect(html).toContain("Continue with code");
    expect(html).toContain('href="/login?next=%2Fw%2Facme"');
  });
});
