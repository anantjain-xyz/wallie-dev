import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { encryptSecretValue } from "@/lib/secrets/crypto";

const id = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const positiveInteger = z.number().int().positive().safe();
const rule = z.strictObject({ automationId: id, revisionId: id });
const fixtureScope = z.strictObject({
  workspaceId: id,
  factoryId: id,
  ownerUserId: id,
  repository: z.strictObject({
    id,
    providerId: positiveInteger,
    installationId: positiveInteger,
    fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  }),
  grant: z.strictObject({ id, version: positiveInteger }),
  rules: z.strictObject({
    schedule: rule,
    github: rule,
    linear: rule,
    paused: rule,
    revoked: rule,
  }),
  linear: z.strictObject({
    linkedSessionId: id,
    issueId: id,
    identifier: z.string().min(1),
    teamId: z.string().min(1),
    baselineStateId: z.string().min(1),
    targetStateId: z.string().min(1),
  }),
  scheduledFor: timestamp,
});

export type AutomationInputScope = z.infer<typeof fixtureScope> & { linear: { apiKey: string } };

function loopback(value: string, protocols: readonly string[]) {
  const url = new URL(value);
  if (
    !protocols.includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  ) {
    throw new Error("Automation input fixtures require disposable loopback services.");
  }
  return url;
}

export async function seedAutomationInput(
  databaseUrl: string,
  namespace: string,
): Promise<AutomationInputScope> {
  const database = loopback(databaseUrl, ["postgresql:", "postgres:"]);
  if (database.href.includes("?") || database.href.includes("#")) {
    throw new Error("The automation fixture database URL cannot include connection overrides.");
  }
  if (!/^\d{8}$/.test(namespace))
    throw new Error("Provide an eight-digit automation fixture namespace.");
  const apiKey = `wallie-op668-linear-${namespace}`;
  const seed = fileURLToPath(new URL("./factory-automation-input-seed.psql", import.meta.url));
  const args = [
    "-X",
    "-qAt",
    "-v",
    "ON_ERROR_STOP=1",
    "-v",
    `op651_fixture_namespace=${namespace}`,
    "-v",
    `automation_linear_ciphertext=${encryptSecretValue(apiKey)}`,
    "-f",
    seed,
    database.toString(),
  ];
  const env = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    NODE_ENV: process.env.NODE_ENV,
  };
  const output = await new Promise<string>((resolve, reject) => {
    execFile("psql", args, { env, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error)
        reject(new Error(`Could not seed the isolated automation input fixture. ${stderr.trim()}`));
      else resolve(stdout);
    });
  });
  const scope = fixtureScope.parse(JSON.parse(output));
  return { ...scope, linear: { ...scope.linear, apiKey } };
}

const fixturePullRequests = { main: 41, "qualification-paused": 42, "qualification-revoked": 43 };
export type AutomationFixtureGitHubBranch = keyof typeof fixturePullRequests;

export async function sendGitHubFixture(
  appUrl: string,
  secret: string,
  scope: AutomationInputScope,
  branch: AutomationFixtureGitHubBranch,
  deliveryId: string,
) {
  const app = loopback(appUrl, ["http:"]);
  if (app.href !== `${app.origin}/`) throw new Error("Use the bare local application URL.");
  const url = new URL("/api/github/webhooks", app);
  const { providerId, installationId, fullName } = scope.repository;
  const number = fixturePullRequests[branch];
  const body = JSON.stringify({
    action: "closed",
    installation: { id: installationId },
    repository: { id: providerId },
    pull_request: {
      id: providerId * 100 + number,
      number,
      state: "closed",
      merged: true,
      draft: false,
      html_url: `https://github.com/${fullName}/pull/${number}`,
      updated_at: new Date(scope.scheduledFor).toISOString(),
      base: { ref: branch, repo: { id: providerId } },
      head: { ref: `qualification/input-${number}`, sha: "b".repeat(40), repo: { id: providerId } },
      merge_commit_sha: "f".repeat(40),
    },
  });
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": id.parse(deliveryId),
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitHub fixture delivery returned HTTP ${response.status}.`);
  }
  z.object({ received: z.literal(true) }).parse(await response.json());
}

const linearRequest = z.object({
  query: z.string().includes("query IssueStateSpans(").includes("issue0: issue(id: $id0)"),
  variables: z.strictObject({ id0: z.string() }),
});

type LinearState = {
  matched: boolean;
  replayUpdatedAt?: string;
  scope: AutomationInputScope;
};

async function respondToLinear(
  states: ReadonlyMap<string, LinearState>,
  request: IncomingMessage,
  response: ServerResponse,
) {
  response.setHeader("content-type", "application/json");
  const state = request.headers.authorization
    ? states.get(request.headers.authorization)
    : undefined;
  if (!state || request.method !== "POST" || request.url !== "/graphql") {
    response.writeHead(404).end('{"errors":[{"message":"Unknown fixture request."}]}');
    return;
  }
  request.setEncoding("utf8");
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new Error("Linear fixture request is too large.");
  }
  const payload = linearRequest.parse(JSON.parse(body));
  const { scope, matched } = state;
  const { issueId, identifier, teamId, baselineStateId, targetStateId } = scope.linear;
  if (payload.variables.id0 !== identifier && payload.variables.id0 !== issueId) {
    response.writeHead(404).end('{"errors":[{"message":"Unknown fixture issue."}]}');
    return;
  }
  const targetStartedAt = new Date(scope.scheduledFor).toISOString();
  const baselineStartedAt = new Date(Date.parse(scope.scheduledFor) - 60_000).toISOString();
  const baseline = {
    id: `${issueId}:baseline`,
    stateId: baselineStateId,
    startedAt: baselineStartedAt,
    endedAt: matched ? targetStartedAt : null,
  };
  const target = {
    id: `${issueId}:matching`,
    stateId: targetStateId,
    startedAt: targetStartedAt,
    endedAt: null,
  };
  response.end(
    JSON.stringify({
      data: {
        issue0: {
          id: issueId,
          updatedAt: matched ? (state.replayUpdatedAt ?? targetStartedAt) : baselineStartedAt,
          state: matched
            ? { id: targetStateId, name: "Qualification ready" }
            : { id: baselineStateId, name: "Backlog" },
          team: { id: teamId },
          project: null,
          stateHistory: {
            nodes: matched ? [baseline, target] : [baseline],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    }),
  );
}

export async function startLinearFixture(scopes: readonly AutomationInputScope[]) {
  const states = new Map<string, LinearState>(
    scopes.map((scope) => [scope.linear.apiKey, { scope, matched: false }]),
  );
  const stateForWorkspace = (workspaceId: string) => {
    const state = [...states.values()].find(({ scope }) => scope.workspaceId === workspaceId);
    if (!state) throw new Error("Unknown automation fixture workspace.");
    return state;
  };
  const server = createServer((request, response) => {
    void respondToLinear(states, request, response).catch(() => {
      response.writeHead(400).end('{"errors":[{"message":"Invalid fixture query."}]}');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing Linear fixture port.");
  return {
    endpoint: `http://127.0.0.1:${address.port}/graphql`,
    advance(workspaceId: string) {
      stateForWorkspace(workspaceId).matched = true;
    },
    replayMatching(workspaceId: string) {
      const state = stateForWorkspace(workspaceId);
      if (!state.matched) throw new Error("A matching span must exist before replay.");
      const newerInstant = Date.parse(state.scope.scheduledFor) + 1_000;
      state.replayUpdatedAt = new Date(newerInstant).toISOString();
      return newerInstant;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
