import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as setTarget } from "@/app/api/workspaces/[workspaceId]/factories/[factoryId]/improvement-publication-target/route";
import { checkRateLimit, clearRateLimitsForTesting, RATE_LIMITS } from "@/lib/rate-limit";
import type { Database } from "@/lib/supabase/database.types";

import { GET, POST } from "./route";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  admin: vi.fn(),
  configure: vi.fn(),
  read: vi.fn(),
  publish: vi.fn(),
}));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: mocks.access }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
vi.mock("@/lib/factory-proposals/publication-server", () => ({
  setFactoryImprovementPublicationTarget: mocks.configure,
  readFactoryImprovementPublication: mocks.read,
  publishFactoryImprovement: mocks.publish,
}));

const id = (slot: number) => `63900000-0000-4000-8000-${String(slot).padStart(12, "0")}`;
const workspaceId = id(1);
const factoryId = id(2);
const actorUserId = id(3);
const repositoryId = id(4);
const proposalId = id(5);
const proposalRevisionId = id(6);
const factory = { workspaceId, factoryId };
const revision = { ...factory, proposalId, proposalRevisionId };
const factoryContext = { params: Promise.resolve(factory) };
const proposalContext = { params: Promise.resolve(revision) };
const origin = "https://wallie.test";
const factoryUrl = `${origin}/api/workspaces/${workspaceId}/factories/${factoryId}`;
const targetUrl = `${factoryUrl}/improvement-publication-target`;
const publicationUrl = `${factoryUrl}/improvement-proposals/${proposalId}/revisions/${proposalRevisionId}/publication`;
const command = { repositoryId, baseBranch: "factory/definitions" };
const target = {
  id: id(7),
  ...command,
  configPath: `.wallie/factory-definitions/${factoryId}.json`,
};
const publication = { id: id(8), proposalId, proposalRevisionId };
const client = { kind: "service-fixture" };

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

function configureRequest(
  body: string = JSON.stringify(command),
  headers: HeadersInit = { origin, "content-type": "application/json" },
) {
  return new Request(targetUrl, { method: "POST", body, headers });
}

function publishRequest(init?: RequestInit, url = publicationUrl) {
  return new Request(url, { method: "POST", headers: { origin }, ...init });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", origin);
  clearRateLimitsForTesting();
  grantFactoryVisibility();
  mocks.admin.mockReturnValue(client);
});

afterEach(() => vi.unstubAllEnvs());

describe("definition publication target", () => {
  it("passes only the selected internal repository and branch with the authenticated scope", async () => {
    mocks.configure.mockResolvedValue(target);
    const request = configureRequest();

    const response = await setTarget(request, factoryContext);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ target });
    expect(mocks.configure).toHaveBeenCalledExactlyOnceWith(
      { ...factory, client, actorUserId, signal: request.signal },
      command,
    );
  });

  it.each([
    [400, JSON.stringify({ ...command, installationId: 99 }), "application/json"],
    [400, "invalid json", "application/json"],
    [413, " ".repeat(1025), "application/json"],
    [415, JSON.stringify(command), "text/plain"],
  ])(
    "rejects input with status %i before resolving the privileged service",
    async (status, body, type) => {
      const response = await setTarget(
        configureRequest(body, { origin, "content-type": type }),
        factoryContext,
      );

      expect(response.status).toBe(status);
      expect(mocks.admin).not.toHaveBeenCalled();
      expect(mocks.configure).not.toHaveBeenCalled();
    },
  );

  it("keeps repository qualification and manager authorization at the publication boundary", async () => {
    mocks.configure
      .mockRejectedValueOnce({ code: "PT422", message: "private repository metadata" })
      .mockRejectedValueOnce({ code: "42501", message: "private repository metadata" });

    const invalid = await setTarget(configureRequest(), factoryContext);
    const denied = await setTarget(configureRequest(), factoryContext);

    expect(invalid.status).toBe(422);
    expect(denied.status).toBe(403);
    expect(await invalid.text()).not.toContain("private repository metadata");
    expect(await denied.text()).not.toContain("private repository metadata");
  });
});

