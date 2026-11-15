import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  loadRunTranscript: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
  RunTranscriptCursorError: class extends Error {},
  RunTranscriptResetError: class extends Error {},
}));
vi.mock("@/features/wallie/run-transcript", () => ({
  loadRunTranscript: mocked.loadRunTranscript,
  RunTranscriptCursorError: mocked.RunTranscriptCursorError,
  RunTranscriptResetError: mocked.RunTranscriptResetError,
}));
vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

import { GET } from "./route";

const workspaceId = "53500000-0001-4000-8000-000000000001";
const runId = "53500000-0004-4000-8000-000000000001";
const supabase = {};
function context(workspace = workspaceId, run = runId) {
  return { params: Promise.resolve({ workspaceId: workspace, runId: run }) };
}
function request(query = "") {
  return new Request(
    `http://localhost/api/workspaces/${workspaceId}/runs/${runId}/transcript${query}`,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  mocked.requireWorkspaceAccessById.mockResolvedValue({
    ok: true,
    context: { supabase, workspace: { id: workspaceId } },
  });
  mocked.loadRunTranscript.mockResolvedValue({
    runId,
    runStatus: "canceled",
    mode: "events",
    entries: [],
    newerCursor: "cursor",
  });
});

describe("GET exact run transcript", () => {
  it("uses the authorized user client and exact canonical workspace/run", async () => {
    const response = await GET(request("?cursor=abc&direction=newer&limit=50"), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocked.loadRunTranscript).toHaveBeenCalledExactlyOnceWith({
      supabase,
      workspaceId,
      runId,
      query: { cursor: "abc", direction: "newer", limit: 50 },
    });
    expect(await response.json()).toMatchObject({ runStatus: "canceled", entries: [] });
  });
  it("allows a default initial newest window", async () => {
    expect((await GET(request(), context())).status).toBe(200);
    expect(mocked.loadRunTranscript).toHaveBeenCalledWith(expect.objectContaining({ query: {} }));
  });
  it.each([
    "?limit=51",
    "?limit=0",
    "?attemptCount=1",
    "?mode=legacy",
    "?offset=5",
    "?direction=newer",
    "?direction=invalid",
    "?cursor=bad%20cursor",
  ])("rejects invalid query %s before authorization", async (query) => {
    const response = await GET(request(query), context());
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocked.requireWorkspaceAccessById).not.toHaveBeenCalled();
    expect(mocked.loadRunTranscript).not.toHaveBeenCalled();
  });
  it.each([
    { workspace: "invalid", run: runId },
    { workspace: workspaceId, run: "invalid" },
  ])("rejects malformed route identifiers (%j)", async ({ workspace, run }) => {
    expect((await GET(request(), context(workspace, run))).status).toBe(400);
    expect(mocked.requireWorkspaceAccessById).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404, 409])(
    "preserves access denial %i without reading bodies",
    async (status) => {
      mocked.requireWorkspaceAccessById.mockResolvedValue({
        ok: false,
        status,
        error: "Workspace unavailable.",
      });
      const response = await GET(request(), context());
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(mocked.loadRunTranscript).not.toHaveBeenCalled();
    },
  );
  it("uses the same 404 for a missing run or a mid-read revocation", async () => {
    mocked.loadRunTranscript.mockResolvedValue(null);
    const response = await GET(request(), context());
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "Run not found." });
  });
  it("rejects a cursor from another scope", async () => {
    mocked.loadRunTranscript.mockRejectedValue(new mocked.RunTranscriptCursorError());
    const response = await GET(request("?cursor=abc"), context());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid run transcript cursor." });
  });
  it("requests a fresh page when the durable source changes", async () => {
    mocked.loadRunTranscript.mockRejectedValue(new mocked.RunTranscriptResetError());
    const response = await GET(request("?cursor=abc"), context());
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ code: "transcript_reset" });
  });
  it.each(["access", "read"])("does not leak internal %s errors", async (source) => {
    const failure = new Error("private credentials and database internals");
    (source === "access"
      ? mocked.requireWorkspaceAccessById
      : mocked.loadRunTranscript
    ).mockRejectedValue(failure);
    const response = await GET(request(), context());
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).not.toContain(failure.message);
  });
});
