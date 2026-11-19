import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

const { requireWorkspaceAccessById } = vi.hoisted(() => ({ requireWorkspaceAccessById: vi.fn() }));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById }));

const workspaceId = "57300000-0000-4000-8000-000000000010";
const factoryId = "57300000-0000-4000-8000-000000000011";
const anchor = {
  occurredAt: "2026-11-19T11:00:00.000123+00:00",
  artifactId: "57300000-0000-4000-8000-000000000012",
};
const projection = { items: [], counts: { review: 0, clarification: 0 }, next: anchor };
const rpc = vi.fn();
const supabase = { rpc };

function request(query = "") {
  return new Request(`https://wallie.test/api/factories/inbox?workspaceId=${workspaceId}${query}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  requireWorkspaceAccessById.mockResolvedValue({
    ok: true,
    context: { supabase, workspace: { id: workspaceId } },
  });
  rpc.mockResolvedValue({ data: projection, error: null });
});

describe("Inbox read route", () => {
  it("serves the scoped projection privately and round-trips an exact keyset cursor", async () => {
    const response = await GET(request(`&factoryId=${factoryId}`));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const { nextCursor } = await response.json();
    const next = await GET(request(`&factoryId=${factoryId}&cursor=${nextCursor}`));

    expect(next.status).toBe(200);
    expect(requireWorkspaceAccessById).toHaveBeenCalledWith(workspaceId);
    expect(rpc).toHaveBeenLastCalledWith("get_factory_inbox", {
      p_workspace_id: workspaceId,
      p_factory_id: factoryId,
      p_before_at: anchor.occurredAt,
      p_before_artifact_id: anchor.artifactId,
    });
  });

  it.each(["&factoryId=unknown", `&factoryId=${factoryId}&factoryId=${factoryId}`])(
    "rejects a malformed or ambiguous scope",
    async (query) => {
      const response = await GET(request(query));
      expect(response.status).toBe(400);
      expect(requireWorkspaceAccessById).not.toHaveBeenCalled();
    },
  );

  it("rejects an invalid cursor before querying the Inbox projection", async () => {
    const response = await GET(request("&cursor=malformed"));
    expect(response.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns a noncacheable 404 for an inaccessible factory without counts", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    const response = await GET(request(`&factoryId=${factoryId}`));
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "Inbox not found." });
  });
});