describe("exact proposal revision publication", () => {
  it.each([
    ["pending", false, 202],
    ["pending", true, 202],
    ["published", false, 201],
    ["published", true, 200],
  ])("returns %s when replay is %s as HTTP %i", async (state, replay, status) => {
    mocks.publish.mockResolvedValue({ publication, state, replay });
    const request = publishRequest();

    const response = await POST(request, proposalContext);

    expect(response.status).toBe(status);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ publication, state, replay });
    expect(mocks.publish).toHaveBeenCalledExactlyOnceWith({
      ...revision,
      client,
      actorUserId,
      signal: request.signal,
    });
  });

  it("accepts an empty request stream but rejects input and query overrides", async () => {
    mocks.publish.mockResolvedValue({ publication, state: "pending", replay: false });
    const emptyStream = publishRequest({ body: "" });
    expect(emptyStream.body).not.toBeNull();
    expect((await POST(emptyStream, proposalContext)).status).toBe(202);
    expect(
      (await POST(publishRequest({ body: JSON.stringify({ repositoryId }) }), proposalContext))
        .status,
    ).toBe(400);
    expect(
      (
        await POST(
          publishRequest(undefined, `${publicationUrl}?repositoryId=${repositoryId}`),
          proposalContext,
        )
      ).status,
    ).toBe(400);
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(mocks.admin).toHaveBeenCalledOnce();
  });

  it("reads the exact historical revision only through the manager-gated receipt service", async () => {
    mocks.read.mockResolvedValueOnce(publication).mockResolvedValueOnce(null);
    const request = new Request(publicationUrl);

    const found = await GET(request, proposalContext);
    const missing = await GET(new Request(publicationUrl), proposalContext);

    expect(found.status).toBe(200);
    expect(found.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(found.json()).resolves.toEqual({ publication });
    expect(missing.status).toBe(404);
    expect(mocks.read).toHaveBeenNthCalledWith(1, {
      ...revision,
      client,
      actorUserId,
      signal: request.signal,
    });
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("rejects an invalid revision ID before authentication or privileged operations", async () => {
    const response = await POST(publishRequest(), {
      params: Promise.resolve({ ...revision, proposalRevisionId: "invalid" }),
    });

    expect(response.status).toBe(400);
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("keeps a factory missing from the caller's scope away from privileged operations", async () => {
    grantFactoryVisibility(false);

    expect((await GET(new Request(publicationUrl), proposalContext)).status).toBe(404);
    expect((await POST(publishRequest(), proposalContext)).status).toBe(404);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it.each([
    ["42501", 403],
    ["P0002", 404],
    ["PT409", 409],
    ["PT422", 422],
    ["PT502", 502],
  ])("scrubs %s and preserves the scoped status %i", async (code, status) => {
    const error = { code, message: "private provider details" };
    mocks.publish.mockRejectedValue(error);
    mocks.read.mockRejectedValue(error);

    for (const response of [
      await POST(publishRequest(), proposalContext),
      await GET(new Request(publicationUrl), proposalContext),
    ]) {
      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.text()).not.toContain(error.message);
    }
  });

  it("reports an upstream abort generically as a retryable GitHub failure", async () => {
    mocks.publish.mockRejectedValue(new DOMException("private provider details", "AbortError"));

    const response = await POST(publishRequest(), proposalContext);

    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("private provider details");
  });
});

it.each([new Headers(), new Headers({ origin: "https://elsewhere.test" })])(
  "blocks writes without the configured same origin before authentication",
  async (headers) => {
    expect(
      (await setTarget(configureRequest(JSON.stringify(command), headers), factoryContext)).status,
    ).toBe(403);
    expect((await POST(publishRequest({ headers }), proposalContext)).status).toBe(403);
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.admin).not.toHaveBeenCalled();
  },
);

it("rate limits both writes together per authenticated workspace user", async () => {
  for (let index = 0; index < RATE_LIMITS.improvementProposals.max; index += 1) {
    await checkRateLimit("improvementProposals", `${workspaceId}:${actorUserId}`);
  }

  for (const response of [
    await setTarget(configureRequest(), factoryContext),
    await POST(publishRequest(), proposalContext),
  ]) {
    expect(response.status).toBe(429);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  }
  expect(mocks.admin).not.toHaveBeenCalled();
});
