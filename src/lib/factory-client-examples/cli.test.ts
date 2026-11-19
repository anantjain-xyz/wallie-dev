import { execFile } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod/v4";

import { factoryReadRoutes } from "@/lib/factory-read-api/contracts";
import {
  factoryMutationResponseSchema,
  factoryMutationRoutes,
} from "@/lib/factory-session-mutations/contracts";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const tsCompiler = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const clientDirectory = join(root, "packages/factory-client");
const id = (sequence: number) => `57500000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
const [workspaceId, factoryId, sessionId, stageId, runId, artifactId, clarificationId] = [
  1, 2, 3, 4, 5, 6, 7,
].map(id);
const revisedArtifactId = id(16);
const revisedRunId = id(17);
const queuedRunId = id(18);
const route = `/api/v1/workspaces/${workspaceId}/factories/${factoryId}`;
const canonicalUrl = "/w/qualification/sessions/1";
const happenedAt = "2026-11-19T19:00:00.000Z";
const resumeCursor = "fixture_previous_page";
const review = {
  stageId,
  stageSlug: "plan",
  artifactId,
  artifactVersion: 2,
  reviewRevision: 0,
  runId,
  checkpointRunId: runId,
  attemptCount: 1,
  clarification: { id: clarificationId, question: "Which rollout should start first?" },
  href: `${canonicalUrl}?artifactId=${artifactId}`,
};
const session = factoryReadRoutes.session.response.parse({
  id: sessionId,
  number: 1,
  title: "Plan a rollout",
  status: "awaiting_review",
  archivedAt: null,
  createdAt: happenedAt,
  updatedAt: happenedAt,
  currentStageId: stageId,
  currentRunId: runId,
  specificationStageId: stageId,
  canonicalUrl,
  review,
});
const revisedSession = factoryReadRoutes.session.response.parse({
  ...session,
  currentRunId: revisedRunId,
  review: {
    ...review,
    artifactId: revisedArtifactId,
    artifactVersion: 3,
    reviewRevision: 1,
    clarification: null,
    href: `${canonicalUrl}?artifactId=${revisedArtifactId}`,
    runId: revisedRunId,
  },
});
const artifact = factoryReadRoutes.artifact.response.parse({
  id: artifactId,
  sessionId,
  sessionNumber: 1,
  stageId,
  stageSlug: "plan",
  version: 2,
  createdAt: happenedAt,
  canonicalUrl,
  bodyHtml: "<p>Rollout details.</p>",
  href: review.href,
  provenance: { runId, attemptCount: 1, checkpointRunId: runId, commitSha: "a".repeat(40) },
});
const run = factoryReadRoutes.run.response.parse({
  id: runId,
  sessionId,
  sessionNumber: 1,
  stageId,
  stageName: "Plan",
  stageSlug: "plan",
  status: "success",
  attemptCount: 1,
  createdAt: happenedAt,
  startedAt: happenedAt,
  completedAt: happenedAt,
  artifactId,
  artifactCoverage: "available",
  transcriptAvailability: "not_exposed",
  canonicalUrl,
});
const conversation = factoryReadRoutes.conversation.response.parse({
  canonicalUrl,
  items: [],
  sources: [],
  nextCursor: null,
  resumeCursor: "fixture_current_page",
});
const receipt = factoryMutationResponseSchema.parse({
  receiptId: id(8),
  sessionId,
  sessionNumber: 1,
  workspaceSlug: "qualification",
  canonicalUrl,
  conversationUrl: route + `/sessions/${sessionId}/conversation`,
  phaseStatus: "in_progress",
  jobId: id(9),
  runId,
  replayed: false,
});
const sessionPath = `/sessions/${sessionId}`;
const inspectedSessionSchema = z.object({
  session: factoryReadRoutes.session.response,
  artifact: factoryReadRoutes.artifact.response.optional(),
  run: factoryReadRoutes.run.response.optional(),
});

function json(response: ServerResponse, data: unknown, status = 200, retryAfter?: string) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "private, no-store",
    ...(retryAfter && { "Retry-After": retryAfter }),
  });
  response.end(JSON.stringify(data));
}

async function readBody(request: IncomingMessage) {
  request.setEncoding("utf8");
  let text = "";
  for await (const chunk of request) text += chunk;
  return text;
}

async function fixture(token: string) {
  const writes: { path: string; key: string | undefined; body: string }[] = [];
  let committedCreateBody: string | undefined;
  let observedConversation: URLSearchParams | undefined;
  let clarificationAnswered = false;
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      return json(response, { code: "unauthorized", error: "Authentication required." }, 401);
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith(route + "/")) return json(response, {}, 404);
    const path = url.pathname.slice(route.length);
    if (request.method === "GET") {
      if (path === sessionPath)
        return json(response, clarificationAnswered ? revisedSession : session);
      if (path === `/sessions/${id(21)}`) {
        return json(response, { code: "rate_limited", error: "Too many requests." }, 429, "3");
      }
      if (path === `${sessionPath}/artifacts/${artifactId}`) return json(response, artifact);
      if (path === `/runs/${runId}`) return json(response, run);
      if (path === `${sessionPath}/conversation`) {
        observedConversation = url.searchParams;
        return json(response, conversation);
      }
      return json(response, { code: "not_found", error: "No fixture route." }, 404);
    }
    const key = request.headers["idempotency-key"];
    const body = await readBody(request);
    writes.push({ path, key: typeof key === "string" ? key : undefined, body });
    if (path === "/sessions") {
      if (committedCreateBody === undefined) {
        committedCreateBody = body;
        // Commit the intent, then lose the response before the client can read it.
        response.destroy();
        return;
      }
      if (body !== committedCreateBody) {
        return json(response, { code: "idempotency_conflict", error: "The key was used." }, 409);
      }
      return json(response, { ...receipt, replayed: true });
    }
    if (path === `${sessionPath}/follow-ups`) {
      if (!clarificationAnswered) {
        return json(
          response,
          { code: "clarification_required", error: "Answer the question first." },
          409,
        );
      }
      return json(response, { ...receipt, runId: queuedRunId });
    }
    if (path === `${sessionPath}/clarifications/${clarificationId}/answers`) {
      clarificationAnswered = true;
      return json(response, { ...receipt, clarificationId, runId: revisedRunId });
    }
    if (path === `${sessionPath}/cancel`) {
      return json(response, { ...receipt, phaseStatus: "rejected", runIds: [queuedRunId] });
    }
    return json(response, { code: "not_found", error: "No fixture route." }, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("CLI fixture has no port.");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    writes,
    conversationQuery: () => observedConversation,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

let temp: string;
let cliPath: string;

beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), "wallie-factory-cli-"));
  const tempPackage = join(temp, "packages/factory-client");
  await Promise.all([
    mkdir(tempPackage, { recursive: true }),
    mkdir(join(temp, "examples"), { recursive: true }),
  ]);
  cliPath = join(temp, "examples/factory-cli.mjs");
  await Promise.all([
    copyFile(join(root, "examples/factory-cli.mjs"), cliPath),
    copyFile(join(clientDirectory, "package.json"), join(tempPackage, "package.json")),
    execute(
      process.execPath,
      [
        tsCompiler,
        "-p",
        join(clientDirectory, "tsconfig.json"),
        "--outDir",
        join(tempPackage, "dist"),
      ],
      { timeout: 20_000 },
    ),
  ]);
}, 25_000);

afterAll(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
});

function invoke(args: string[], env?: Record<string, string>) {
  return execute(process.execPath, [cliPath, ...args], {
    env: { ...env, NODE_ENV: "test" },
    timeout: 8_000,
  });
}

describe("Factory CLI example", () => {
  it("shows scoped help without credentials", async () => {
    const { stdout } = await invoke(["follow-up", "--help"]);
    expect(stdout).toContain("--artifact-version N --review-revision N");
    expect(stdout).toContain("WALLIE_API_TOKEN");
    expect(stdout).toContain("Open session.review.href");
  });

  it.each(["mt", "oa"])(
    "runs the exact workflow with a %s bearer",
    async (kind) => {
      const token = `wallie_${kind}_${id(30)}.${"h".repeat(43)}`;
      const connection = await fixture(token);
      const env = {
        WALLIE_API_ORIGIN: connection.origin,
        WALLIE_WORKSPACE_ID: workspaceId,
        WALLIE_FACTORY_ID: factoryId,
        WALLIE_API_TOKEN: token,
      };
      try {
        const create = [
          "create",
          "--title",
          "Plan a rollout",
          "--prompt",
          "Prepare the rollout.",
          "--agent-id",
          id(10),
          "--repository-id",
          id(11),
          "--draft-specification",
          "--idempotency-key",
          id(12),
        ];
        const created = factoryMutationResponseSchema.parse(
          JSON.parse((await invoke(create, env)).stdout),
        );
        expect(created).toEqual({ ...receipt, replayed: true });
        expect(connection.writes).toHaveLength(2);
        expect(connection.writes[0]).toEqual(connection.writes[1]);
        expect(connection.writes[0]?.key).toBe(id(12));
        expect(
          factoryMutationRoutes.create.body.parse(JSON.parse(connection.writes[0]!.body)),
        ).toEqual({
          title: "Plan a rollout",
          prompt: "Prepare the rollout.",
          agentId: id(10),
          repositoryId: id(11),
          draftSpecification: true,
        });

        const changed = create.map((argument) =>
          argument === "Plan a rollout" ? "Changed title" : argument,
        );
        await expect(invoke(changed, env)).rejects.toMatchObject({
          code: 1,
          stdout: "",
          stderr: "Wallie returned idempotency_conflict (HTTP 409).\n",
        });
        expect(connection.writes).toHaveLength(3);

        const selectors = ["--session-id", created.sessionId];
        if (!created.runId) throw new Error("The creation receipt did not contain a run.");
        const inspected = inspectedSessionSchema.parse(
          JSON.parse(
            (
              await invoke(
                ["inspect", ...selectors, "--artifact-id", artifactId, "--run-id", created.runId],
                env,
              )
            ).stdout,
          ),
        );
        expect(inspected).toEqual({ session, artifact, run });
        const target = inspected.session.review;
        if (!target?.clarification)
          throw new Error("The inspected session did not contain a question.");
        const exact = [
          "--artifact-id",
          target.artifactId,
          "--artifact-version",
          String(target.artifactVersion),
          "--review-revision",
          String(target.reviewRevision),
        ];
        const answer = await invoke(
          [
            "answer",
            ...selectors,
            ...exact,
            "--clarification-id",
            target.clarification.id,
            "--answer",
            "Start with the pilot group.",
            "--idempotency-key",
            id(14),
          ],
          env,
        );
        expect(JSON.parse(answer.stdout)).toEqual({
          ...receipt,
          clarificationId,
          runId: revisedRunId,
        });

        const revised = inspectedSessionSchema.parse(
          JSON.parse((await invoke(["inspect", ...selectors], env)).stdout),
        ).session.review;
        if (!revised) throw new Error("The revised artifact was not visible.");
        const followUp = await invoke(
          [
            "follow-up",
            ...selectors,
            "--stage-id",
            revised.stageId,
            "--artifact-id",
            revised.artifactId,
            "--artifact-version",
            String(revised.artifactVersion),
            "--review-revision",
            String(revised.reviewRevision),
            "--feedback",
            "Add an acceptance check.",
            "--idempotency-key",
            id(13),
          ],
          env,
        );
        const queued = factoryMutationResponseSchema.parse(JSON.parse(followUp.stdout));
        expect(queued).toEqual({ ...receipt, runId: queuedRunId });
        if (!queued.runId) throw new Error("The follow-up receipt did not contain a run.");
        const stopped = await invoke(
          ["cancel", ...selectors, "--expected-run-id", queued.runId, "--idempotency-key", id(15)],
          env,
        );
        expect(JSON.parse(stopped.stdout)).toMatchObject({ sessionId, runIds: [queuedRunId] });

        const write = (index: number) => ({
          ...connection.writes[index],
          body: JSON.parse(connection.writes[index]!.body),
        });
        expect(write(3)).toEqual({
          path: `${sessionPath}/clarifications/${clarificationId}/answers`,
          key: id(14),
          body: {
            artifactId,
            artifactVersion: 2,
            reviewRevision: 0,
            answer: "Start with the pilot group.",
          },
        });
        expect(write(4)).toEqual({
          path: `${sessionPath}/follow-ups`,
          key: id(13),
          body: {
            stageId,
            artifactId: revisedArtifactId,
            artifactVersion: 3,
            reviewRevision: 1,
            feedback: "Add an acceptance check.",
          },
        });
        expect(write(5)).toEqual({
          path: `${sessionPath}/cancel`,
          key: id(15),
          body: { expectedRunId: queuedRunId },
        });
        expect(connection.writes).toHaveLength(6);

        const resumed = await invoke(
          ["conversation", ...selectors, "--resume-cursor", resumeCursor, "--limit", "10"],
          env,
        );
        expect(JSON.parse(resumed.stdout)).toEqual(conversation);
        expect(Object.fromEntries(connection.conversationQuery()!)).toEqual({
          cursor: resumeCursor,
          direction: "after",
          limit: "10",
        });
        expect(resumed.stdout + resumed.stderr).not.toContain(token);
        await expect(invoke(["inspect", "--session-id", id(21)], env)).rejects.toMatchObject({
          code: 1,
          stdout: "",
          stderr: "Wallie returned rate_limited (HTTP 429). Retry after 3 seconds.\n",
        });
      } finally {
        await connection.close();
      }
    },
    20_000,
  );
});
