import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  decryptSecretValue: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
  verifyLinearApiKey: vi.fn(),
}));

vi.mock("@/lib/linear/client", () => ({
  verifyLinearApiKey: mocked.verifyLinearApiKey,
}));

vi.mock("@/lib/secrets/crypto", () => ({
  decryptSecretValue: mocked.decryptSecretValue,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

import { POST } from "./route";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

function request(workspaceId = WORKSPACE_ID) {
  return new NextRequest(`http://localhost/api/linear/test-connection?workspaceId=${workspaceId}`, {
    method: "POST",
  });
}

function grantAccess() {
  mocked.requireWorkspaceAccessById.mockResolvedValue({
    context: {
      currentMember: { id: "member-1", is_active: true, kind: "human", role: "owner" },
      supabase: {},
      user: { id: "user-1" },
      workspace: { id: WORKSPACE_ID, name: "Wallie", slug: "wallie" },
    },
    ok: true,
  });
}

function setupSecretRow(row: { encrypted_value: string } | null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null });
  const eqKey = vi.fn(() => ({ maybeSingle }));
  const eqWorkspace = vi.fn(() => ({ eq: eqKey }));
  const select = vi.fn(() => ({ eq: eqWorkspace }));
  const from = vi.fn(() => ({ select }));
  mocked.createSupabaseAdminClient.mockReturnValue({ from });
  return { eqKey, eqWorkspace, from, maybeSingle, select };
}

describe("POST /api/linear/test-connection", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("tests the stored Linear key without returning secret material", async () => {
    grantAccess();
    setupSecretRow({ encrypted_value: "encrypted-key" });
    mocked.decryptSecretValue.mockReturnValue("lin_api_plaintext");
    mocked.verifyLinearApiKey.mockResolvedValue({ ok: true });

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocked.decryptSecretValue).toHaveBeenCalledWith("encrypted-key");
    expect(mocked.verifyLinearApiKey).toHaveBeenCalledWith("lin_api_plaintext");
  });

  it("returns a missing-key state when LINEAR_API_KEY is absent", async () => {
    grantAccess();
    setupSecretRow(null);

    const response = await POST(request());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Set LINEAR_API_KEY in workspace secrets first.",
    });
    expect(mocked.verifyLinearApiKey).not.toHaveBeenCalled();
  });

  it("returns a failed-test state when Linear rejects the key", async () => {
    grantAccess();
    setupSecretRow({ encrypted_value: "encrypted-key" });
    mocked.decryptSecretValue.mockReturnValue("lin_api_plaintext");
    mocked.verifyLinearApiKey.mockResolvedValue({
      error: "Linear API key invalid.",
      ok: false,
    });

    const response = await POST(request());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Linear API key invalid." });
  });
});
