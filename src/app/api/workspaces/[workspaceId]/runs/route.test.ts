import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  RunCatalogCursorError: class extends Error {},
  RunCatalogWorkspaceUnavailableError: class extends Error {},
  loadWorkspaceRunCatalogPage: vi.fn(),
  loadWorkspaceRunCatalogItem: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
}));

vi.mock("@/features/wallie/run-catalog", () => ({
  RunCatalogCursorError: mocked.RunCatalogCursorError,
  RunCatalogWorkspaceUnavailableError: mocked.RunCatalogWorkspaceUnavailableError,
  loadWorkspaceRunCatalogPage: mocked.loadWorkspaceRunCatalogPage,
  loadWorkspaceRunCatalogItem: mocked.loadWorkspaceRunCatalogItem,
}));
vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

import {
  RunCatalogCursorError,
  RunCatalogWorkspaceUnavailableError,
} from "@/features/wallie/run-catalog";

import { GET as getRun } from "./[runId]/route";
import { GET as getCatalog } from "./route";

const WORKSPACE_ID = "a0000000-0000-4000-8000-000000000001";
const SESSION_ID = "b0000000-0000-4000-8000-000000000001";
const RUN_ID = "c0000000-0000-4000-8000-000000000001";
const STAGE_ID = "d0000000-0000-4000-8000-000000000001";
const supabase = { rpc: vi.fn() };

function context(workspaceId = WORKSPACE_ID, runId = RUN_ID) {
  return { params: Promise.resolve({ workspaceId, runId }) };
}

function request(query = "") {
  return new Request(`http://localhost/api/workspaces/${WORKSPACE_ID}/runs${query}`);
}

function grantAccess() {
  mocked.requireWorkspaceAccessById.mockResolvedValue({
    ok: true,
    context: {
      supabase,
      currentMember: { id: "member", role: "member", kind: "human", is_active: true },
      workspace: { id: WORKSPACE_ID, slug: "wallie" },
    },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  grantAccess();
});

describe("GET /api/workspaces/[workspaceId]/runs", () => {
  it("uses validated filters and the authorized client and canonical workspace", async () => {
    const page = { runs: [{ id: RUN_ID }], nextCursor: null };
    mocked.loadWorkspaceRunCatalogPage.mockResolvedValue(page);

    const response = await getCatalog(
      request(`?limit=15&sessionId=${SESSION_ID}&status=error&provider=codex&stageId=${STAGE_ID}`),
      context(WORKSPACE_ID.toUpperCase()),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual(page);
    expect(mocked.requireWorkspaceAccessById).toHaveBeenCalledWith(WORKSPACE_ID.toUpperCase());
    expect(mocked.loadWorkspaceRunCatalogPage).toHaveBeenCalledExactlyOnceWith({
      supabase,
      workspaceId: WORKSPACE_ID,
      workspaceSlug: "wallie",
      query: expect.objectContaining({
        limit: 15,
        sessionId: SESSION_ID,
        status: "error",
        provider: "codex",
        stageId: STAGE_ID,
      }),
    });
  });

  it.each([
    "?limit=-1",
    "?limit=not-a-number",
    "?limit=51",
    "?cursor=invalid%20cursor",
    "?offset=20",
    "?sessionId=invalid",
    "?stageId=invalid",
    "?status=not-a-status",
    "?provider=not-a-provider",
  ])("rejects malformed query %s before access or data lookup", async (query) => {
    const response = await getCatalog(request(query), context());
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocked.requireWorkspaceAccessById).not.toHaveBeenCalled();
    expect(mocked.loadWorkspaceRunCatalogPage).not.toHaveBeenCalled();
  });

  it("maps a cursor scope rejection to a generic 400", async () => {
    mocked.loadWorkspaceRunCatalogPage.mockRejectedValue(new RunCatalogCursorError());
    const response = await getCatalog(request(), context());
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "Invalid run catalog cursor." });
  });

  it("returns an empty authorized catalog without treating it as missing", async () => {
    mocked.loadWorkspaceRunCatalogPage.mockResolvedValue({ runs: [], nextCursor: null });
    const response = await getCatalog(request(), context());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ runs: [], nextCursor: null });
  });
});

describe("GET /api/workspaces/[workspaceId]/runs/[runId]", () => {
  it("returns the exact run using the authorized workspace scope", async () => {
    const run = { id: RUN_ID, sessionId: SESSION_ID };
    mocked.loadWorkspaceRunCatalogItem.mockResolvedValue(run);
    const response = await getRun(request(), context(WORKSPACE_ID.toUpperCase()));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ run });
    expect(mocked.loadWorkspaceRunCatalogItem).toHaveBeenCalledExactlyOnceWith({
      supabase,
      workspaceId: WORKSPACE_ID,
      workspaceSlug: "wallie",
      runId: RUN_ID,
    });
  });

  it("returns 404 for an absent or inaccessible run without disclosing another workspace", async () => {
    mocked.loadWorkspaceRunCatalogItem.mockResolvedValue(null);
    const response = await getRun(request(), context());
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "Run not found." });
  });

  it("rejects a malformed run id before authorizing or reading", async () => {
    const response = await getRun(request(), context(WORKSPACE_ID, "invalid"));
    expect(response.status).toBe(400);
    expect(mocked.requireWorkspaceAccessById).not.toHaveBeenCalled();
    expect(mocked.loadWorkspaceRunCatalogItem).not.toHaveBeenCalled();
  });
});

describe.each([
  { name: "catalog", get: getCatalog, load: mocked.loadWorkspaceRunCatalogPage },
  { name: "exact run", get: getRun, load: mocked.loadWorkspaceRunCatalogItem },
])("$name authorization and errors", ({ get, load }) => {
  it.each([401, 403, 404, 409])(
    "does not read data after an access denial (%s)",
    async (status) => {
      mocked.requireWorkspaceAccessById.mockResolvedValue({
        ok: false,
        status,
        error: status === 404 ? "Workspace not found." : "Workspace access denied.",
      });
      const response = await get(request(), context());
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(load).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed workspace ids before any authorization or data query", async () => {
    const response = await get(request(), context("invalid"));
    expect(response.status).toBe(400);
    expect(mocked.requireWorkspaceAccessById).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it("returns 404 when membership is revoked after the route access check", async () => {
    load.mockRejectedValue(new RunCatalogWorkspaceUnavailableError());
    const response = await get(request(), context());
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "Workspace not found." });
  });

  it.each(["authorization", "read"])("does not expose internal %s errors", async (source) => {
    const internalError = new Error("sensitive database implementation and credentials");
    if (source === "authorization") {
      mocked.requireWorkspaceAccessById.mockRejectedValue(internalError);
    } else {
      load.mockRejectedValue(internalError);
    }
    const response = await get(request(), context());
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).not.toContain(internalError.message);
  });
});
