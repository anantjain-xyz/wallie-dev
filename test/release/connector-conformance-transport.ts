import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { z } from "zod/v4";

import type { ConnectorConformanceSeed } from "./connector-conformance-oracle";

export const githubIssueNumber = 71;
export const githubOriginalComment = "Please preserve the fixture’s original acceptance criteria.";
export const githubEditedComment =
  "Also keep existing fixture behavior while implementing the request.";

type ProviderScope = Pick<ConnectorConformanceSeed, "github" | "linear">;

type DiscoveryPage = "foreign-actor" | "original" | "reordered";
type Provider = "github" | "linear";
type Comment = { id: string; body: string };

export function githubIssueId(scope: ProviderScope) {
  return scope.github.repositoryId * 100 + githubIssueNumber;
}

function loopbackHttp(value: string) {
  const url = new URL(value);
  assert.equal(url.protocol, "http:");
  assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert.equal(url.href, `${url.origin}/`, "Use a bare loopback service origin.");
  return url;
}

export async function sendSignedGitHubFixture(
  appUrl: string,
  secret: string,
  event: "issues" | "issue_comment",
  payload: unknown,
  deliveryId: string = randomUUID(),
  validSignature = true,
) {
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", validSignature ? secret : "invalid-fixture-key")
    .update(body)
    .digest("hex");
  const response = await fetch(new URL("/api/github/webhooks", loopbackHttp(appUrl)), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": event,
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  await response.body?.cancel();
  assert.equal(response.status, validSignature ? 200 : 401, `Signed GitHub ${event}`);
  return deliveryId;
}

async function jsonBody(request: IncomingMessage) {
  const parts: Buffer[] = [];
  let total = 0;
  for await (const part of request) {
    const bytes = Buffer.from(part);
    total += bytes.length;
    assert(total <= 64_000, "The fixture provider request exceeded its body limit.");
    parts.push(bytes);
  }
  const result: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
  return result;
}

function readJson(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const githubAppSlug = "wallie-m13-fixture";
const githubToken = "wallie-m13-installation-reader";
const bot = { id: 68100002, login: `${githubAppSlug}[bot]`, type: "Bot" };
const githubOrigin = "https://api.github.com";
const linearOrigin = "https://api.linear.app";
const linearCursor = "wallie-m13-original-page";
const marker = /<!-- wallie-connector-delivery:([a-f0-9-]+) -->$/;
const requestRecord = z.record(z.string(), z.unknown());
const node = (id: string) => ({ id });

export async function openConnectorConformanceTransport(input: {
  scope: ProviderScope;
  appId: number;
  appUrl: string;
  supabaseUrl: string;
  linearApiKey: string;
}) {
  const { scope, appId, linearApiKey } = input;
  const { github, linear } = scope;
  const localOrigins = new Set(
    [input.appUrl, input.supabaseUrl].map((url) => loopbackHttp(url).origin),
  );
  const repoPath = `/repos/${github.repositoryName}`;
  const issuePath = `${repoPath}/issues/${githubIssueNumber}`;
  const githubComments: Comment[] = [];
  const linearComments: Comment[] = [];
  const writes: Array<{ provider: Provider; intentId: string }> = [];
  const observed: Record<Provider, number> = { github: 0, linear: 0 };
  const loseNextReply = new Set<Provider>(["github", "linear"]);
  const originalSpan = {
    id: randomUUID(),
    stateId: linear.stateId,
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    endedAt: null,
  };
  const initialUpdatedAt = new Date(Date.now() - 60_000).toISOString();
  const reorderedUpdatedAt = new Date(Date.now() - 90_000).toISOString();
  const discoveryPages: DiscoveryPage[] = [];
  let selectedPage: DiscoveryPage = "foreign-actor";
  let destinationSpan: typeof originalSpan | null = null;
  let statusWrites = 0;
  let failure: Error | undefined;

  function recordWrite(provider: Provider, intentId: string) {
    writes.push({ provider, intentId });
    return loseNextReply.delete(provider);
  }

  function githubComment(row: Comment) {
    return {
      id: Number(row.id),
      body: row.body,
      issue_url: githubOrigin + issuePath,
      user: bot,
      performed_via_github_app: { id: appId },
    };
  }

  async function respondGitHub(request: IncomingMessage, response: ServerResponse, route: URL) {
    const path = route.pathname.slice("/github".length);
    const appPath = `/app/installations/${github.installationId}`;
    const authorization = request.headers.authorization;
    const method = request.method;
    if (path === appPath || path === appPath + "/access_tokens") {
      assert.match(authorization ?? "", /^bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i);
      if (path === appPath) {
        assert.equal(method, "GET");
        return readJson(response, {
          id: github.installationId,
          app_id: appId,
          app_slug: githubAppSlug,
          suspended_at: null,
          account: { id: github.tenantId, login: github.repositoryName.split("/")[0] },
          permissions: { issues: "write" },
        });
      }
      assert.equal(method, "POST");
      const body = z
        .object({
          repository_ids: z.tuple([z.literal(github.repositoryId)]),
          permissions: z.object({ issues: z.enum(["read", "write"]) }).strict(),
        })
        .parse(await jsonBody(request));
      return readJson(response, { token: githubToken, permissions: body.permissions }, 201);
    }
    assert.equal(authorization, `Bearer ${githubToken}`);
    if (method === "GET" && path === repoPath) {
      return readJson(response, {
        id: github.repositoryId,
        full_name: github.repositoryName,
        archived: false,
      });
    }
    if (method === "GET" && path === issuePath) {
      return readJson(response, { id: githubIssueId(scope), number: githubIssueNumber });
    }
    if (method === "GET" && path === `/users/${encodeURIComponent(bot.login)}`) {
      return readJson(response, bot);
    }
    assert.equal(path, issuePath + "/comments", "GitHub replies must target the admitted issue.");
    if (method === "GET") {
      assert(
        route.searchParams.has("since"),
        "GitHub recovery must use the bounded comment window.",
      );
      observed.github++;
      return readJson(response, githubComments.map(githubComment));
    }
    assert.equal(method, "POST");
    const { body } = z.object({ body: z.string() }).parse(await jsonBody(request));
    const intentId = marker.exec(body)?.[1];
    assert(intentId, "The GitHub reply must carry the durable correlation marker.");
    const lost = recordWrite("github", intentId);
    const comment = { id: String(github.repositoryId * 100 + 80 + githubComments.length), body };
    githubComments.push(comment);
    return lost
      ? readJson(response, { message: "Fixture lost the write response." }, 503)
      : readJson(response, githubComment(comment), 201);
  }

  function linearIssue() {
    return {
      id: linear.issueId,
      archivedAt: null,
      trashed: false,
      team: node(linear.teamId),
      project: linear.projectId ? node(linear.projectId) : null,
    };
  }

  function discovery(variables: Record<string, unknown>) {
    discoveryPages.push(selectedPage);
    assert.equal(variables.first, 20);
    assert.equal(variables.after, selectedPage === "reordered" ? linearCursor : null);
    assert.deepEqual(variables.filter, {
      team: { id: { eq: linear.teamId } },
      state: { id: { in: [linear.stateId] } },
      ...(linear.labelId ? { labels: { id: { eq: linear.labelId } } } : {}),
    });
    const moved = selectedPage === "reordered";
    const identifier = moved ? "MOVED-71" : "FIXTURE-71";
    return {
      organization: node(linear.tenantId),
      viewer: node(linear.viewerId),
      issues: {
        nodes: [
          {
            ...linearIssue(),
            identifier,
            previousIdentifiers: moved ? ["FIXTURE-71"] : [],
            updatedAt: moved ? reorderedUpdatedAt : initialUpdatedAt,
            url: `https://linear.app/wallie-fixture/issue/${identifier}/scoped-request`,
            title: "Scoped Linear connector qualification",
            description: "Synthetic intake body must stay in Wallie.",
            state: node(linear.stateId),
            stateHistory: { nodes: [originalSpan] },
            creator: node(selectedPage === "foreign-actor" ? randomUUID() : linear.creatorId),
            labelIds: linear.labelId ? [linear.labelId] : [],
          },
        ],
        pageInfo: {
          hasNextPage: selectedPage === "original",
          endCursor: selectedPage === "original" ? linearCursor : null,
        },
      },
    };
  }

  async function respondLinear(request: IncomingMessage, response: ServerResponse, route: URL) {
    assert.equal(route.pathname, "/linear/graphql");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, linearApiKey);
    const { query, variables } = z
      .object({ query: z.string(), variables: requestRecord })
      .parse(await jsonBody(request));
    const operation = /^\s*(?:query|mutation) (\w+)/.exec(query)?.[1];
    switch (operation) {
      case "ConnectorLinearTenant":
        assert.deepEqual(variables, {});
        return readJson(response, {
          data: { organization: { ...node(linear.tenantId), name: "Wallie M13 fixture" } },
        });
      case "WallieIssueDiscovery":
        return readJson(response, { data: discovery(variables) });
      case "WallieLinearCommentScope":
        assert.deepEqual(variables, { id: linear.issueId });
        return readJson(response, {
          data: { organization: node(linear.tenantId), issue: linearIssue() },
        });
      case "WallieLinearCreateComment": {
        const { id, issueId, body } = z
          .object({
            id: z.uuid(),
            issueId: z.uuid(),
            body: z.string(),
            doNotSubscribeToIssue: z.literal(true),
          })
          .parse(variables.input);
        assert.equal(issueId, linear.issueId);
        const lost = recordWrite("linear", id);
        linearComments.push({ id, body });
        return lost
          ? readJson(response, { errors: [{ message: "Fixture lost the write response." }] }, 503)
          : readJson(response, {
              data: {
                commentCreate: { success: true, comment: { id, body, issue: node(issueId) } },
              },
            });
      }
      case "WallieLinearReadComment": {
        observed.linear++;
        const row = linearComments.find((comment) => comment.id === variables.id);
        return readJson(response, {
          data: { comment: row ? { ...row, issue: node(linear.issueId) } : null },
        });
      }
      case "WallieLinearStatusScope": {
        assert.deepEqual(variables, {
          id: linear.issueId,
          to: linear.toStateId,
          checkDestination: true,
        });
        return readJson(response, {
          data: {
            organization: node(linear.tenantId),
            issue: {
              ...linearIssue(),
              updatedAt: destinationSpan?.startedAt ?? initialUpdatedAt,
              state: node(destinationSpan?.stateId ?? linear.stateId),
              stateHistory: {
                nodes: destinationSpan ? [destinationSpan, originalSpan] : [originalSpan],
              },
            },
            workflowState: { id: linear.toStateId, team: node(linear.teamId), archivedAt: null },
          },
        });
      }
      case "WallieLinearUpdateStatus": {
        assert.deepEqual(variables, { id: linear.issueId, stateId: linear.toStateId });
        assert.equal(statusWrites, 0, "The opt-in Linear status may be written only once.");
        statusWrites++;
        destinationSpan = {
          id: randomUUID(),
          stateId: linear.toStateId,
          startedAt: new Date().toISOString(),
          endedAt: null,
        };
        return readJson(response, {
          data: {
            issueUpdate: {
              success: true,
              issue: { id: linear.issueId, state: node(linear.toStateId) },
            },
          },
        });
      }
      default:
        throw new Error("Unexpected fixture Linear operation.");
    }
  }

  const server = createServer((request, response) => {
    const route = new URL(request.url ?? "", "http://localhost");
    const handle = route.pathname.startsWith("/github/")
      ? respondGitHub(request, response, route)
      : respondLinear(request, response, route);
    void handle.catch((error: unknown) => {
      failure = error instanceof Error ? error : new Error("The fixture provider failed.");
      readJson(response, { error: "Unexpected connector fixture request." }, 500);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string", "Missing fixture provider listener.");
  const origin = `http://127.0.0.1:${address.port}`;
  const originalFetch = globalThis.fetch;
  const fixtureFetch: typeof fetch = async (request, init) => {
    const url = new URL(request instanceof Request ? request.url : request);
    if (localOrigins.has(url.origin)) return originalFetch(request, { ...init, redirect: "error" });
    try {
      const provider = url.origin === githubOrigin ? "github" : "linear";
      assert(
        url.origin === githubOrigin || (url.origin === linearOrigin && url.pathname === "/graphql"),
        "Connector fixture blocked an unexpected outbound destination.",
      );
      const forwarded = new Request(request, init);
      return await originalFetch(`${origin}/${provider}${url.pathname}${url.search}`, {
        method: forwarded.method,
        headers: forwarded.headers,
        signal: forwarded.signal,
        redirect: "error",
        body: forwarded.body === null ? undefined : await forwarded.arrayBuffer(),
      });
    } catch (error) {
      failure = error instanceof Error ? error : new Error("Connector fixture egress failed.");
      throw error;
    }
  };

  return {
    fetch: fixtureFetch,
    githubComments,
    linearComments,
    writes,
    observed,
    discoveryPages,
    originalSpan,
    get statusWrites() {
      return statusWrites;
    },
    get linearStateId() {
      return destinationSpan?.stateId ?? linear.stateId;
    },
    selectDiscoveryPage(page: DiscoveryPage) {
      selectedPage = page;
    },
    assertHealthy() {
      if (failure) throw failure;
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
