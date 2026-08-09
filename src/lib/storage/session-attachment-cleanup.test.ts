import { describe, expect, it, vi } from "vitest";

import { cleanupExpiredSessionAttachments } from "./session-attachment-cleanup";

function makeDeleteBuilder(error: { message: string } | null = null) {
  return {
    delete: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      is: vi.fn().mockResolvedValue({ error }),
    }),
  };
}

describe("cleanupExpiredSessionAttachments", () => {
  it("claims rows before removing their private objects and metadata", async () => {
    const remove = vi.fn().mockResolvedValue({ error: null });
    const table = makeDeleteBuilder();
    const admin = {
      from: vi.fn().mockReturnValue(table),
      rpc: vi.fn().mockResolvedValue({
        data: [
          {
            delete_claimed_at: "2026-08-09T12:00:00.000Z",
            id: "attachment-1",
            storage_path: "workspace/one.png",
          },
          {
            delete_claimed_at: "2026-08-09T12:00:00.000Z",
            id: "attachment-2",
            storage_path: "workspace/two.png",
          },
        ],
        error: null,
      }),
      storage: { from: vi.fn().mockReturnValue({ remove }) },
    };

    await expect(cleanupExpiredSessionAttachments(admin as never)).resolves.toEqual({
      claimed: 2,
      deleted: 2,
      failed: 0,
    });
    expect(admin.rpc).toHaveBeenCalledWith("claim_expired_session_attachments", {
      max_count: 100,
    });
    expect(remove).toHaveBeenCalledWith(["workspace/one.png", "workspace/two.png"]);
    expect(table.delete).toHaveBeenCalledOnce();
  });

  it("restores claims for retry when storage deletion fails", async () => {
    const remove = vi.fn().mockResolvedValue({ error: { message: "storage down" } });
    const restore = {
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      is: vi.fn().mockResolvedValue({ error: null }),
    };
    const update = vi.fn().mockReturnValue(restore);
    const admin = {
      from: vi.fn().mockReturnValue({ update }),
      rpc: vi.fn().mockResolvedValue({
        data: [
          {
            delete_claimed_at: "2026-08-09T12:00:00.000Z",
            id: "attachment-1",
            storage_path: "workspace/one.png",
          },
        ],
        error: null,
      }),
      storage: { from: vi.fn().mockReturnValue({ remove }) },
    };

    await expect(cleanupExpiredSessionAttachments(admin as never)).resolves.toEqual({
      claimed: 1,
      deleted: 0,
      failed: 1,
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        delete_claimed_at: null,
        status: "ready",
        expires_at: expect.any(String),
      }),
    );
  });
});
