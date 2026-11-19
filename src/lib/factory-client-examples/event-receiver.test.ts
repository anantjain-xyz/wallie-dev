import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, expect, it } from "vitest";

const program = fileURLToPath(
  new URL("../../../examples/factory-event-receiver.mjs", import.meta.url),
);
const secret = "fixture-only signing key ‰";
const contentType = { "Content-Type": "application/json" };

let directory: string;
const receivers = new Set<{ stop: () => Promise<void> }>();

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "wallie-event-receiver-"));
});

afterEach(async () => {
  await Promise.all([...receivers].map((receiver) => receiver.stop()));
  await rm(directory, { recursive: true, force: true });
});

async function startReceiver() {
  const child = spawn(process.execPath, [program], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      NODE_ENV: "test",
      WALLIE_WEBHOOK_SIGNING_SECRET: secret,
      WALLIE_EVENT_DIR: directory,
      PORT: "0",
    },
  });
  const output = createInterface({ input: child.stdout });
  const closed = once(child, "close");
  let error = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    error += chunk;
  });
  const receiver = {
    async stop() {
      child.kill();
      await closed;
      receivers.delete(receiver);
    },
  };
  receivers.add(receiver);
  const line = await Promise.race([
    once(output, "line", { signal: AbortSignal.timeout(4000) }).then(([value]) => String(value)),
    closed.then(() => {
      throw new Error(`The receiver stopped before listening. ${error}`);
    }),
  ]);
  const url = /^Listening at (http:\/\/127\.0\.0\.1:\d+\/wallie\/events)$/.exec(line)?.[1];
  if (!url) throw new Error(`Unexpected receiver address. ${line}`);
  return { ...receiver, url };
}

