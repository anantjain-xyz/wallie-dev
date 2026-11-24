import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectorOutboundAdapter } from "@/lib/connectors/outbound";
import type { Database } from "@/lib/supabase/database.types";

import { createGitHubConnectorOutboundAdapter } from "./connector-outbound";

const mocks = vi.hoisted(() => ({ appRequest: vi.fn() }));
vi.mock("./config", () => ({ resolveGitHubAppConfig: () => ({ appId: 22 }) }));
vi.mock("@octokit/app", () => ({
  App: class {
    octokit = { request: mocks.appRequest };
  },
}));

type Target = Parameters<ConnectorOutboundAdapter["send"]>[0];
const sessionId = "d963cdea-d2c7-4fec-b56d-aa0a03168cce";
const stageId = "4aa11ba1-2e02-4316-9e94-aafcef3a11b9";
const artifactId = "b64cbd87-6418-4561-98a4-858194b8781c";
const target = {
  correlationId: "ee194725-7b85-4fa7-9990-ab2f0ac085ce",
  leaseId: "5b072736-ef0a-437c-a27d-862cbb46a376",
  externalResourceId: "32",
  externalThreadId: "issue:42",
  installationId: "7da8316e-ae44-4bb9-9a43-99aa8ecc4fa5",
  installationGeneration: 2,
  mappingRevision: 3,
  credentialRef: "0d348fcf-9fc2-4b48-acf9-78a727077ea9",
  credentialMaterialRevision: null,
  message: {
    operation: "reply",
    content: {
      kind: "progress",
      workspaceSlug: "acme",
      sessionNumber: 8,
      sessionId,
      body: "Work started.",
    },
  },
} satisfies Target;
const authority = {
  github_installation_id: 62,
  github_repository_id: 32,
  repository_full_name: "octo/project",
  source_kind: "issue",
  source_number: 14,
  source_id: 42,
};
const installation = {
  id: 62,
  app_id: 22,
  app_slug: "wallie-fixture",
  suspended_at: null,
  permissions: { issues: "write", pull_requests: "write" },
};
const signal = new AbortController().signal;
const origin = "https://api.github.com";
const repoPath = "/repos/octo/project";
const issuePath = `${repoPath}/issues/14`;
const marker = `<!-- wallie-connector-delivery:${target.correlationId} -->`;
const bot = { id: 16, login: "wallie-fixture[bot]", type: "Bot" };
const appComment = {
  id: 72,
  issue_url: `${origin}${issuePath}`,
  user: bot,
  performed_via_github_app: { id: 22 },
};

function makeAdapter({
  rows = [authority],
  stillCurrent = true,
  github,
}: {
  rows?: (typeof authority)[];
  stillCurrent?: boolean;
  github: (url: URL, request: RequestInit | undefined) => Response | Promise<Response>;
}) {
  const rpc = vi.fn<typeof fetch>(async () => Response.json(stillCurrent ? rows : []));
  rpc.mockResolvedValueOnce(Response.json(rows));
  const admin = createClient<Database>("http://127.0.0.1:54321", "fixture-admin-key", {
    global: { fetch: rpc },
  });
  const fetcher = vi.fn<typeof fetch>(async (input, request) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(origin);
    expect(request).toMatchObject({ redirect: "manual", cache: "no-store", signal });
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer scoped-fixture-token");
    if (url.pathname === repoPath)
      return Response.json({ id: 32, full_name: "octo/project", archived: false });
    if (url.pathname === issuePath) return Response.json({ id: 42, number: 14 });
    if (url.pathname === `${repoPath}/pulls/14`)
      return Response.json({ id: 69, number: 14, base: { repo: { id: 32 } } });
    if (url.pathname === "/users/wallie-fixture%5Bbot%5D") return Response.json(bot);
    return github(url, request);
  });
  return { adapter: createGitHubConnectorOutboundAdapter(admin, fetcher), rpc, fetcher };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.appRequest.mockImplementation(async (route: string, args: { permissions?: unknown }) => ({
    data: route.startsWith("GET")
      ? installation
      : { token: "scoped-fixture-token", permissions: args.permissions },
  }));
});

