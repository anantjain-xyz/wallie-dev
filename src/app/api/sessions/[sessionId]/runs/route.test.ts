import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
  loadWallieRunPage: vi.fn(),
}));

vi.mock("@/features/wallie/server", () => ({
  loadWallieRunPage: mocked.loadWallieRunPage,
}));
vi.mock("@/lib/supabase/auth", () => ({
  getSupabaseUserOrNull: mocked.getSupabaseUserOrNull,
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));

import { GET } from "./route";

const sessionId = "00000000-0000-4000-8000-000000000001";
const workspaceId = "00000000-0000-4000-8000-000000000002";
const runId = "00000000-0000-4000-8000-000000000003";

function client(
  session: { id: string; workspace_id: string } | null = {
    id: sessionId,
    workspace_id: workspaceId,
  },
) {
  return {
    from: vi.fn((table: string) => {
      if (table === "sessions") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: session, error: null }) }),
          }),
        };
      }

      return {
        select: () => ({
          eq: async () => ({ data: [], error: null }),
        }),
      };
    }),
  };
}

describe("GET /api/sessions/[sessionId]/runs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.createSupabaseServerClient.mockResolvedValue(client());
    mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-1" });
    mocked.loadWallieRunPage.mockResolvedValue({ nextCursor: null, runs: [] });
  });

  it("returns a typed older page for a complete stable cursor", async () => {
    const createdAt = "2026-07-18T12:00:00.000Z";
    const response = await GET(
      new Request(
        `http://localhost/api/sessions/${sessionId}/runs?createdAt=${encodeURIComponent(createdAt)}&id=${runId}`,
      ),
      { params: Promise.resolve({ sessionId }) },
    );

    expect(response.status).toBe(200);
    expect(mocked.loadWallieRunPage).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { createdAt, id: runId }, sessionId }),
    );
    await expect(response.json()).resolves.toEqual({ nextCursor: null, runs: [] });
  });

  it("rejects partial cursors", async () => {
    const response = await GET(
      new Request(`http://localhost/api/sessions/${sessionId}/runs?id=${runId}`),
      { params: Promise.resolve({ sessionId }) },
    );

    expect(response.status).toBe(400);
    expect(mocked.createSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("keeps cross-workspace sessions hidden by RLS", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue(client(null));

    const response = await GET(new Request(`http://localhost/api/sessions/${sessionId}/runs`), {
      params: Promise.resolve({ sessionId }),
    });

    expect(response.status).toBe(404);
    expect(mocked.loadWallieRunPage).not.toHaveBeenCalled();
  });
});
