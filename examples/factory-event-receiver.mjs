import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { link, mkdir, open, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

const endpoint = "/wallie/events";
const host = "127.0.0.1";
const maxBodyBytes = 8 * 1024;
const maxSkewSeconds = 5 * 60;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const challenge = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const eventTypes = new Set([
  "session.created",
  "session.canceled",
  "run.started",
  "run.completed",
  "conversation.message_added",
  "review.ready",
  "review.approved",
  "review.changes_requested",
  "review.clarification_requested",
  "review.clarification_answered",
]);
const completedStatuses = new Set(["success", "error", "canceled"]);

const usage = `Usage: WALLIE_WEBHOOK_SIGNING_SECRET=<secret> WALLIE_EVENT_DIR=<private directory> node examples/factory-event-receiver.mjs

Listens on http://${host}:8789${endpoint}. Set PORT to choose a different local port.
Each verified delivery is stored once as <eventId>.json.`;

function singleHeader(request, name) {
  const values = request.headersDistinct[name];
  return values?.length === 1 ? values[0] : undefined;
}

async function readBody(request) {
  const length = singleHeader(request, "content-length");
  if (length !== undefined && Number(length) > maxBodyBytes) return null;

  const bytes = Buffer.alloc(maxBodyBytes);
  let offset = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    if (chunk.length > bytes.length - offset) return null;
    offset += chunk.copy(bytes, offset);
  }
  return bytes.subarray(0, offset);
}

