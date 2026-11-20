import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { decryptSecretValue } from "@/lib/secrets/crypto";
import type { Database } from "@/lib/supabase/database.types";

const mocks = vi.hoisted(() => ({ access: vi.fn(), admin: vi.fn() }));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: mocks.access }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));

import { DELETE, PUT } from "./route";

const workspaceId = "60510000-0000-4000-8000-000000000001";
const actorUserId = "60510000-0000-4000-8000-000000000002";
const endpoint = `http://wallie.example.test/api/workspaces/${workspaceId}/evaluation-lane/judge-profile`;
const route = { params: Promise.resolve({ workspaceId }) };
const apiKey = "synthetic-fixture-judge-key";
const edit = {
  expectedRevision: 0,
  modelId: "vendor/fixture",
  providerRoute: "vendor",
  allowImages: false,
  allowVideo: true,
  apiKey,
};
const profile = {
  id: "60510000-0000-4000-8000-000000000003",
  workspace_id: workspaceId,
  revision: 1,
  enabled: true,
  provider: "openrouter",
  model_id: edit.modelId,
  provider_route: edit.providerRoute,
  allow_images: edit.allowImages,
  allow_video: edit.allowVideo,
  created_at: "2026-11-20T00:25:00+00:00",
};

function request(method: "PUT" | "DELETE", body: unknown) {
  return new Request(endpoint, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function fixture(handle: (rpc: string, body: unknown) => Response) {
  mocks.access.mockResolvedValue({
    ok: true,
    context: { workspace: { id: workspaceId }, user: { id: actorUserId } },
  });
  mocks.admin.mockReturnValue(
    createClient<Database>("http://supabase.example.test", "service-role-fixture", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: async (input, init) => {
          const req = new Request(input, init);
          return handle(new URL(req.url).pathname.split("/").at(-1) ?? "", await req.json());
        },
      },
    }),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("WALLIE_ENCRYPTION_KEY", "scoped-local-judge-profile-encryption-test");
});
afterEach(() => vi.unstubAllEnvs());

it("uses the verified manager identity and only sends ciphertext to the profile command", async () => {
  fixture((rpc, body) => {
    expect(rpc).toBe("configure_factory_judge_profile");
    expect(body).toMatchObject({
      p_workspace_id: workspaceId,
      p_actor_user_id: actorUserId,
      p_expected_revision: 0,
      p_provider_route: "vendor",
      p_encrypted_api_key: expect.stringMatching(/^v2\./),
    });
    expect(JSON.stringify(body)).not.toContain(apiKey);
    const { p_encrypted_api_key } = body as { p_encrypted_api_key: string };
    expect(decryptSecretValue(p_encrypted_api_key)).toBe(apiKey);
    return Response.json({ ...profile, encrypted_api_key: p_encrypted_api_key });
  });
  const response = await PUT(request("PUT", edit), route);
  expect(response.status).toBe(200);
  expect(mocks.access).toHaveBeenCalledWith(workspaceId, { requireManager: true });
  expect(await response.json()).toEqual({
    profile: {
      id: profile.id,
      revision: 1,
      enabled: true,
      provider: "openrouter",
      modelId: "vendor/fixture",
      providerRoute: "vendor",
      allowImages: false,
      allowVideo: true,
      createdAt: profile.created_at,
    },
  });
});

it("rejects nonmanagers and stale changes without copying private provider details into the response", async () => {
  fixture(() => Response.json({ code: "PT409", message: apiKey }, { status: 409 }));
  mocks.access.mockResolvedValueOnce({ ok: false, status: 403, error: "Access denied." });
  expect((await PUT(request("PUT", edit), route)).status).toBe(403);
  expect(mocks.admin).not.toHaveBeenCalled();
  const response = await DELETE(request("DELETE", { expectedRevision: 0 }), route);
  expect(response.status).toBe(409);
  expect(await response.text()).not.toContain(apiKey);
});
