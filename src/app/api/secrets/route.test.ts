import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { decryptSecretValue } from "@/lib/secrets/crypto";

import * as secretsRoute from "./route";

describe("/api/secrets method surface", () => {
  it("exposes only the POST mutation handler", () => {
    expect(Object.keys(secretsRoute).sort()).toEqual(["POST"]);
  });
});

describe("POST /api/secrets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("WALLIE_ENCRYPTION_KEY", "test-secret-preview-encryption-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("persists only ciphertext and a mask, and never serializes a complete short secret", async () => {
    const workspaceId = "b1b2c3d4-0001-4000-8000-000000000001";
    const memberId = "c1b2c3d4-0001-4000-8000-000000000001";
    let stored: Record<string, unknown> | undefined;
    const existingQuery = {
      eq: () => existingQuery,
      maybeSingle: async () => ({ data: null, error: null }),
    };
    mocked.requireWorkspaceAccessById.mockResolvedValue({
      ok: true,
      context: { currentMember: { id: memberId }, workspace: { id: workspaceId } },
    });
    mocked.createSupabaseAdminClient.mockReturnValue({
      from: () => ({
        select: () => existingQuery,
        upsert: (row: Record<string, unknown>) => {
          stored = row;
          return {
            select: () => ({
              single: async () => ({
                data: {
                  ...row,
                  created_at: "2026-10-10T00:00:00Z",
                  id: "secret-id",
                  updated_at: "2026-10-10T00:00:00Z",
                },
                error: null,
              }),
            }),
          };
        },
      }),
    });

    const response = await secretsRoute.POST(
      new Request("http://localhost/api/secrets", {
        body: JSON.stringify({ key: "SHORT_SECRET", value: "123456", workspaceId }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    );
    const body = await response.text();

    expect(response.status).toBe(201);
    expect(stored?.value_preview).toBe("••••");
    expect(stored?.encrypted_value).not.toContain("123456");
    expect(decryptSecretValue(stored?.encrypted_value as string)).toBe("123456");
    expect(JSON.parse(body).secret.valuePreview).toBe("••••");
    expect(body).not.toContain("123456");
    expect(body).not.toContain("encrypted_value");
  });
});
