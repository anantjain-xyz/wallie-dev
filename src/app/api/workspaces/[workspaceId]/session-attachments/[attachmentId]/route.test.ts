import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));
vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

import { DELETE } from "./route";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const MEMBER_ID = "00000000-0000-4000-8000-000000000002";
const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000003";

function setup(
  claimed: { id: string; storage_path: string } | null,
  options: {
    deleteError?: { message: string };
    storageError?: { message: string };
  } = {},
) {
  mocked.requireWorkspaceAccessById.mockResolvedValue({
    context: { currentMember: { id: MEMBER_ID }, workspace: { id: WORKSPACE_ID } },
    ok: true,
  });

  const maybeSingle = vi.fn().mockResolvedValue({ data: claimed, error: null });
  const claimBuilder = {
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    maybeSingle,
    select: vi.fn().mockReturnThis(),
  };
  const deleteBuilder = {
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockResolvedValue({ error: options.deleteError ?? null }),
  };
  const restoreBuilder = {
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockResolvedValue({ error: null }),
  };
  const update = vi.fn().mockReturnValueOnce(claimBuilder).mockReturnValue(restoreBuilder);
  const del = vi.fn().mockReturnValue(deleteBuilder);
  const from = vi.fn().mockReturnValue({ delete: del, update });
  const remove = vi.fn().mockResolvedValue({ error: options.storageError ?? null });
  const storageFrom = vi.fn().mockReturnValue({ remove });
  mocked.createSupabaseAdminClient.mockReturnValue({ from, storage: { from: storageFrom } });
  return { del, remove, update };
}

describe("DELETE pending session attachment", () => {
  afterEach(() => vi.clearAllMocks());

  it("claims and removes only an unattached upload owned by the current member", async () => {
    const calls = setup({ id: ATTACHMENT_ID, storage_path: `${WORKSPACE_ID}/image.png` });

    const response = await DELETE(new Request("http://localhost"), {
      params: Promise.resolve({ attachmentId: ATTACHMENT_ID, workspaceId: WORKSPACE_ID }),
    });

    expect(response.status).toBe(204);
    expect(calls.update).toHaveBeenCalledWith({
      delete_claimed_at: expect.any(String),
      status: "deleting",
    });
    expect(calls.remove).toHaveBeenCalledWith([`${WORKSPACE_ID}/image.png`]);
    expect(calls.del).toHaveBeenCalledOnce();
  });

  it("does not expose attached, expired, or cross-member uploads", async () => {
    setup(null);

    const response = await DELETE(new Request("http://localhost"), {
      params: Promise.resolve({ attachmentId: ATTACHMENT_ID, workspaceId: WORKSPACE_ID }),
    });

    expect(response.status).toBe(404);
  });

  it("keeps the deletion lease when metadata deletion fails after storage succeeds", async () => {
    const calls = setup(
      { id: ATTACHMENT_ID, storage_path: `${WORKSPACE_ID}/image.png` },
      { deleteError: { message: "database down" } },
    );

    const response = await DELETE(new Request("http://localhost"), {
      params: Promise.resolve({ attachmentId: ATTACHMENT_ID, workspaceId: WORKSPACE_ID }),
    });

    expect(response.status).toBe(500);
    expect(calls.remove).toHaveBeenCalledOnce();
    expect(calls.update).toHaveBeenCalledTimes(1);
  });
});
