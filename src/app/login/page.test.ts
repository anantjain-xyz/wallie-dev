import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

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

vi.mock("@/components/auth/auth-entry-panel", () => ({
  AuthEntryPanel: () => null,
}));

vi.mock("@/components/auth/splash-shell", () => ({
  SplashShell: ({ children }: { children: ReactNode }) => children,
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
});
