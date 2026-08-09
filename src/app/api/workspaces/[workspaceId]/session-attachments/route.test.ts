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

import { POST } from "./route";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

function grantAccess() {
  mocked.requireWorkspaceAccessById.mockResolvedValue({
    context: {
      currentMember: { id: "00000000-0000-4000-8000-000000000002" },
      workspace: { id: WORKSPACE_ID },
    },
    ok: true,
  });
}

function makePngFile(valid = true) {
  const signature = valid
    ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    : [0x00, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return new File([new Uint8Array(signature)], "screenshot.png", { type: "image/png" });
}

function makeRequest(file: File) {
  const formData = new FormData();
  formData.append("file", file);
  return new Request(`http://localhost/api/workspaces/${WORKSPACE_ID}/session-attachments`, {
    body: formData,
    method: "POST",
  });
}

function mockAdmin(
  options: { insertError?: { message: string }; uploadError?: { message: string } } = {},
) {
  const upload = vi.fn().mockResolvedValue({ error: options.uploadError ?? null });
  const remove = vi.fn().mockResolvedValue({ error: null });
  const insert = vi.fn().mockResolvedValue({ error: options.insertError ?? null });
  const from = vi.fn().mockReturnValue({ insert });
  const storageFrom = vi.fn().mockReturnValue({ remove, upload });
  mocked.createSupabaseAdminClient.mockReturnValue({ from, storage: { from: storageFrom } });
  return { from, insert, remove, storageFrom, upload };
}

describe("POST /api/workspaces/[workspaceId]/session-attachments", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("stores a validated image privately and records an expiring pending attachment", async () => {
    grantAccess();
    const calls = mockAdmin();

    const response = await POST(makeRequest(makePngFile()), {
      params: Promise.resolve({ workspaceId: WORKSPACE_ID }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      contentType: "image/png",
      fileName: "screenshot.png",
      sizeBytes: 8,
    });
    expect(calls.storageFrom).toHaveBeenCalledWith("session-attachments");
    expect(calls.upload).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^${WORKSPACE_ID}/[0-9a-f-]+\\.png$`)),
      expect.any(Buffer),
      expect.objectContaining({ contentType: "image/png", upsert: false }),
    );
    expect(calls.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        content_type: "image/png",
        original_filename: "screenshot.png",
        size_bytes: 8,
        status: "ready",
        workspace_id: WORKSPACE_ID,
      }),
    );
  });

  it("rejects a spoofed image before creating an admin client", async () => {
    grantAccess();

    const response = await POST(makeRequest(makePngFile(false)), {
      params: Promise.resolve({ workspaceId: WORKSPACE_ID }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "The file contents do not match the selected image type.",
    });
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("removes the stored object when metadata persistence fails", async () => {
    grantAccess();
    const calls = mockAdmin({ insertError: { message: "database down" } });

    const response = await POST(makeRequest(makePngFile()), {
      params: Promise.resolve({ workspaceId: WORKSPACE_ID }),
    });

    expect(response.status).toBe(500);
    expect(calls.remove).toHaveBeenCalledWith([
      expect.stringMatching(new RegExp(`^${WORKSPACE_ID}/[0-9a-f-]+\\.png$`)),
    ]);
  });
});
