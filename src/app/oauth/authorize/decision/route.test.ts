import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ actor: vi.fn(), rpc: vi.fn(), code: vi.fn() }));

vi.mock("@/lib/factory-oauth/browser-auth", async (load) => ({
  ...(await load<typeof import("@/lib/factory-oauth/browser-auth")>()),
  authenticateFactoryOAuthBrowser: mocks.actor,
}));

vi.mock("@/lib/factory-oauth/credentials", () => ({ issueFactoryOAuthCredential: mocks.code }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ rpc: mocks.rpc }) }));

import { POST } from "./route";

const origin = "https://wallie.example.test";
const redirectUri = "https://client.example.test/exact-callback?kept=1";
const authorizationId = "56800000-0000-4000-8000-000000000001";
const userId = "56800000-0000-4000-8000-000000000002";
const sessionId = "56800000-0000-4000-8000-000000000003";
const factoryId = "56800000-0000-4000-8000-000000000004";
const code = {
  id: "56800000-0000-4000-8000-000000000005",
  credential: "fixture-opaque-code",
  digest: "a".repeat(64),
};

function post(form: URLSearchParams, source = origin) {
  return new Request(new URL("/oauth/authorize/decision", origin), {
    method: "POST",
    headers: { Origin: source },
    body: form,
  });
}

function consent(decision = "allow") {
  return new URLSearchParams({ authorizationId, decision, factoryIds: factoryId });
}

function receipt(data: { redirect_uri: string; state: string | null; approved: boolean }) {
  mocks.rpc.mockReturnValue({ single: async () => ({ data, error: null }) });
}

describe("OAuth browser consent decision", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", origin);
    mocks.actor.mockResolvedValue({ id: userId, sessionId });
    mocks.code.mockReturnValue(code);
  });

  it("rejects a cross-origin form before reading the user or changing consent", async () => {
    const response = await POST(post(consent(), "https://client.example.test"));
    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
    expect(mocks.actor).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects duplicate decisions and callback inputs from the browser form", async () => {
    const repeated = consent();
    repeated.append("decision", "deny");
    const redirected = consent();
    redirected.set("redirect_uri", "https://client.example.test/changed");
    expect((await POST(post(repeated))).status).toBe(400);
    expect((await POST(post(redirected))).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("uses the verified session, exact factory selection, and callback from the database receipt", async () => {
    receipt({ redirect_uri: redirectUri, state: "opaque state", approved: true });
    const response = await POST(post(consent()));
    expect(mocks.rpc).toHaveBeenCalledWith("decide_factory_oauth_authorization", {
      p_authorization_id: authorizationId,
      p_actor_user_id: userId,
      p_actor_session_id: sessionId,
      p_allow: true,
      p_factory_ids: [factoryId],
      p_code_id: code.id,
      p_code_digest: code.digest,
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const callback = new URL(response.headers.get("location") ?? "");
    expect(callback.origin + callback.pathname).toBe("https://client.example.test/exact-callback");
    expect(Object.fromEntries(callback.searchParams)).toEqual({
      code: code.credential,
      kept: "1",
      state: "opaque state",
    });
  });

  it("consumes a denial without generating a code", async () => {
    receipt({ redirect_uri: redirectUri, state: "requested state", approved: false });
    const response = await POST(post(consent("deny")));
    expect(mocks.code).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith("decide_factory_oauth_authorization", {
      p_authorization_id: authorizationId,
      p_actor_user_id: userId,
      p_actor_session_id: sessionId,
      p_allow: false,
    });
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "access_denied",
    );
  });

  it("keeps invalid sessions and rejected authority local", async () => {
    mocks.actor.mockResolvedValueOnce({ id: userId });
    const noSession = await POST(post(consent()));
    expect(noSession.status).toBe(401);
    expect(noSession.headers.get("location")).toBeNull();
    expect(mocks.rpc).not.toHaveBeenCalled();

    mocks.rpc.mockReturnValue({ single: async () => ({ data: null, error: { code: "42501" } }) });
    const denied = await POST(post(consent()));
    expect(denied.status).toBe(403);
    expect(denied.headers.get("location")).toBeNull();
  });
});
