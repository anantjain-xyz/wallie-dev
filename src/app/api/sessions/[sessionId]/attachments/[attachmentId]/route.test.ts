import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  createSupabaseServerClient: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));
vi.mock("@/lib/supabase/auth", () => ({ getSupabaseUserOrNull: mocked.getSupabaseUserOrNull }));

import { GET } from "./route";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000002";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000003";

function queryResult(data: unknown) {
  return {
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error: null }),
    select: vi.fn().mockReturnThis(),
  };
}

describe("GET private session attachment", () => {
  afterEach(() => vi.clearAllMocks());

  it("streams an attached image only after the RLS session lookup succeeds", async () => {
    mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-1" });
    const sessionQuery = queryResult({ id: SESSION_ID, workspace_id: WORKSPACE_ID });
    mocked.createSupabaseServerClient.mockResolvedValue({
      from: vi.fn().mockReturnValue(sessionQuery),
    });

    const attachmentQuery = queryResult({
      content_type: "image/png",
      original_filename: "design.png",
      storage_path: `${WORKSPACE_ID}/design.png`,
    });
    const download = vi.fn().mockResolvedValue({
      data: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
      error: null,
    });
    mocked.createSupabaseAdminClient.mockReturnValue({
      from: vi.fn().mockReturnValue(attachmentQuery),
      storage: { from: vi.fn().mockReturnValue({ download }) },
    });

    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ attachmentId: ATTACHMENT_ID, sessionId: SESSION_ID }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("returns not found before using the admin client for a cross-workspace session", async () => {
    mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-1" });
    mocked.createSupabaseServerClient.mockResolvedValue({
      from: vi.fn().mockReturnValue(queryResult(null)),
    });

    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ attachmentId: ATTACHMENT_ID, sessionId: SESSION_ID }),
    });

    expect(response.status).toBe(404);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });
});
