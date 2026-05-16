import { describe, expect, it } from "vitest";

import {
  normalizeNextPath,
  resolveAuthenticatedHomePath,
  workspaceLoginRedirectPath,
} from "@/lib/auth";

describe("auth helpers", () => {
  it("normalizes safe relative redirect targets", () => {
    expect(normalizeNextPath("/w/northwind-labs/issues?sort=updated")).toBe(
      "/w/northwind-labs/issues?sort=updated",
    );
    expect(normalizeNextPath("https://wallie.cc/onboarding/workspace")).toBe(
      "/onboarding/workspace",
    );
  });

  it("falls back on unsafe or invalid redirect targets", () => {
    expect(normalizeNextPath("https://example.com/phish")).toBe("/");
    expect(normalizeNextPath("javascript:alert(1)")).toBe("/");
    expect(normalizeNextPath(undefined, "/login")).toBe("/login");
  });

  it("builds the workspace login redirect path", () => {
    expect(workspaceLoginRedirectPath("northwind-labs")).toBe("/w/northwind-labs");
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
