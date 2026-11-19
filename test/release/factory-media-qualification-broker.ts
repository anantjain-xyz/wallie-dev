import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

import {
  BROWSER_CAPTURE_POLICY,
  browserRunIdentitySchema,
  type BrowserRunIdentity,
} from "@/lib/validation-evidence/browser-contract";
import {
  createBrowserScreenshotRuntime,
  createBrowserVideoRuntime,
} from "@/lib/validation-evidence/browser-runtime";

const fixturePath = "/qualification";
const region = "qualification-region";
const ticketLifetimeMs = 30_000;
const brokerRequest = z.strictObject({
  nonce: z.string().uuid(),
  identity: browserRunIdentitySchema,
  path: z.literal(fixturePath),
  regionTestId: z.literal(region),
  policy: z.literal(BROWSER_CAPTURE_POLICY),
});

const document = `<!doctype html>
<title>Factory media qualification</title>
<style>
  body { font: 18px system-ui, sans-serif; background: #101722; color: #eff6ff; padding: 24px; }
  main { width: 440px; height: 230px; padding: 24px; background: #172b41; }
  summary { cursor: pointer; }
  section { margin-top: 12px; padding: 16px; background: #196c55; }
  [data-testid="private-canary"] { background: magenta; color: black; }
</style>
<main data-testid="${region}">
  <h1>Factory media qualification</h1>
  <details>
    <summary data-testid="qualification-action">Reveal the verified step</summary>
    <section>The verified step is visible.</section>
  </details>
  <p data-testid="private-canary">Synthetic excluded canary</p>
</main>`;
const documentSha256 = createHash("sha256").update(document).digest("hex");

type CaptureBinding = BrowserRunIdentity & { mode: "capture" | "reject" };

async function readBoundedRequest(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let count = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    count += bytes.length;
    if (count > 2 * 1024) throw new Error("Fixture request exceeded its byte limit.");
    chunks.push(bytes);
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return brokerRequest.parse(body);
}

async function encoderBinary(name: "ffmpeg" | "ffprobe", configured: string | undefined) {
  if (configured) {
    if (!isAbsolute(configured)) throw new Error(`${name} path must be absolute.`);
    await access(configured, constants.X_OK);
    return configured;
  }
  for (const directory of ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"]) {
    const path = join(directory, name);
    if (
      await access(path, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return path;
  }
  throw new Error(`The factory media qualification requires ${name}.`);
}

/** Serves a single synthetic fixture to the production Chromium adapters. */
export async function createFactoryMediaQualificationBroker() {
  const [ffmpeg, ffprobe] = await Promise.all([
    encoderBinary("ffmpeg", process.env.WALLIE_BROWSER_FFMPEG_PATH),
    encoderBinary("ffprobe", process.env.WALLIE_BROWSER_FFPROBE_PATH),
  ]);
  const token = randomBytes(32).toString("hex");
  const tickets = new Map<string, { expiresAt: number }>();
  let binding: CaptureBinding | undefined;
  let origin = "";
  let closePromise: Promise<void> | undefined;
  let authorizedRequests = 0;
  let documentReads = 0;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "", origin);
      const expected = binding;
      if (url.origin !== origin || !expected || closePromise) {
        response.writeHead(404).end();
        return;
      }
      if (request.method === "POST" && url.pathname === "/broker" && !url.search) {
        if (request.headers.authorization !== `Bearer ${token}`) {
          response.writeHead(403).end();
          return;
        }
        const body = await readBoundedRequest(request);
        const { identity } = body;
        if (
          expected !== binding ||
          identity.runId !== expected.runId ||
          identity.attemptCount !== expected.attemptCount ||
          identity.commitSha !== expected.commitSha ||
          identity.treeSha !== expected.treeSha ||
          tickets.size >= 8
        ) {
          response.writeHead(403).end();
          return;
        }
        authorizedRequests++;
        const ticket = randomBytes(24).toString("hex");
        const expiresAt = Date.now() + ticketLifetimeMs;
        tickets.set(ticket, { expiresAt });
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(
          JSON.stringify({
            ...body,
            expiresAt: new Date(expiresAt).toISOString(),
            previewUrl: `${origin}${fixturePath}?ticket=${ticket}`,
            documentSha256: expected.mode === "capture" ? documentSha256 : "0".repeat(64),
          }),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === fixturePath) {
        const ticket = url.searchParams.get("ticket") ?? "";
        const scope = tickets.get(ticket);
        tickets.delete(ticket);
        if (
          scope &&
          scope.expiresAt > Date.now() &&
          !request.headers.authorization &&
          !request.headers.cookie
        ) {
          documentReads++;
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          });
          response.end(document);
          return;
        }
      }
      response.writeHead(404).end();
    } catch {
      response.writeHead(400).end();
    }
  });
  server.requestTimeout = 12_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("The factory media loopback listener did not start.");
  }
  origin = `http://127.0.0.1:${address.port}`;

  return {
    forRun({
      runId,
      attemptCount = 1,
      commitSha,
      treeSha,
      screenshotScopeId,
      videoScopeId,
      mode,
    }: Omit<CaptureBinding, "attemptCount"> & {
      attemptCount?: number;
      screenshotScopeId: string;
      videoScopeId: string;
    }) {
      if (closePromise) throw new Error("The factory media broker has already closed.");
      const identity = browserRunIdentitySchema.parse({ runId, attemptCount, commitSha, treeSha });
      const environment = {
        WALLIE_BROWSER_FIXTURE_BROKER_URL: `${origin}/broker`,
        WALLIE_BROWSER_FIXTURE_BROKER_TOKEN: token,
        WALLIE_BROWSER_FIXTURE_ORIGIN: origin,
        WALLIE_BROWSER_FIXTURE_APPROVAL_SCOPE: screenshotScopeId,
        WALLIE_BROWSER_VIDEO_APPROVAL_SCOPE: videoScopeId,
        WALLIE_BROWSER_FFMPEG_PATH: ffmpeg,
        WALLIE_BROWSER_FFPROBE_PATH: ffprobe,
      };
      const browserRuntime = createBrowserScreenshotRuntime(environment);
      const browserVideoRuntime = createBrowserVideoRuntime(environment);
      if (!browserRuntime || !browserVideoRuntime) {
        throw new Error(
          "Factory media approval scopes could not initialize the production adapters.",
        );
      }
      tickets.clear();
      binding = { ...identity, mode };
      return { browserRuntime, browserVideoRuntime };
    },
    activity() {
      return { authorizedRequests, documentReads };
    },
    close() {
      if (!closePromise) {
        binding = undefined;
        tickets.clear();
        closePromise = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      }
      return closePromise;
    },
  };
}
