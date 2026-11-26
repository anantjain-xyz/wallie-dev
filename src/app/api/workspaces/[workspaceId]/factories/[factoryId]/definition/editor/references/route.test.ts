import { beforeEach, expect, it, vi } from "vitest";

const { access, factory, lookup } = vi.hoisted(() => ({
  access: vi.fn(),
  factory: vi.fn(),
  lookup: vi.fn(),
}));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: access }));
vi.mock("@/lib/factory-definitions/storage", () => ({ selectFactory: factory }));
vi.mock("@/lib/factory-definitions/named-reference-catalog", () => ({
  loadNamedFactoryReferences: lookup,
}));

import { POST } from "./route";

const workspaceId = "54600000-0000-4000-8000-000000000001";
const factoryId = "54600000-0000-4000-8000-000000000002";
const context = { params: Promise.resolve({ workspaceId, factoryId }) };
const supabase = {};

function request(body: unknown) {
  return new Request("http://localhost/references", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  access.mockResolvedValue({ ok: true, context: { supabase } });
  factory.mockResolvedValue({ data: { id: factoryId }, error: null });
});

it("requires workspace operator access before looking up any reference", async () => {
  access.mockResolvedValue({
    ok: false,
    error: "Workspace admin access is required.",
    status: 403,
  });
  const response = await POST(request({ mode: "initial" }), context);
  expect(response.status).toBe(403);
  expect(access).toHaveBeenCalledWith(workspaceId, { requireManager: true });
  expect(factory).not.toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();
});

it("verifies the factory in the authorized workspace before using the session client", async () => {
  factory.mockResolvedValueOnce({ data: null, error: null });
  expect((await POST(request({ mode: "initial" }), context)).status).toBe(404);
  expect(lookup).not.toHaveBeenCalled();

  const query = { mode: "pins", ids: { context: [factoryId] } };
  lookup.mockResolvedValue({ groups: { context: { options: [] } } });
  const response = await POST(request(query), context);
  expect(response.ok).toBe(true);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(factory).toHaveBeenCalledWith(supabase, workspaceId, factoryId);
  expect(lookup).toHaveBeenCalledWith(supabase, workspaceId, factoryId, query);
});

it("does not query for mismatched or malformed reference inputs", async () => {
  const response = await POST(request({ mode: "pins", ids: { context: ["unscoped"] } }), context);
  expect(response.status).toBe(400);
  expect(lookup).not.toHaveBeenCalled();
});

it("rejects a suggestion cursor that does not match the group order", async () => {
  const response = await POST(
    request({ mode: "more", kind: "skills", after: { id: factoryId } }),
    context,
  );
  expect(response.status).toBe(400);
  expect(lookup).not.toHaveBeenCalled();
});

it("returns only allowlisted picker metadata", async () => {
  const option = { id: factoryId, label: "Read issues · tools.example.test" };
  lookup.mockResolvedValue({
    groups: { tools: { options: [{ ...option, endpoint: "https://tools.example.test/path" }] } },
  });
  const response = await POST(request({ mode: "initial" }), context);
  expect(response.ok).toBe(true);
  expect(await response.json()).toEqual({ groups: { tools: { options: [option] } } });
});
