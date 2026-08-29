import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  createSupabaseServerClient: vi.fn(),
  getPublicUrl: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
  remove: vi.fn(),
  rpc: vi.fn(),
  upload: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));
vi.mock("@/lib/supabase/auth", () => ({ getSupabaseUserOrNull: mocked.getSupabaseUserOrNull }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));

import { PATCH } from "./route";

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/profile", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
}

function formRequest(fullName: string, avatarAction: "keep" | "remove" | "replace", file?: File) {
  const body = new FormData();
  body.append("avatarAction", avatarAction);
  body.append("fullName", fullName);
  if (file) body.append("file", file);
  return new Request("http://localhost/api/profile", { body, method: "PATCH" });
}

function imageFile(name: string, type: "image/png" | "image/webp") {
  const bytes =
    type === "image/png"
      ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      : [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
  return new File([Uint8Array.from(bytes)], name, { type });
}

describe("PATCH /api/profile", () => {
  beforeEach(() => {
    mocked.createSupabaseServerClient.mockResolvedValue({});
    mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-1" });
    mocked.rpc.mockResolvedValue({
      data: [
        {
          saved_avatar_url: "https://provider.example/avatar.png",
          saved_full_name: "Anant Jain",
          superseded_avatar_path: null,
        },
      ],
      error: null,
    });
    mocked.upload.mockResolvedValue({ data: {}, error: null });
    mocked.remove.mockResolvedValue({ data: {}, error: null });
    mocked.getPublicUrl.mockReturnValue({
      data: {
        publicUrl: "https://project.supabase.co/storage/v1/object/public/profile-avatars/new.png",
      },
    });
    mocked.createSupabaseAdminClient.mockReturnValue({
      rpc: mocked.rpc,
      storage: {
        from: vi.fn().mockReturnValue({
          getPublicUrl: mocked.getPublicUrl,
          remove: mocked.remove,
          upload: mocked.upload,
        }),
      },
    });
  });

  afterEach(() => vi.clearAllMocks());

  it("requires authentication", async () => {
    mocked.getSupabaseUserOrNull.mockResolvedValue(null);
    const response = await PATCH(jsonRequest({ fullName: "Anant Jain" }));
    expect(response.status).toBe(401);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("rejects blank and oversized names", async () => {
    const blankResponse = await PATCH(jsonRequest({ fullName: "   " }));
    const longResponse = await PATCH(jsonRequest({ fullName: "a".repeat(101) }));
    expect(blankResponse.status).toBe(400);
    expect(longResponse.status).toBe(400);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("keeps legacy JSON name updates compatible", async () => {
    const response = await PATCH(jsonRequest({ fullName: "  Anant Jain  " }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      profile: { avatarUrl: "https://provider.example/avatar.png", fullName: "Anant Jain" },
    });
    expect(mocked.rpc).toHaveBeenCalledWith("update_user_profile", {
      actor_avatar_changed: false,
      actor_avatar_path: undefined,
      actor_avatar_url: undefined,
      actor_full_name: "Anant Jain",
      actor_user_id: "user-1",
    });
    expect(mocked.upload).not.toHaveBeenCalled();
  });

  it("uploads a unique replacement and removes the previous managed object", async () => {
    mocked.rpc.mockResolvedValue({
      data: [
        {
          saved_avatar_url:
            "https://project.supabase.co/storage/v1/object/public/profile-avatars/new.png",
          saved_full_name: "Anant Jain",
          superseded_avatar_path: "user-1/old.png",
        },
      ],
      error: null,
    });
    const response = await PATCH(
      formRequest("Anant Jain", "replace", imageFile("avatar.png", "image/png")),
    );
    expect(response.status).toBe(200);
    const uploadedPath = mocked.upload.mock.calls[0]?.[0] as string;
    expect(uploadedPath).toMatch(/^user-1\/[0-9a-f-]+\.png$/);
    expect(mocked.upload).toHaveBeenCalledWith(uploadedPath, expect.any(Buffer), {
      contentType: "image/png",
      upsert: false,
    });
    expect(mocked.rpc).toHaveBeenCalledWith(
      "update_user_profile",
      expect.objectContaining({
        actor_avatar_changed: true,
        actor_avatar_path: uploadedPath,
        actor_avatar_url:
          "https://project.supabase.co/storage/v1/object/public/profile-avatars/new.png",
      }),
    );
    expect(mocked.remove).toHaveBeenCalledWith(["user-1/old.png"]);
  });

  it("removes a photo without deleting an external provider object", async () => {
    mocked.rpc.mockResolvedValue({
      data: [
        {
          saved_avatar_url: null,
          saved_full_name: "Anant Jain",
          superseded_avatar_path: null,
        },
      ],
      error: null,
    });
    const response = await PATCH(formRequest("Anant Jain", "remove"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      profile: { avatarUrl: null, fullName: "Anant Jain" },
    });
    expect(mocked.rpc).toHaveBeenCalledWith(
      "update_user_profile",
      expect.objectContaining({
        actor_avatar_changed: true,
        actor_avatar_path: "",
        actor_avatar_url: "",
      }),
    );
    expect(mocked.remove).not.toHaveBeenCalled();
  });

  it("validates replacement files before touching storage", async () => {
    const missing = await PATCH(formRequest("Anant Jain", "replace"));
    const unsupported = await PATCH(
      formRequest("Anant Jain", "replace", new File(["gif"], "avatar.gif", { type: "image/gif" })),
    );
    expect(missing.status).toBe(400);
    expect(unsupported.status).toBe(400);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("rejects uploaded bytes that do not match the declared image type", async () => {
    const response = await PATCH(
      formRequest(
        "Anant Jain",
        "replace",
        new File(["not a png"], "avatar.png", { type: "image/png" }),
      ),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "The file contents do not match the selected image type.",
    });
    expect(mocked.upload).not.toHaveBeenCalled();
    expect(mocked.rpc).not.toHaveBeenCalled();
  });

  it("cleans up a new upload when database publication fails", async () => {
    mocked.rpc.mockResolvedValue({ data: null, error: new Error("database unavailable") });
    const response = await PATCH(
      formRequest("Anant Jain", "replace", imageFile("avatar.webp", "image/webp")),
    );
    expect(response.status).toBe(500);
    const uploadedPath = mocked.upload.mock.calls[0]?.[0] as string;
    expect(mocked.remove).toHaveBeenCalledWith([uploadedPath]);
  });
});
