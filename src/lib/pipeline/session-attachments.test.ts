import { describe, expect, it, vi } from "vitest";

import { materializeSessionAttachments } from "./session-attachments";

describe("materializeSessionAttachments", () => {
  it("downloads private image bytes and writes ordered files outside the repository", async () => {
    const download = vi.fn().mockResolvedValue({
      data: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]),
      error: null,
    });
    const admin = {
      storage: { from: vi.fn().mockReturnValue({ download }) },
    };
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const sandbox = {
      id: "sandbox-1",
      repoPath: "/workspace/repository",
      writeFile,
    };

    const result = await materializeSessionAttachments(admin as never, sandbox as never, [
      {
        contentType: "image/png",
        fileName: "design.png",
        id: "00000000-0000-4000-8000-000000000001",
        position: 1,
        storagePath: "workspace/image.png",
      },
    ]);

    expect(download).toHaveBeenCalledWith("workspace/image.png");
    expect(writeFile).toHaveBeenCalledWith(
      "/tmp/wallie-session-inputs/1-00000000-0000-4000-8000-000000000001.png",
      expect.any(Buffer),
      { mode: 0o600 },
    );
    expect(result[0]?.sandboxPath.startsWith(sandbox.repoPath)).toBe(false);
  });

  it("fails rather than silently dropping a missing image", async () => {
    const admin = {
      storage: {
        from: vi.fn().mockReturnValue({
          download: vi.fn().mockResolvedValue({ data: null, error: { message: "missing" } }),
        }),
      },
    };

    await expect(
      materializeSessionAttachments(admin as never, { writeFile: vi.fn() } as never, [
        {
          contentType: "image/png",
          fileName: "design.png",
          id: "attachment-1",
          position: 1,
          storagePath: "workspace/missing.png",
        },
      ]),
    ).rejects.toThrow("Session image 1 could not be loaded from storage.");
  });
});
