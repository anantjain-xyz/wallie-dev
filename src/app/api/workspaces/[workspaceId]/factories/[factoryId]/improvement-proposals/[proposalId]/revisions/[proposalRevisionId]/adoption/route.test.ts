import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit, clearRateLimitsForTesting, RATE_LIMITS } from "@/lib/rate-limit";
import type { Database } from "@/lib/supabase/database.types";

import { GET, POST } from "./route";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  admin: vi.fn(),
  adoption: vi.fn(),
  publication: vi.fn(),
  adopt: vi.fn(),
}));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: mocks.access }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
vi.mock("@/lib/factory-proposals/adoption-server", () => ({
  readFactoryImprovementAdoption: mocks.adoption,
  adoptFactoryImprovement: mocks.adopt,
}));
vi.mock("@/lib/factory-proposals/publication-server", () => ({
  readFactoryImprovementPublication: mocks.publication,
}));

const id = (slot: number) => `64000000-0000-4000-8000-${String(slot).padStart(12, "0")}`;
const workspaceId = id(1);
const factoryId = id(2);
const actorUserId = id(3);
const proposalId = id(4);
const proposalRevisionId = id(5);
const publicationId = id(6);
const client = { kind: "service-fixture" };
const revision = { workspaceId, factoryId, proposalId, proposalRevisionId };
const context = { params: Promise.resolve(revision) };
const origin = "https://wallie.test";
const url = `${origin}/api/workspaces/${workspaceId}/factories/${factoryId}/improvement-proposals/${proposalId}/revisions/${proposalRevisionId}/adoption`;
const command = {
  publicationId,
  expectedActivationNumber: 7,
  candidateDigest: "a".repeat(64),
  headCommitSha: "b".repeat(40),
};
const publication = { id: publicationId, proposalId, proposalRevisionId };
const adoption = { id: id(7), publicationId, proposalId, proposalRevisionId };

function grantFactoryVisibility(visible = true) {
  const supabase = createClient<Database>("https://fixture.invalid", "signed-user", {
    auth: { persistSession: false },
    global: {
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        expect(url.pathname).toBe("/rest/v1/factories");
        expect(url.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`);
        expect(url.searchParams.get("id")).toBe(`eq.${factoryId}`);
        return Response.json(visible ? { id: factoryId } : null);
      },
    },
  });
  mocks.access.mockResolvedValue({ ok: true, context: { supabase, user: { id: actorUserId } } });
}

function post(
  body = JSON.stringify(command),
  headers: HeadersInit = { origin, "content-type": "application/json" },
) {
  return new Request(url, { method: "POST", body, headers });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", origin);
  clearRateLimitsForTesting();
  grantFactoryVisibility();
  mocks.admin.mockReturnValue(client);
});

afterEach(() => vi.unstubAllEnvs());

describe("exact improvement adoption", () => {
  it.each([
    [false, 201],
    [true, 200],
  ])("returns the exact receipt with replay %s as HTTP %i", async (replay, status) => {
    mocks.adopt.mockResolvedValue({ adoption, replay });
    const request = post();

    const response = await POST(request, context);

    expect(response.status).toBe(status);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ adoption, replay });
    expect(mocks.adopt).toHaveBeenCalledExactlyOnceWith(
      { ...revision, client, actorUserId, signal: request.signal },
      command,
    );
  });

  it("reads both exact historical receipts through the authorized services", async () => {
    mocks.publication.mockResolvedValueOnce(publication).mockResolvedValueOnce(null);
    mocks.adoption.mockResolvedValueOnce(adoption).mockResolvedValueOnce(null);
    const request = new Request(url);

    const found = await GET(request, context);
    const absent = await GET(new Request(url), context);

    expect(found.status).toBe(200);
    expect(found.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(found.json()).resolves.toEqual({ publication, adoption });
    await expect(absent.json()).resolves.toEqual({ publication: null, adoption: null });
    const scope = { ...revision, client, actorUserId, signal: request.signal };
    expect(mocks.publication).toHaveBeenNthCalledWith(1, scope);
    expect(mocks.adoption).toHaveBeenNthCalledWith(1, scope);
    expect(mocks.adopt).not.toHaveBeenCalled();
  });

  it.each([
    [400, JSON.stringify({ ...command, actorUserId }), "application/json"],
    [400, JSON.stringify({ ...command, expectedActivationNumber: 0 }), "application/json"],
    [400, "invalid json", "application/json"],
    [413, " ".repeat(1025), "application/json"],
    [415, JSON.stringify(command), "text/plain"],
  ])("rejects the command as %i before using the privileged client", async (status, body, type) => {
    const response = await POST(post(body, { origin, "content-type": type }), context);

    expect(response.status).toBe(status);
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.adopt).not.toHaveBeenCalled();
  });

  it("rejects an outside origin, a query override, and invalid path before access", async () => {
    const external = post(JSON.stringify(command), {
      origin: "https://outside.invalid",
      "content-type": "application/json",
    });

    expect((await POST(external, context)).status).toBe(403);
    expect((await GET(new Request(`${url}?publicationId=${publicationId}`), context)).status).toBe(
      400,
    );
    expect(
      (
        await POST(post(), {
          params: Promise.resolve({ ...revision, proposalRevisionId: "invalid" }),
        })
      ).status,
    ).toBe(400);
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("does not invoke a privileged service for a factory outside the caller's scope", async () => {
    grantFactoryVisibility(false);

    expect((await GET(new Request(url), context)).status).toBe(404);
    expect((await POST(post(), context)).status).toBe(404);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("uses the shared operator rate limit for the signed-in actor", async () => {
    const limit = RATE_LIMITS.improvementProposals;
    for (let i = 0; i < limit.max; i++) {
      await checkRateLimit("improvementProposals", `${workspaceId}:${actorUserId}`);
    }

    const response = await POST(post(), context);

    expect(response.status).toBe(429);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it.each([
    ["42501", 403],
    ["P0002", 404],
    ["PT409", 409],
    ["PT422", 422],
    ["PT502", 502],
  ])("maps %s to HTTP %i without provider details", async (code, status) => {
    const error = { code, message: "private provider details" };
    mocks.adopt.mockRejectedValue(error);
    mocks.adoption.mockRejectedValue(error);

    for (const response of [await POST(post(), context), await GET(new Request(url), context)]) {
      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.text()).not.toContain(error.message);
    }
  });

  it("reports an upstream timeout generically", async () => {
    mocks.adopt.mockRejectedValue(new DOMException("private provider details", "TimeoutError"));

    const response = await POST(post(), context);

    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("private provider details");
  });
});