describe("GitHub connector reply adapter", () => {
  it("pins the repository, type-specific permission, App author and exact review link on a PR", async () => {
    const { adapter, rpc } = makeAdapter({
      rows: [{ ...authority, source_kind: "pull_request", source_id: 69 }],
      github: async (url, request) => {
        expect(url.pathname).toBe(`${issuePath}/comments`);
        expect(request?.method).toBe("POST");
        const { body } = await new Response(request?.body).json();
        expect(body).toContain(`artifactId=${artifactId}`);
        expect(body).toContain("artifactVersion=3");
        expect(body).toContain(`reviewStageId=${stageId}`);
        expect(body).toContain("reviewRevision=4");
        return Response.json({ ...appComment, body }, { status: 201 });
      },
    });
    await expect(
      adapter.send(
        {
          ...target,
          externalThreadId: "pull_request:69",
          message: {
            operation: "reply",
            content: {
              ...target.message.content,
              kind: "review_ready",
              body: "Ready for review.",
              reviewTarget: {
                stageId,
                stageSlug: "plan",
                artifactId,
                artifactVersion: 3,
                reviewRevision: 4,
                clarificationId: null,
              },
            },
          },
        },
        signal,
      ),
    ).resolves.toEqual({ kind: "sent", providerReplyId: "72" });
    expect(rpc).toHaveBeenCalledWith(
      expect.stringContaining("/rpc/resolve_github_connector_delivery"),
      expect.objectContaining({
        body: JSON.stringify({ p_delivery_id: target.correlationId, p_lease_id: target.leaseId }),
      }),
    );
    expect(mocks.appRequest).toHaveBeenNthCalledWith(
      2,
      "POST /app/installations/{installation_id}/access_tokens",
      expect.objectContaining({
        installation_id: 62,
        repository_ids: [32],
        permissions: { pull_requests: "write" },
        request: { redirect: "manual", signal },
      }),
    );
  });

  it("recovers a committed create after a lost response without issuing another write", async () => {
    let stored: unknown;
    const provider = vi.fn(async (_url: URL, request: RequestInit | undefined) => {
      if (request?.method === "POST") {
        const { body } = await new Response(request.body).json();
        expect(body).toContain(marker);
        stored = { ...appComment, body };
        throw new TypeError("connection closed after write");
      }
      return Response.json(stored ? [stored] : []);
    });
    const { adapter } = makeAdapter({ github: provider });
    await expect(adapter.send(target, signal)).resolves.toEqual({ kind: "uncertain" });
    await expect(adapter.observe(target, signal)).resolves.toEqual({
      kind: "found",
      providerReplyId: "72",
    });
    expect(provider.mock.calls.map(([, request]) => request?.method)).toEqual(["POST", "GET"]);
    expect(mocks.appRequest).toHaveBeenNthCalledWith(
      2,
      "POST /app/installations/{installation_id}/access_tokens",
      expect.objectContaining({ permissions: { issues: "write" } }),
    );
    expect(mocks.appRequest).toHaveBeenNthCalledWith(
      4,
      "POST /app/installations/{installation_id}/access_tokens",
      expect.objectContaining({ permissions: { issues: "read" } }),
    );
  });

  it("ignores copied markers from a human, another bot or the wrong thread", async () => {
    const body = `Other reply.\n\n${marker}`;
    const { adapter } = makeAdapter({
      github: () =>
        Response.json([
          { ...appComment, body, user: { ...bot, type: "User" } },
          { ...appComment, body, user: { ...bot, id: 102 } },
          { ...appComment, body, performed_via_github_app: { id: 82 } },
          { ...appComment, body, issue_url: `${origin}${repoPath}/issues/15` },
          { ...appComment, body: `${body}\nquoted`, performed_via_github_app: null },
        ]),
    });
    await expect(adapter.observe(target, signal)).resolves.toEqual({ kind: "inconclusive" });
  });

  it("ignores a pagination link's host and caps recovery reads without declaring absence", async () => {
    const pages: string[] = [];
    const { adapter } = makeAdapter({
      github: (url) => {
        pages.push(url.searchParams.get("page") ?? "");
        return Response.json([], {
          headers: { link: '<https://example.invalid/other>; rel="next"' },
        });
      },
    });
    await expect(adapter.observe(target, signal)).resolves.toEqual({ kind: "inconclusive" });
    expect(pages).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("preserves provider rate limits for a write or recovery read", async () => {
    const { adapter } = makeAdapter({
      github: () => new Response(null, { status: 403, headers: { "retry-after": "120" } }),
    });
    await expect(adapter.send(target, signal)).resolves.toEqual({
      kind: "rate_limited",
      retryAfterSeconds: 120,
    });
    await expect(adapter.observe(target, signal)).resolves.toEqual({
      kind: "rate_limited",
      retryAfterSeconds: 120,
    });
  });

  it("does not write after claim scope is lost or the exact native authority no longer matches", async () => {
    const provider = vi.fn(() => new Response(null, { status: 500 }));
    for (const rows of [
      [],
      [{ ...authority, source_id: 102 }],
      [{ ...authority, github_repository_id: 172 }],
    ]) {
      const { adapter } = makeAdapter({ rows, github: provider });
      await expect(adapter.send(target, signal)).resolves.toEqual({
        kind: "credential_unavailable",
      });
    }
    expect(mocks.appRequest).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  it("rejects a token that grants unrelated repository permissions", async () => {
    mocks.appRequest.mockResolvedValueOnce({ data: installation }).mockResolvedValueOnce({
      data: {
        token: "overbroad-fixture-token",
        permissions: { issues: "write", metadata: "read", pull_requests: "write" },
      },
    });
    const { adapter, fetcher } = makeAdapter({ github: () => new Response(null, { status: 500 }) });
    await expect(adapter.send(target, signal)).resolves.toEqual({ kind: "credential_unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rechecks the same lease after provider preflight and before transport", async () => {
    const provider = vi.fn(() => new Response(null, { status: 500 }));
    const { adapter, rpc, fetcher } = makeAdapter({ stillCurrent: false, github: provider });
    await expect(adapter.send(target, signal)).resolves.toEqual({ kind: "credential_unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(provider).not.toHaveBeenCalled();
  });

  it("will not edit an existing comment owned by another account", async () => {
    const provider = vi.fn((url: URL, request: RequestInit | undefined) => {
      expect(url.pathname).toBe(`${repoPath}/issues/comments/72`);
      expect(request?.method).toBe("GET");
      return Response.json({ ...appComment, body: "Original content.", user: { ...bot, id: 79 } });
    });
    const { adapter } = makeAdapter({ github: provider });
    await expect(
      adapter.send(
        { ...target, message: { ...target.message, operation: "edit", providerReplyId: "72" } },
        signal,
      ),
    ).resolves.toEqual({ kind: "rejected" });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("keeps a missing or malformed successful-provider read inconclusive", async () => {
    for (const response of [new Response(null, { status: 404 }), Response.json([{ id: 72 }])]) {
      const { adapter } = makeAdapter({ github: () => response });
      await expect(adapter.observe(target, signal)).resolves.toEqual({ kind: "inconclusive" });
    }
  });
});
