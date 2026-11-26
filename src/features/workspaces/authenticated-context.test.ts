import { beforeEach, expect, it, vi } from "vitest";

import { WORKSPACE_RETURN_HEADER } from "@/lib/workspace-return-path";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  getWorkspace: vi.fn(),
  verifyIdentity: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("not-found");
  }),
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: mocks.redirect }));
vi.mock("@/lib/auth", async (load) => ({
  ...(await load<typeof import("@/lib/auth")>()),
  getWorkspaceBySlugForUser: mocks.getWorkspace,
}));
vi.mock("@/lib/supabase/auth", () => ({ verifySupabaseAuthIdentity: mocks.verifyIdentity }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({}) }));

import { loadAuthenticatedWorkspaceContext } from "./authenticated-context";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getWorkspace.mockResolvedValue(null);
  mocks.verifyIdentity.mockResolvedValue({ identity: null });
  mocks.headers.mockResolvedValue(new Headers());
});

it("asks for sign-in with the exact supported Sessions query state", async () => {
  const path = "/w/acme/sessions?factory=all&scope=archived&sort=oldest";
  mocks.headers.mockResolvedValue(new Headers({ [WORKSPACE_RETURN_HEADER]: path }));
  await expect(loadAuthenticatedWorkspaceContext("acme")).rejects.toThrow("redirect:");
  const next = new URL(mocks.redirect.mock.lastCall![0], "https://wallie.invalid");
  expect(next.pathname).toBe("/login");
  expect(next.searchParams.get("next")).toBe(path);
  expect(mocks.getWorkspace).not.toHaveBeenCalled();
});

it("does not derive a different workspace destination when request metadata is absent", async () => {
  await expect(loadAuthenticatedWorkspaceContext("acme")).rejects.toThrow(
    "redirect:/login?next=%2Fw%2Facme",
  );
});

it.each(["missing", "private"])("uses neutral recovery for a %s workspace", async (slug) => {
  mocks.verifyIdentity.mockResolvedValue({ identity: { id: "member" } });
  await expect(loadAuthenticatedWorkspaceContext(slug)).rejects.toThrow("not-found");
  expect(mocks.getWorkspace).toHaveBeenCalledExactlyOnceWith({}, slug, "member");
  expect(mocks.redirect).not.toHaveBeenCalled();
});