function readJson(body) {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function isUuid(value) {
  return typeof value === "string" && value.length === 36 && uuid.test(value);
}

function isCount(value, minimum = 1) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function isEvent(value, eventId, eventType) {
  if (
    !value ||
    value.version !== 1 ||
    value.eventId !== eventId ||
    value.type !== eventType ||
    !isUuid(value.workspaceId) ||
    !isUuid(value.factoryId) ||
    !isUuid(value.sessionId) ||
    !isCount(value.sessionNumber) ||
    typeof value.occurredAt !== "string" ||
    value.occurredAt.trim() !== value.occurredAt ||
    !timestamp.test(value.occurredAt) ||
    !Number.isFinite(Date.parse(value.occurredAt))
  ) {
    return false;
  }

  const {
    runId,
    stageId,
    artifactId,
    clarificationId,
    attemptCount,
    artifactVersion,
    messageSequence,
    runStatus,
  } = value;
  if (
    ![runId, stageId, artifactId, clarificationId].every((id) => id === undefined || isUuid(id)) ||
    (attemptCount !== undefined && !isCount(attemptCount, 0)) ||
    (artifactVersion !== undefined && !isCount(artifactVersion)) ||
    (messageSequence !== undefined && !isCount(messageSequence)) ||
    (runStatus !== undefined && runStatus !== "running" && !completedStatuses.has(runStatus))
  ) {
    return false;
  }

  switch (eventType) {
    case "run.started":
      return isUuid(runId) && isCount(attemptCount) && runStatus === "running";
    case "run.completed":
      return isUuid(runId) && completedStatuses.has(runStatus);
    case "conversation.message_added":
      return isCount(messageSequence);
    case "review.ready":
    case "review.approved":
    case "review.changes_requested":
      return isUuid(artifactId) && isCount(artifactVersion);
    case "review.clarification_requested":
    case "review.clarification_answered":
      return isUuid(clarificationId) && isUuid(artifactId) && isCount(artifactVersion);
    default:
      return true;
  }
}

function validSignature({ header, eventId, body, secret }) {
  const match =
    typeof header === "string" && /^t=(0|[1-9]\d{0,14}),v1=([0-9a-f]{64})$/.exec(header);
  if (!match || Math.abs(Math.floor(Date.now() / 1000) - Number(match[1])) > maxSkewSeconds) {
    return false;
  }

  const expected = createHmac("sha256", secret)
    .update(`${match[1]}.${eventId}.`)
    .update(body)
    .digest();
  return timingSafeEqual(expected, Buffer.from(match[2], "hex"));
}

async function storeEvent(directory, eventId, body) {
  const candidate = join(directory, `.${eventId}.${randomUUID()}.tmp`);
  const receipt = join(directory, `${eventId}.json`);
  const file = await open(candidate, "wx", 0o600);
  try {
    try {
      await file.writeFile(body);
      await file.sync();
    } finally {
      await file.close();
    }
    // A hard link publishes the whole file without overwriting an existing receipt.
    try {
      await link(candidate, receipt);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await stat(receipt);
      if (!existing.isFile() || existing.size === 0) throw error;
    }
    const folder = await open(directory);
    try {
      await folder.sync();
    } finally {
      await folder.close();
    }
  } finally {
    await rm(candidate, { force: true });
  }
}

function respond(response, status, headers) {
  response.writeHead(status, { "Cache-Control": "no-store", ...headers });
  response.end();
}

async function handleRequest(request, response, { directory, secret }) {
  if (request.url !== endpoint) return respond(response, 404);
  if (request.method !== "POST") return respond(response, 405, { Allow: "POST" });
  const contentType = singleHeader(request, "content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return respond(response, 415);

  const body = await readBody(request);
  if (!body) return respond(response, 413, { Connection: "close" });

  const eventId = singleHeader(request, "wallie-event-id");
  const eventType = singleHeader(request, "wallie-event-type");
  const signature = singleHeader(request, "wallie-signature");
  if (
    !["wallie-event-id", "wallie-event-type", "wallie-signature"].some(
      (name) => name in request.headersDistinct,
    )
  ) {
    const verification = readJson(body);
    if (
      verification?.type !== "wallie.subscription.verification" ||
      typeof verification.challenge !== "string" ||
      verification.challenge.length !== 43 ||
      !challenge.test(verification.challenge)
    ) {
      return respond(response, 400);
    }
    return respond(response, 204, { "Wallie-Verification": verification.challenge });
  }

  if (!isUuid(eventId) || !eventTypes.has(eventType)) return respond(response, 400);
  if (!validSignature({ header: signature, eventId, body, secret })) return respond(response, 401);
  if (!isEvent(readJson(body), eventId, eventType)) return respond(response, 400);

  await storeEvent(directory, eventId, body);
  return respond(response, 204);
}

async function start() {
  if (process.argv.length === 3 && process.argv[2] === "--help") {
    process.stdout.write(`${usage}\n`);
    return;
  }

  const {
    WALLIE_WEBHOOK_SIGNING_SECRET: secret,
    WALLIE_EVENT_DIR: path,
    PORT: portText = "8789",
  } = process.env;
  const port = Number(portText);
  if (
    process.argv.length !== 2 ||
    !secret ||
    !path ||
    !/^\d{1,5}$/.test(portText) ||
    port > 65535
  ) {
    process.stderr.write(`${usage}\n`);
    process.exitCode = 1;
    return;
  }

  const directory = resolve(path);
  await mkdir(directory, { mode: 0o700, recursive: true });
  if ((await stat(directory)).mode & 0o077) {
    process.stderr.write("WALLIE_EVENT_DIR must be private to the current user (mode 0700).\n");
    process.exitCode = 1;
    return;
  }

  const server = createServer(
    { requestTimeout: 10_000, headersTimeout: 5_000 },
    (request, response) => {
      void handleRequest(request, response, { directory, secret }).catch(() => {
        respond(response, 500, { Connection: "close" });
      });
    },
  );
  server.on("error", () => {
    process.stderr.write("Could not listen for Wallie events. Check PORT.\n");
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    process.stdout.write(`Listening at http://${host}:${server.address().port}${endpoint}\n`);
  });
}

start().catch(() => {
  process.stderr.write("Could not initialize the Wallie event receiver. Check WALLIE_EVENT_DIR.\n");
  process.exitCode = 1;
});
