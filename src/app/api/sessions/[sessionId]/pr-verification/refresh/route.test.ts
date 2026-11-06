import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ context: vi.fn(), rpc: vi.fn() }));
vi.mock("@/features/sessions/review/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/sessions/review/http")>()),
  loadReviewContext: mocks.context,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ rpc: mocks.rpc }),
}));

import { POST } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const invoke = (sessionId = id) =>
  POST(
    new Request("https://wallie.test/api/sessions/refresh", {
      method: "POST",
      body: JSON.stringify({ installationId: 999, repositoryId: 999, prNumber: 999 }),
    }),
    { params: Promise.resolve({ sessionId }) },
  );

beforeEach(() => {
  vi.resetAllMocks();
  mocks.context.mockResolvedValue({
    session: { id, workspace_id: workspaceId, archived_at: null },
  });
  mocks.rpc.mockResolvedValue({ data: true, error: null });
});

describe("manual PR verification refresh", () => {
  it("queues only the authenticated session identity and ignores supplied provider targets", async () => {
    const response = await invoke();
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ queued: true });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.context).toHaveBeenCalledWith(id);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("enqueue_session_pr_refresh", {
      p_workspace_id: workspaceId,
      p_session_id: id,
    });
  });

  it("requires an authorized session before using the privileged client", async () => {
    mocks.context.mockRejectedValue(new Error("not found or unauthorized"));
    expect((await invoke()).status).toBe(500);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects malformed identities, archived sessions, and missing canonical prerequisites", async () => {
    expect((await invoke("invalid")).status).toBe(400);
    expect(mocks.context).not.toHaveBeenCalled();
    mocks.context.mockResolvedValue({
      session: { id, workspace_id: workspaceId, archived_at: "now" },
    });
    expect((await invoke()).status).toBe(409);
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.context.mockResolvedValue({
      session: { id, workspace_id: workspaceId, archived_at: null },
    });
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    expect((await invoke()).status).toBe(409);
  });

  it("does not claim a failed enqueue was accepted or expose provider diagnostics", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "private database detail" } });
    const response = await invoke();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private database detail");
  });
});
