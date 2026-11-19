import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  issueFactoryOAuthCredential,
  parseFactoryOAuthCredential,
} from "@/lib/factory-oauth/credentials";

import { POST } from "./route";

const mocked = vi.hoisted(() => ({
  rpc: vi.fn(),
  single: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ rpc: mocked.rpc }),
}));

const endpoint = "https://wallie.example.test/oauth/token";
const clientId = "aca1c4bf-9836-444a-a48b-b7e20ed21c8f";
const redirectUri = "https://Client.example.test/callback?view=a%20b";
const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const origin = new URL(endpoint).origin;
const resource = `${origin}/api/v1/workspaces/${clientId}/factories/${clientId}/mcp`;

function submit(params: URLSearchParams, url = endpoint) {
  return POST(new Request(url, { method: "POST", body: params }));
}

describe("POST /oauth/token", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", origin);
    mocked.rpc.mockReturnValue({ single: mocked.single });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("passes only digests and the exact redirect to the exchange transaction", async () => {
    const code = issueFactoryOAuthCredential("code");
    mocked.single.mockResolvedValue({
      data: { status: "issued", expires_in: 600, scopes: ["sessions:read"] },
      error: null,
    });
    const response = await submit(
      new URLSearchParams({
        client_id: clientId,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code: code.credential,
        code_verifier: verifier,
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const body = await response.json();
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 600, scope: "sessions:read" });
    const access = parseFactoryOAuthCredential("access", body.access_token);
    const refresh = parseFactoryOAuthCredential("refresh", body.refresh_token);
    expect(access).not.toBeNull();
    expect(refresh).not.toBeNull();
    expect(mocked.rpc).toHaveBeenCalledExactlyOnceWith("exchange_factory_oauth_code", {
      p_client_id: clientId,
      p_redirect_uri: redirectUri,
      p_code_id: code.id,
      p_code_digest: code.digest,
      p_pkce_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      p_access_token_id: access?.id,
      p_access_token_digest: access?.digest,
      p_refresh_token_id: refresh?.id,
      p_refresh_token_digest: refresh?.digest,
    });
  });

  it("uses one rotation transaction with only the requested narrowed scopes", async () => {
    const oldRefresh = issueFactoryOAuthCredential("refresh");
    mocked.single.mockResolvedValue({
      data: { status: "issued", expires_in: 120, scopes: ["sessions:cancel"] },
      error: null,
    });
    const response = await submit(
      new URLSearchParams({
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: oldRefresh.credential,
        scope: "sessions:cancel",
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.scope).toBe("sessions:cancel");
    expect(body.refresh_token).not.toBe(oldRefresh.credential);
    const newAccess = parseFactoryOAuthCredential("access", body.access_token);
    const newRefresh = parseFactoryOAuthCredential("refresh", body.refresh_token);
    expect(mocked.rpc).toHaveBeenCalledExactlyOnceWith("rotate_factory_oauth_refresh_token", {
      p_client_id: clientId,
      p_refresh_token_id: oldRefresh.id,
      p_refresh_token_digest: oldRefresh.digest,
      p_next_access_token_id: newAccess?.id,
      p_next_access_token_digest: newAccess?.digest,
      p_next_refresh_token_id: newRefresh?.id,
      p_next_refresh_token_digest: newRefresh?.digest,
      p_requested_scopes: ["sessions:cancel"],
    });
  });

  it.each(["invalid_grant", "invalid_scope", "invalid_target"])(
    "returns only the committed %s outcome",
    async (status) => {
      const refresh = issueFactoryOAuthCredential("refresh");
      mocked.single.mockResolvedValue({
        data: { status, expires_in: null, scopes: null },
        error: null,
      });
      const response = await submit(
        new URLSearchParams({
          client_id: clientId,
          grant_type: "refresh_token",
          refresh_token: refresh.credential,
        }),
      );

      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: status });
      expect(mocked.rpc).toHaveBeenCalledTimes(1);
    },
  );

  it("passes a canonical resource to exact exchange and refresh", async () => {
    mocked.single.mockResolvedValue({
      data: { status: "invalid_target", expires_in: null, scopes: null },
      error: null,
    });
    const exchange = await submit(
      new URLSearchParams({
        client_id: clientId,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code: issueFactoryOAuthCredential("code").credential,
        code_verifier: verifier,
        resource,
      }),
    );
    expect(await exchange.json()).toEqual({ error: "invalid_target" });
    expect(mocked.rpc).toHaveBeenLastCalledWith(
      "exchange_factory_oauth_code",
      expect.objectContaining({ p_resource: resource }),
    );

    const rotate = await submit(
      new URLSearchParams({
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: issueFactoryOAuthCredential("refresh").credential,
        resource,
      }),
    );
    expect(await rotate.json()).toEqual({ error: "invalid_target" });
    expect(mocked.rpc).toHaveBeenLastCalledWith(
      "rotate_factory_oauth_refresh_token",
      expect.objectContaining({ p_resource: resource }),
    );
  });

  it("does not let a malformed or duplicate resource turn a request into an audience-free refresh", async () => {
    const params = new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: issueFactoryOAuthCredential("refresh").credential,
      resource: resource.replace(origin, "https://untrusted.example.test"),
    });
    mocked.single.mockResolvedValue({
      data: { status: "invalid_target", expires_in: null, scopes: null },
      error: null,
    });
    expect(await (await submit(params)).json()).toEqual({ error: "invalid_target" });
    params.set("resource", resource);
    params.append("resource", resource);
    expect(await (await submit(params)).json()).toEqual({ error: "invalid_target" });
    expect(mocked.rpc.mock.calls).toHaveLength(2);
    expect(mocked.rpc.mock.calls.map(([, args]) => args.p_resource)).toEqual(["", ""]);
  });

  it("rejects resource-bearing requests at a different origin, including scheme, before any RPC", async () => {
    const params = new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: issueFactoryOAuthCredential("refresh").credential,
      resource,
    });
    const downgrade = endpoint.replace("https:", "http:");
    for (const url of [downgrade, "https://another.example.test/oauth/token"]) {
      const response = await submit(params, url);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_target" });
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    params.set("resource", "");
    expect(await (await submit(params, downgrade)).json()).toEqual({ error: "invalid_target" });
    vi.stubEnv("NEXT_PUBLIC_APP_URL", new URL(downgrade).origin);
    expect(await (await submit(params, downgrade)).json()).toEqual({ error: "invalid_target" });
    expect(mocked.rpc).not.toHaveBeenCalled();
  });

  it("accepts the configured loopback issuer and preserves resource-less exchanges", async () => {
    mocked.single.mockResolvedValue({
      data: { status: "issued", expires_in: 120, scopes: ["sessions:read"] },
      error: null,
    });
    const loopback = "http://127.0.0.1:3185";
    const loopbackResource = resource.replace(origin, loopback);
    vi.stubEnv("NEXT_PUBLIC_APP_URL", loopback);
    const params = new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: issueFactoryOAuthCredential("refresh").credential,
      resource: loopbackResource,
    });
    expect((await submit(params, `${loopback}/oauth/token`)).status).toBe(200);
    expect(mocked.rpc).toHaveBeenLastCalledWith(
      "rotate_factory_oauth_refresh_token",
      expect.objectContaining({ p_resource: loopbackResource }),
    );
    params.delete("resource");
    expect((await submit(params)).status).toBe(200);
    expect(mocked.rpc).toHaveBeenCalledTimes(2);
  });

  it("does not expose credential-bearing database diagnostics", async () => {
    const refresh = issueFactoryOAuthCredential("refresh");
    mocked.single.mockResolvedValue({
      data: null,
      error: { message: refresh.credential, detail: refresh.digest },
    });
    const response = await submit(
      new URLSearchParams({
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: refresh.credential,
      }),
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "server_error" });
  });

  it("rejects malformed, duplicate and oversized forms before any database request", async () => {
    const valid = new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: issueFactoryOAuthCredential("refresh").credential,
    });
    const duplicates = new URLSearchParams(valid);
    duplicates.append("client_id", clientId);
    const oversized = new URLSearchParams(valid);
    oversized.set("unknown", "a".repeat(4096));

    for (const params of [duplicates, oversized]) {
      const response = await submit(params);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
    const json = await POST(
      new Request(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(json.status).toBe(400);
    expect(mocked.rpc).not.toHaveBeenCalled();
  });

  it("rejects a credential presented to the wrong grant flow", async () => {
    const response = await submit(
      new URLSearchParams({
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: issueFactoryOAuthCredential("access").credential,
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_grant" });
    expect(mocked.rpc).not.toHaveBeenCalled();
  });
});
