import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  archiveAdditionalFactory: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  renameFactory: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
  restoreFactory: vi.fn(),
  setFactorySlug: vi.fn(),
}));

vi.mock("@/lib/factories/scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/factories/scope")>();
  return {
    ...actual,
    archiveAdditionalFactory: mocked.archiveAdditionalFactory,
    renameFactory: mocked.renameFactory,
    restoreFactory: mocked.restoreFactory,
    setFactorySlug: mocked.setFactorySlug,
  };
});
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));
vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

import { PATCH } from "./route";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const factoryId = "00000000-0000-4000-8000-000000000002";
const actorUserId = "00000000-0000-4000-8000-000000000003";
const routeUrl = `http://localhost/api/workspaces/${workspaceId}/factories/${factoryId}`;
const context = { params: Promise.resolve({ factoryId, workspaceId }) };
const admin = { rpc: vi.fn() };
const factory = {
  id: factoryId,
  name: "Payments",
  slug: "payments",
  is_default: false,
  status: "archived",
  archived_at: "2026-11-16T00:00:00Z",
  archived_reason: "Product sunset",
  created_at: "2026-11-15T00:00:00Z",
};

function patch(body: unknown) {
  return PATCH(
    new Request(routeUrl, {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    }),
    context,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocked.createSupabaseAdminClient.mockReturnValue(admin);
  mocked.requireWorkspaceAccessById.mockResolvedValue({
    ok: true,
    context: {
      currentMember: { id: "member-id", role: "owner" },
      supabase: { from: vi.fn() },
      user: { id: actorUserId },
      workspace: { id: workspaceId },
    },
  });
});

describe("factory lifecycle route", () => {
  it("archives with the actor and reason", async () => {
    mocked.archiveAdditionalFactory.mockResolvedValue(factory);
    const response = await patch({ action: "archive", reason: "Product sunset" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ factory });
    expect(mocked.archiveAdditionalFactory).toHaveBeenCalledWith(admin, {
      actorUserId,
      factoryId,
      reason: "Product sunset",
      workspaceId,
    });
  });

  it("restores an archived factory", async () => {
    mocked.restoreFactory.mockResolvedValue({ ...factory, status: "active" });
    const response = await patch({ action: "restore" });
    expect(response.status).toBe(200);
    expect(mocked.restoreFactory).toHaveBeenCalledWith(admin, {
      actorUserId,
      factoryId,
      workspaceId,
    });
  });

  it("rejects an unknown command", async () => {
    const response = await patch({ action: "delete" });
    expect(response.status).toBe(400);
    expect(mocked.archiveAdditionalFactory).not.toHaveBeenCalled();
  });

  it("maps a missing factory manager to forbidden", async () => {
    mocked.archiveAdditionalFactory.mockRejectedValue({ code: "42501" });
    const response = await patch({ action: "archive" });
    expect(response.status).toBe(403);
  });

  it("renames only the addressed factory against the displayed name", async () => {
    mocked.renameFactory.mockResolvedValue({ ...factory, name: "Payments Ops", status: "active" });
    const response = await patch({
      action: "rename",
      expectedName: "Payments",
      name: "  Payments Ops  ",
    });
    expect(response.status).toBe(200);
    expect(mocked.renameFactory).toHaveBeenCalledWith(admin, {
      actorUserId,
      expectedName: "Payments",
      factoryId,
      name: "Payments Ops",
      workspaceId,
    });
    expect((await response.json()).factory).toMatchObject({ id: factoryId, slug: "payments" });
  });

  it("does not allow a rename to change the slug or skip the name fence", async () => {
    expect((await patch({ action: "rename", name: "Payments Ops" })).status).toBe(400);
    expect(
      (
        await patch({
          action: "rename",
          expectedName: "Payments",
          name: "Payments Ops",
          slug: "new-slug",
        })
      ).status,
    ).toBe(400);
    expect(mocked.renameFactory).not.toHaveBeenCalled();
  });

  it.each([
    ["PT409", "The factory name changed. Reload and try again.", 409],
    ["P0011", "Restore the factory before renaming it.", 409],
    ["42501", "Could not rename the factory.", 403],
  ])(
    "rejects a rename with %s without disclosing a database error",
    async (code, error, status) => {
      mocked.renameFactory.mockRejectedValue({ code, message: "internal detail" });
      const response = await patch({
        action: "rename",
        expectedName: "Payments",
        name: "Payments Ops",
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
    },
  );

  it("sets only the addressed slug against the displayed value, including for the default", async () => {
    mocked.setFactorySlug.mockResolvedValue({
      ...factory,
      is_default: true,
      slug: "studio",
      status: "active",
    });
    const response = await patch({ action: "set-slug", expectedSlug: "default", slug: " studio " });
    expect(response.status).toBe(200);
    expect(mocked.setFactorySlug).toHaveBeenCalledWith(admin, {
      actorUserId,
      expectedSlug: "default",
      factoryId,
      slug: "studio",
      workspaceId,
    });
    expect((await response.json()).factory).toMatchObject({
      id: factoryId,
      is_default: true,
      name: "Payments",
      slug: "studio",
    });
  });

  it("rejects a malformed slug, edits without a fence, and extra name writes", async () => {
    const edit = { action: "set-slug", expectedSlug: "payments", slug: "studio" };
    expect((await patch({ ...edit, slug: "Not-A-Slug" })).status).toBe(400);
    expect((await patch({ ...edit, expectedSlug: undefined })).status).toBe(400);
    expect((await patch({ ...edit, name: "Studio" })).status).toBe(400);
    expect(mocked.setFactorySlug).not.toHaveBeenCalled();
  });

  it.each([
    ["23505", 409, { code: "factory_slug_taken", error: expect.stringContaining("reserved") }],
    [
      "PT409",
      409,
      { code: "factory_slug_changed", error: "The factory slug changed. Reload and try again." },
    ],
    ["P0011", 409, { error: "Restore the factory before editing its slug." }],
    ["42501", 403, { error: "Could not save the factory slug." }],
    ["P0002", 404, { error: "Could not save the factory slug." }],
  ])(
    "maps slug errors (%s) without disclosing the record or database internals",
    async (code, status, body) => {
      mocked.setFactorySlug.mockRejectedValue({ code, message: "internal detail" });
      const response = await patch({
        action: "set-slug",
        expectedSlug: "payments",
        slug: "studio",
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(body);
    },
  );

  it("does not allow the workspace default to be archived", async () => {
    mocked.archiveAdditionalFactory.mockRejectedValue({ code: "23514" });
    const response = await patch({ action: "archive" });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "The workspace default factory cannot be archived.",
    });
  });

  it("maps an already archived factory to conflict", async () => {
    mocked.archiveAdditionalFactory.mockRejectedValue({ code: "PT409" });
    const response = await patch({ action: "archive" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "The factory is already in the requested state.",
    });
  });
});
