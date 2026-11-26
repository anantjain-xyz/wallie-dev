import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";

import { sessionSearchCookieName } from "@/lib/session-search-continuation";

const { signOut } = vi.hoisted(() => ({ signOut: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { signOut } }),
}));

import { POST } from "./route";

const next = "/oauth/authorize?client_id=synthetic";

function switchAccount() {
  return new NextRequest("https://wallie.dev/auth/signout", {
    method: "POST",
    body: new URLSearchParams({ next, switchAccount: "1" }),
  });
}

beforeEach(() => {
  signOut.mockReset();
});

it("switches only this browser session before continuing back to consent", async () => {
  signOut.mockResolvedValue({ error: null });
  const response = await POST(switchAccount());
  const location = new URL(response.headers.get("location")!);
  expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
  expect(response.status).toBe(303);
  expect(location.pathname).toBe("/login");
  expect(location.searchParams.get("next")).toBe(next);
  expect(response.cookies.get(sessionSearchCookieName)).toMatchObject({ value: "", maxAge: 0 });
});

it.each(["returned", "thrown"])(
  "stops account switching on a %s provider error",
  async (method) => {
    const error = new Error("private provider details");
    if (method === "returned") signOut.mockResolvedValue({ error });
    else signOut.mockRejectedValue(error);
    const response = await POST(switchAccount());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://wallie.dev/recovery?signOut=failed");
  },
);
