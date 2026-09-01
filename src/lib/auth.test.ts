import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureProfileForUser,
  getWorkspaceBySlugForUser,
  isWorkspaceInvitationPath,
  loadOwnProfileDisplay,
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

  it("recognizes redirects that must defer profile seeding until invitation acceptance", () => {
    expect(isWorkspaceInvitationPath("/invite/raw-token")).toBe(true);
    expect(isWorkspaceInvitationPath("/invite/raw-token?source=email")).toBe(true);
    expect(isWorkspaceInvitationPath("/invite")).toBe(false);
    expect(isWorkspaceInvitationPath("/w/northwind-labs")).toBe(false);
  });

  it("delegates profile seeding to the conflict-safe profile RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: {}, error: null });

    await ensureProfileForUser(
      { rpc } as never,
      {
        email: "ada@example.com",
        id: "user-1",
        user_metadata: {
          full_name: "Ada Lovelace",
          picture: "https://example.com/ada.png",
        },
      } as never,
    );

    expect(rpc).toHaveBeenCalledWith("ensure_own_profile", {
      actor_avatar_url: "https://example.com/ada.png",
      actor_email: "ada@example.com",
      actor_full_name: "Ada Lovelace",
    });
  });

  it("reads the signed-in user's profile photo from profiles", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: { avatar_url: "https://cdn.example.com/ada.png" },
      error: null,
    });
    const eq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));

    await expect(loadOwnProfileDisplay({ from } as never, "user-1")).resolves.toEqual({
      avatarUrl: "https://cdn.example.com/ada.png",
      found: true,
    });
    expect(from).toHaveBeenCalledWith("profiles");
    expect(select).toHaveBeenCalledWith("avatar_url");
    expect(eq).toHaveBeenCalledWith("id", "user-1");
  });

  it("returns a null photo when the profile row is missing", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle }),
        }),
      }),
    };

    await expect(loadOwnProfileDisplay(supabase as never, "user-1")).resolves.toEqual({
      avatarUrl: null,
      found: false,
    });
  });

  it("keeps found true when the profile row exists without a photo", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: { avatar_url: null },
      error: null,
    });
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle }),
        }),
      }),
    };

    await expect(loadOwnProfileDisplay(supabase as never, "user-1")).resolves.toEqual({
      avatarUrl: null,
      found: true,
    });
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
