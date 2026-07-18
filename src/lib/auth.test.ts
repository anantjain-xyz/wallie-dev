import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getWorkspaceBySlugForUser,
  normalizeNextPath,
  resolveAuthenticatedHomePath,
  workspaceLoginRedirectPath,
} from "@/lib/auth";

describe("auth helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("normalizes safe relative redirect targets", () => {
    expect(normalizeNextPath("/w/northwind-labs/issues?sort=updated")).toBe(
      "/w/northwind-labs/issues?sort=updated",
    );
    expect(normalizeNextPath("https://wallie.dev/onboarding/workspace")).toBe(
      "/onboarding/workspace",
    );
  });

  it("uses the configured app origin for absolute redirect targets", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://wallie.dev");

    expect(normalizeNextPath("https://wallie.dev/onboarding/workspace")).toBe(
      "/onboarding/workspace",
    );
    expect(normalizeNextPath("https://example.com/onboarding/workspace")).toBe("/");
  });

  it("falls back on unsafe or invalid redirect targets", () => {
    expect(normalizeNextPath("https://example.com/phish")).toBe("/");
    expect(normalizeNextPath("javascript:alert(1)")).toBe("/");
    expect(normalizeNextPath(undefined, "/login")).toBe("/login");
  });

  it("builds the workspace login redirect path", () => {
    expect(workspaceLoginRedirectPath("northwind-labs")).toBe("/w/northwind-labs");
  });

  it("loads the authenticated member through the workspace lookup", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: {
        avatar_path: null,
        current_member: [{ id: "member-1", is_active: true, kind: "human", role: "member" }],
        id: "workspace-1",
        name: "Northwind Labs",
        slug: "northwind-labs",
      },
      error: null,
    });
    const query = {
      eq: vi.fn(() => query),
      maybeSingle,
      select: vi.fn(() => query),
    };
    const supabase = { from: vi.fn(() => query) };

    await expect(
      getWorkspaceBySlugForUser(supabase as never, "northwind-labs", "user-1"),
    ).resolves.toEqual({
      currentMember: { id: "member-1", is_active: true, kind: "human", role: "member" },
      workspace: {
        avatar_path: null,
        id: "workspace-1",
        name: "Northwind Labs",
        slug: "northwind-labs",
      },
    });
    expect(query.eq).toHaveBeenNthCalledWith(1, "slug", "northwind-labs");
    expect(query.eq).toHaveBeenNthCalledWith(2, "current_member.user_id", "user-1");
  });

  it("keeps signed-in home routing on the existing workspace home", async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          order: () => ({
            limit: () => ({
              maybeSingle: async () => ({
                data: {
                  id: "workspace-1",
                  name: "Northwind Labs",
                  slug: "northwind-labs",
                },
                error: null,
              }),
            }),
          }),
        }),
      }),
    };

    await expect(resolveAuthenticatedHomePath(supabase as never)).resolves.toBe(
      "/w/northwind-labs",
    );
  });
});
