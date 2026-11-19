import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { describe, expect, it, vi } from "vitest";

import {
  FactoryApiError,
  FactoryClient,
  FactoryTransportError,
} from "../../../packages/factory-client/src/index.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const factoryId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const agentId = "55555555-5555-4555-8555-555555555555";
const repositoryId = "66666666-6666-4666-8666-666666666666";
const key = "77777777-7777-4777-8777-777777777777";
const scope = `/api/v1/workspaces/${workspaceId}/factories/${factoryId}`;
const token = "wallie_fixture_bearer";

async function fixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  verify: (client: FactoryClient, origin: string) => Promise<void>,
) {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture has no TCP port.");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await verify(new FactoryClient({ baseUrl: origin, workspaceId, factoryId, token }), origin);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
}

function reply(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

describe("Wallie factory client", () => {
  it("replays exactly the same create request after the committed reply is lost", async () => {
    const requestBodies: string[] = [];
    const requests: [string | undefined, string | undefined, unknown, string | undefined][] = [];
    const intent = {
      title: "Prepare release",
      prompt: "Draft release notes.",
      agentId,
      repositoryId,
    };
    const receipt = { receiptId: key, sessionId, runId, replayed: true };

    await fixture(
      async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requestBodies.push(Buffer.concat(chunks).toString("utf8"));
        requests.push([
          request.method,
          request.url,
          request.headers["idempotency-key"],
          request.headers.authorization,
        ]);
        if (requests.length === 1) request.socket.destroy();
        else reply(response, 200, receipt);
      },
      async (client) => {
        await expect(client.createSession(intent, { idempotencyKey: key })).resolves.toEqual(
          receipt,
        );
      },
    );

    expect(requests).toEqual(Array(2).fill(["POST", `${scope}/sessions`, key, `Bearer ${token}`]));
    expect(requestBodies).toEqual(Array(2).fill(JSON.stringify(intent)));
  });

  it("does not retry known conflicts and preserves the response's stable error", async () => {
    let requests = 0;
    await fixture(
      (_request, response) => {
        requests += 1;
        reply(response, 409, { code: "idempotency_conflict", error: "The key is already bound." });
      },
      async (client) => {
        const rejected = client.cancelSession(
          sessionId,
          { expectedRunId: runId },
          { idempotencyKey: key },
        );
        await expect(rejected).rejects.toBeInstanceOf(FactoryApiError);
        await expect(rejected).rejects.toMatchObject({
          status: 409,
          code: "idempotency_conflict",
          message: "The key is already bound.",
        });
      },
    );
    expect(requests).toBe(1);
  });

  it("sends the conversation resume cursor and preserves rate-limit delay", async () => {
    const cursor = "resume-fixture";
    const requests: string[] = [];
    await fixture(
      (request, response) => {
        requests.push(request.url ?? "");
        response.setHeader("Retry-After", "17");
        reply(response, 429, { code: "rate_limited" });
      },
      async (client) => {
        await expect(
          client.getConversation(sessionId, { cursor, direction: "after", limit: "9" }),
        ).rejects.toMatchObject({ status: 429, code: "rate_limited", retryAfterSeconds: 17 });
      },
    );
    expect(requests).toEqual([
      `${scope}/sessions/${sessionId}/conversation?cursor=${cursor}&direction=after&limit=9`,
    ]);
  });

  it("does not follow a redirect or open protected links on another origin", async () => {
    const paths: string[] = [];
    await fixture(
      (request, response) => {
        paths.push(request.url ?? "");
        response.writeHead(302, { Location: "/receiver" });
        response.end("Redirect");
      },
      async (client, origin) => {
        await expect(client.getSession(sessionId)).rejects.toMatchObject({ status: 302 });
        expect(client.toUrl("/w/studio/sessions/2?artifactVersion=4")).toBe(
          `${origin}/w/studio/sessions/2?artifactVersion=4`,
        );
        expect(() => client.toUrl("//different.example/w/studio")).toThrow(TypeError);
      },
    );
    expect(paths).toEqual([`${scope}/sessions/${sessionId}`]);
  });

  it("does not replay an explicitly aborted caller and rejects malformed JSON", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("invalid JSON"));
    const client = new FactoryClient({
      baseUrl: "https://wallie.example",
      workspaceId,
      factoryId,
      token,
      fetch: fetcher,
    });
    const stop = new AbortController();
    stop.abort(new Error("Client stopped."));
    await expect(client.getSession(sessionId, { signal: stop.signal })).rejects.toThrow(
      "Client stopped.",
    );
    expect(fetcher).not.toHaveBeenCalled();
    const failed = client.getSession(sessionId);
    await expect(failed).rejects.toBeInstanceOf(FactoryTransportError);
    await expect(failed).rejects.toMatchObject({ code: "invalid_response" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
