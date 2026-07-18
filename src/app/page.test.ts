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
  resolveAuthenticatedHomePath: mocked.resolveAuthenticatedHomePath,
}));

vi.mock("@/lib/supabase/auth", () => ({
  getSupabaseUserOrNull: mocked.getSupabaseUserOrNull,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));

import HomePage from "@/app/page";

describe("/ page", () => {
  beforeEach(() => {
    mocked.cookies.mockReset();
    mocked.createSupabaseServerClient.mockReset();
    mocked.ensureProfileForUser.mockReset();
    mocked.getSupabaseUserOrNull.mockReset();
    mocked.redirect.mockClear();
    mocked.resolveAuthenticatedHomePath.mockReset();

    mocked.cookies.mockResolvedValue({ getAll: vi.fn(() => []) });
    mocked.createSupabaseServerClient.mockResolvedValue({});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders the public landing page for logged-out visitors", async () => {
    const html = renderToStaticMarkup(await HomePage());

    expect(html).toContain("Turn Linear issues into reviewed, staged work.");
    expect(html).toContain("Sign in to Wallie");
    expect(html).toContain("See the product walkthrough");
    expect(html).toContain("Review the artifact, then approve or return it.");
    expect(mocked.createSupabaseServerClient).not.toHaveBeenCalled();
    expect(mocked.redirect).not.toHaveBeenCalled();
  });

  it("renders the public landing page for stale auth cookies when Supabase env is missing", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    mocked.cookies.mockResolvedValue({
      getAll: vi.fn(() => [{ name: "sb-example-auth-token" }]),
    });

    const html = renderToStaticMarkup(await HomePage());

    expect(html).toContain("Turn Linear issues into reviewed, staged work.");
    expect(mocked.createSupabaseServerClient).not.toHaveBeenCalled();
    expect(mocked.redirect).not.toHaveBeenCalled();
  });

  it("keeps the authenticated workspace redirect", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    mocked.cookies.mockResolvedValue({
      getAll: vi.fn(() => [{ name: "sb-example-auth-token" }]),
    });
    const user = {
      email: "owner@example.com",
      id: "user-1",
      user_metadata: {},
    };
    mocked.getSupabaseUserOrNull.mockResolvedValue(user);
    mocked.resolveAuthenticatedHomePath.mockResolvedValue("/w/acme");

    await expect(HomePage()).rejects.toThrow("redirect:/w/acme");

    expect(mocked.ensureProfileForUser).toHaveBeenCalledWith({}, user);
  });
});
