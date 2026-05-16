import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  permanentRedirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("next/navigation", () => ({
  permanentRedirect: mocked.permanentRedirect,
}));

import SignupPage from "@/app/signup/page";

describe("/signup page", () => {
  it("permanently redirects to the unified login entry", async () => {
    await expect(
      SignupPage({
        searchParams: Promise.resolve({
          next: "/w/foo",
        }),
      }),
    ).rejects.toThrow("redirect:/login?next=%2Fw%2Ffoo");
  });

  it("preserves auth feedback query params on redirect", async () => {
    await expect(
      SignupPage({
        searchParams: Promise.resolve({
          error: "oauth_sign_in_failed",
          next: "/w/foo",
          status: "check_email",
        }),
      }),
    ).rejects.toThrow(
      "redirect:/login?next=%2Fw%2Ffoo&error=oauth_sign_in_failed&status=check_email",
    );
  });
});