function runEvent() {
  return {
    version: 1,
    eventId: randomUUID(),
    type: "run.started",
    occurredAt: new Date().toISOString(),
    workspaceId: randomUUID(),
    factoryId: randomUUID(),
    sessionId: randomUUID(),
    sessionNumber: 7,
    runId: randomUUID(),
    stageId: randomUUID(),
    attemptCount: 1,
    runStatus: "running",
  };
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function signedHeaders(
  body: string,
  event: { eventId: string; type: string },
  timestamp = nowSeconds(),
  key = secret,
) {
  const signature = createHmac("sha256", key)
    .update(`${timestamp}.${event.eventId}.`)
    .update(body)
    .digest("hex");
  return {
    ...contentType,
    "Wallie-Event-Id": event.eventId,
    "Wallie-Event-Type": event.type,
    "Wallie-Signature": `t=${timestamp},v1=${signature}`,
  };
}

function post(url: string, body: string, headers: HeadersInit = contentType) {
  return fetch(url, { method: "POST", body, headers, signal: AbortSignal.timeout(4000) });
}

function postOversizedChunks(url: string) {
  return new Promise<number | undefined>((resolve, reject) => {
    const exchange = request(
      url,
      {
        method: "POST",
        headers: contentType,
        signal: AbortSignal.timeout(4000),
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    exchange.on("error", reject);
    exchange.write("a".repeat(5 * 1024));
    exchange.end("b".repeat(5 * 1024));
  });
}

it("echoes the ownership challenge without creating an event receipt", async () => {
  const { url } = await startReceiver();
  const challenge = randomBytes(32).toString("base64url");
  const body = JSON.stringify({ type: "wallie.subscription.verification", challenge });
  const verification = await post(url, body);
  expect(verification.status).toBe(204);
  expect(verification.headers.get("Wallie-Verification")).toBe(challenge);

  const malformed = await post(
    url,
    JSON.stringify({ type: "wallie.subscription.verification", challenge: `${challenge}\n` }),
  );
  expect(malformed.status).toBe(400);
  const untrustedSignature = await post(url, body, { ...contentType, "Wallie-Signature": "bad" });
  expect(untrustedSignature.status).toBe(400);
  expect(untrustedSignature.headers.get("Wallie-Verification")).toBeNull();
  expect(await readdir(directory)).toEqual([]);
});

it("verifies HMAC over exact bytes, rejects invalid deliveries, and bounds the body", async () => {
  const { url } = await startReceiver();
  const event = runEvent();
  const body = JSON.stringify(event, null, 2) + "\n";
  const headers = signedHeaders(body, event);
  const incorrectByte = await post(url, JSON.stringify(event), headers);
  expect(incorrectByte.status).toBe(401);
  expect((await post(url, body, signedHeaders(body, event, nowSeconds() - 301))).status).toBe(401);
  expect((await post(url, body, signedHeaders(body, event, nowSeconds() + 301))).status).toBe(401);
  expect(
    (await post(url, body, signedHeaders(body, event, nowSeconds(), "wrong secret"))).status,
  ).toBe(401);
  const wrongId = { ...event, eventId: randomUUID() };
  expect((await post(url, body, signedHeaders(body, wrongId))).status).toBe(400);
  expect((await post(url, body, { ...headers, "Wallie-Event-Type": "run.completed" })).status).toBe(
    400,
  );
  const missingRun = JSON.stringify({ ...event, runId: undefined });
  expect((await post(url, missingRun, signedHeaders(missingRun, event))).status).toBe(400);
  expect((await post(url, body.repeat(40), headers)).status).toBe(413);
  expect(await postOversizedChunks(url)).toBe(413);
  expect(await readdir(directory)).toEqual([]);

  expect((await post(url, body, headers)).status).toBe(204);
  expect(await readFile(join(directory, `${event.eventId}.json`), "utf8")).toBe(body);
});

it("writes once across concurrent receivers and preserves the receipt after restart", async () => {
  const [first, second] = await Promise.all([startReceiver(), startReceiver()]);
  const event = runEvent();
  const body = JSON.stringify(event);
  const receipt = `${event.eventId}.json`;
  const sends = Array.from({ length: 12 }, (_, index) =>
    post(index % 2 ? first.url : second.url, body, signedHeaders(body, event)),
  );
  expect((await Promise.all(sends)).map((response) => response.status)).toEqual(
    Array(12).fill(204),
  );
  expect(await readdir(directory)).toEqual([receipt]);
  expect(await readFile(join(directory, receipt), "utf8")).toBe(body);
  await Promise.all([first.stop(), second.stop()]);

  const restarted = await startReceiver();
  expect((await post(restarted.url, `${body}\n`, signedHeaders(`${body}\n`, event))).status).toBe(
    204,
  );
  expect(
    (await post(restarted.url, body, signedHeaders(body, event, nowSeconds(), "wrong secret")))
      .status,
  ).toBe(401);
  expect(await readdir(directory)).toEqual([receipt]);
  expect(await readFile(join(directory, receipt), "utf8")).toBe(body);
});

it("recovers an interrupted staging write without accepting an empty receipt", async () => {
  const { url } = await startReceiver();
  const event = runEvent();
  const body = JSON.stringify(event);
  const orphan = `.${event.eventId}.${randomUUID()}.tmp`;
  const receipt = `${event.eventId}.json`;
  await writeFile(join(directory, orphan), "{", { mode: 0o600 });
  expect((await post(url, body, signedHeaders(body, event))).status).toBe(204);
  expect((await readdir(directory)).sort()).toEqual([orphan, receipt]);
  expect(await readFile(join(directory, receipt), "utf8")).toBe(body);

  const absent = runEvent();
  const emptyReceipt = join(directory, `${absent.eventId}.json`);
  // A pre-existing, incomplete destination cannot pass the example's duplicate check.
  await writeFile(emptyReceipt, "", { mode: 0o600 });
  const absentBody = JSON.stringify(absent);
  expect((await post(url, absentBody, signedHeaders(absentBody, absent))).status).toBe(500);
});
