import { createClient } from "@supabase/supabase-js";
import { beforeEach, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";
import { GET } from "./route";

const { access } = vi.hoisted(() => ({ access: vi.fn() }));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: access }));

const workspaceId = "00000000-0000-4000-8000-000000000001";
const factoryId = "00000000-0000-4000-8000-000000000002";
const sessionId = "00000000-0000-4000-8000-000000000003";
const dbFetch = vi.fn<(url: string) => Promise<Response>>(async () =>
  Response.json([
    { id: sessionId, number: 42, title: "Release checks", factories: { name: "Web" } },
  ]),
);
const supabase = createClient<Database>("https://database.example.test", "test-key", {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: (input) => dbFetch(String(input)) },
});

function request(q: string, factory = factoryId) {
  return GET(
    new Request(
      `https://wallie.test/api/workspaces/${workspaceId}/runs/session-options?${new URLSearchParams({ factory, q })}`,
    ),
    { params: Promise.resolve({ workspaceId }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  access.mockResolvedValue({ ok: true, context: { supabase, workspace: { id: workspaceId } } });
});

it.each([
  ["#42", "number", "eq.42"],
  ["Release", "title", "ilike.%Release%"],
])(
  "searches by %s in the authorized factory and returns only dropdown metadata",
  async (q, column, filter) => {
    const response = await request(q);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual([
      { id: sessionId, label: "#42 Release checks" },
    ]);
    expect(access).toHaveBeenCalledWith(workspaceId);
    const url = new URL(dbFetch.mock.calls[0][0]);
    expect(url.pathname).toBe("/rest/v1/sessions");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      workspace_id: `eq.${workspaceId}`,
      factory_id: `eq.${factoryId}`,
      execution_purpose: "eq.production",
      [column]: filter,
      limit: "12",
    });
  },
);

it("returns factory names in the all-accessible-factories search", async () => {
  const response = await request("#42", "all");
  await expect(response.json()).resolves.toEqual([
    { id: sessionId, label: "#42 Release checks", factoryName: "Web" },
  ]);
  expect(new URL(dbFetch.mock.calls[0][0]).searchParams.has("factory_id")).toBe(false);
});

it("does not query sessions after access is denied or for invalid search parameters", async () => {
  access.mockResolvedValueOnce({ ok: false, status: 404, error: "Workspace not found." });
  expect((await request("#42")).status).toBe(404);
  expect((await request("#42", "invalid")).status).toBe(400);
  expect(dbFetch).not.toHaveBeenCalled();
});
