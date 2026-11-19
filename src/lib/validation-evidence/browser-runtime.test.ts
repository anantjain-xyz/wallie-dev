import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  BROWSER_CAPTURE_POLICY,
  browserRunIdentitySchema,
  type BrowserVerificationPlan,
} from "./browser-contract";
import { createBrowserScreenshotRuntime, createBrowserVideoRuntime } from "./browser-runtime";

const identity = {
  runId: "58400000-0000-4000-8000-000000000001",
  attemptCount: 2,
  commitSha: "a".repeat(40),
  treeSha: "b".repeat(40),
};
const scopeId = "58400000-0000-4000-8000-000000000002/capture";
const videoScopeId = "58400000-0000-4000-8000-000000000004/record_video";
const ffmpeg =
  process.env.WALLIE_BROWSER_FFMPEG_PATH ??
  (existsSync("/usr/bin/ffmpeg") ? "/usr/bin/ffmpeg" : "/opt/homebrew/bin/ffmpeg");
const ffprobe =
  process.env.WALLIE_BROWSER_FFPROBE_PATH ??
  (existsSync("/usr/bin/ffprobe") ? "/usr/bin/ffprobe" : "/opt/homebrew/bin/ffprobe");
const brokerToken = "synthetic-fixture-broker-token-only";
const baseCheck: BrowserVerificationPlan[number] = {
  key: "fixture",
  path: "/fixtures/first",
  timeoutSeconds: 10,
  interactions: [],
  regionTestId: "approved-region",
  excludedTestIds: [],
  evidence: [{ kind: "screenshot", required: true }],
};
const requestSchema = z.strictObject({
  nonce: z.string().uuid(),
  identity: browserRunIdentitySchema,
  path: z.string(),
  regionTestId: z.string(),
  policy: z.literal(BROWSER_CAPTURE_POLICY),
});
type FixtureRequest = z.infer<typeof requestSchema>;
type TargetReply = FixtureRequest & {
  expiresAt: string;
  previewUrl: string;
  documentSha256: string;
};

async function startFixture({
  getDocument = () => "<main data-testid='approved-region'>Example</main>",
  reply = (target) => target,
  mediaType = "text/html; charset=utf-8",
  ffmpegPath = ffmpeg,
}: {
  getDocument?: (path: string) => string;
  reply?: (target: TargetReply) => TargetReply;
  mediaType?: string;
  ffmpegPath?: string;
} = {}) {
  const brokerRequests: Array<{ authorization?: string; body: FixtureRequest }> = [];
  const previewRequests: Array<{ path: string; authorization?: string; cookie?: string }> = [];
  let origin = "";
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === "/broker") {
      let rawBody = "";
      for await (const chunk of request) rawBody += String(chunk);
      const body = requestSchema.parse(JSON.parse(rawBody));
      brokerRequests.push({ body, authorization: request.headers.authorization });
      const target = reply({
        ...body,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        previewUrl: origin + body.path + "?ticket=preview-only-ticket",
        documentSha256: createHash("sha256").update(getDocument(body.path)).digest("hex"),
      });
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(target));
      return;
    }
    previewRequests.push({
      path: url.pathname,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
    });
    response.writeHead(200, { "content-type": mediaType }).end(getDocument(url.pathname));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture listener missing.");
  origin = `http://127.0.0.1:${address.port}`;
  const environment = {
    WALLIE_BROWSER_FIXTURE_BROKER_URL: origin + "/broker",
    WALLIE_BROWSER_FIXTURE_BROKER_TOKEN: brokerToken,
    WALLIE_BROWSER_FIXTURE_ORIGIN: origin,
    WALLIE_BROWSER_FIXTURE_APPROVAL_SCOPE: scopeId,
  };
  const runtime = createBrowserScreenshotRuntime(environment);
  const videoEnvironment = {
    ...environment,
    WALLIE_BROWSER_VIDEO_APPROVAL_SCOPE: videoScopeId,
    WALLIE_BROWSER_FFMPEG_PATH: ffmpegPath,
    WALLIE_BROWSER_FFPROBE_PATH: ffprobe,
  };
  const videoRuntime = createBrowserVideoRuntime(videoEnvironment);
  if (!runtime || !videoRuntime) throw new Error("Fixture runtime is not configured.");
  return {
    brokerRequests,
    previewRequests,
    runtime,
    videoRuntime,
    videoEnvironment,
    async stop() {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await closed;
    },
  };
}

describe("browser fixture authority", () => {
  it("is unavailable without an operator configuration", () => {
    expect(createBrowserScreenshotRuntime({})).toBeNull();
    expect(
      createBrowserScreenshotRuntime({
        WALLIE_BROWSER_FIXTURE_BROKER_URL: "http://fixture.example.test/broker",
        WALLIE_BROWSER_FIXTURE_ORIGIN: "https://fixture.example.test",
        WALLIE_BROWSER_FIXTURE_BROKER_TOKEN: brokerToken,
        WALLIE_BROWSER_FIXTURE_APPROVAL_SCOPE: scopeId,
      }),
    ).toBeNull();
  });

  it("does not contact the broker for an invalid source path", async () => {
    const fixture = await startFixture();
    try {
      const result = await fixture.runtime.captureScreenshot({
        identity,
        check: { ...baseCheck, path: "https://fixture.example.test" },
      });
      expect(result).toEqual({ status: "failed", reason: "source_changed" });
      expect(fixture.brokerRequests).toHaveLength(0);
    } finally {
      await fixture.stop();
    }
  });

  it.each([
    (r: TargetReply) => ({ ...r, identity: { ...r.identity, attemptCount: 3 } }),
    (r: TargetReply) => ({ ...r, identity: { ...r.identity, commitSha: "c".repeat(40) } }),
    (r: TargetReply) => ({ ...r, identity: { ...r.identity, treeSha: "c".repeat(40) } }),
    (r: TargetReply) => ({ ...r, nonce: "58400000-0000-4000-8000-000000000003" }),
    (r: TargetReply) => ({ ...r, path: "/another" }),
    (r: TargetReply) => ({ ...r, regionTestId: "another" }),
    (r: TargetReply) => ({ ...r, previewUrl: "https://unapproved.example.test/fixtures/first" }),
    (r: TargetReply) => ({ ...r, expiresAt: "2020-01-01T00:00:00.000Z" }),
  ])("rejects mismatched and expired broker claims before fetching a document", async (reply) => {
    const fixture = await startFixture({ reply });
    try {
      await expect(
        fixture.runtime.captureScreenshot({ identity, check: baseCheck }),
      ).resolves.toEqual({ status: "unavailable", reason: "isolated_target_unavailable" });
      expect(fixture.brokerRequests).toHaveLength(1);
      expect(fixture.previewRequests).toHaveLength(0);
    } finally {
      await fixture.stop();
    }
  });

  it.each([
    { mediaType: "image/png" },
    { reply: (r: TargetReply) => ({ ...r, documentSha256: "c".repeat(64) }) },
  ])("rejects mismatched document types and bytes", async (config) => {
    const fixture = await startFixture(config);
    try {
      await expect(
        fixture.runtime.captureScreenshot({ identity, check: baseCheck }),
      ).resolves.toEqual({ status: "unavailable", reason: "isolated_target_unavailable" });
      expect(fixture.previewRequests).toHaveLength(1);
    } finally {
      await fixture.stop();
    }
  });
});

const region = "position:absolute;left:30px;top:20px;width:240px;height:150px";
const canary = "position:absolute;left:70px;top:55px;width:40px;height:33px";
const firstDocument = `<!doctype html>
  <main data-testid="approved-region" style="${region};background:rgb(12,100,180)">
    <button data-testid="toggle">Update fixture</button>
    <strong data-testid="updated" hidden>Updated</strong>
    <div data-testid="private-example" style="${canary};background:rgb(255,0,255)">explicit secret</div>
    <div data-wallie-credential style="${canary};left:115px;background:rgb(251,9,22)">credential secret</div>
    <div data-wallie-private style="${canary};left:160px;background:rgb(245,211,1)">private secret</div>
  </main>
  <aside style="${canary};left:230px;top:115px;background:rgb(3,255,7);z-index:4">outside region</aside>
  <script>
    document.querySelector('button').addEventListener('click', () => {
      document.cookie = 'synthetic-session=fixture-one; Path=/; Secure';
      localStorage.setItem('first-fixture', 'synthetic-session');
      document.querySelector('main').style.background = 'rgb(16,120,80)';
      document.querySelector('strong').hidden = false;
    });
  </script>`;

const secondDocument = `<!doctype html>
  <main data-testid="approved-region" style="${region};background:rgb(85,28,77)">fresh fixture</main>
  <script>
    if (document.cookie !== '' || localStorage.length || location.search) {
      document.querySelector('main').style.background = 'rgb(255,54,10)';
    }
  </script>`;

async function inspectPixels(buffers: Buffer[]) {
  const browser = await chromium.launch({ chromiumSandbox: true });
  try {
    const page = await browser.newPage();
    return await page.evaluate(
      async (pngs) => {
        const results = [];
        for (const png of pngs) {
          const image = new Image();
          image.src = `data:image/png;base64,${png}`;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Could not inspect fixture pixels.");
          context.drawImage(image, 0, 0);
          const { data } = context.getImageData(0, 0, image.width, image.height);
          const colors = new Set<string>();
          for (let i = 0; i < data.length; i += 4) {
            colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
          }
          results.push({ width: image.width, height: image.height, colors: [...colors] });
        }
        return results;
      },
      buffers.map((bytes) => bytes.toString("base64")),
    );
  } finally {
    await browser.close();
  }
}

const realBrowserAvailable =
  process.env.WALLIE_REQUIRE_BROWSER_CAPTURE_TESTS === "1" || existsSync(chromium.executablePath());

describe.skipIf(!realBrowserAvailable)("real isolated Chromium capture", () => {
  it("excludes visible canary pixels and starts every capture with fresh cookies and storage", async () => {
    const fixture = await startFixture({
      getDocument: (path) => (path === baseCheck.path ? firstDocument : secondDocument),
    });
    try {
      const first = await fixture.runtime.captureScreenshot({
        identity,
        check: {
          ...baseCheck,
          interactions: [
            { action: "click", testId: "toggle" },
            { action: "expectVisible", testId: "updated" },
          ],
          excludedTestIds: ["private-example"],
        },
      });
      const second = await fixture.runtime.captureScreenshot({
        identity,
        check: { ...baseCheck, path: "/fixtures/second" },
      });
      expect(first).toMatchObject({ status: "captured", identity, path: baseCheck.path });
      expect(second).toMatchObject({ status: "captured", identity, path: "/fixtures/second" });
      if (first.status !== "captured" || second.status !== "captured") {
        throw new Error("Expected both isolated screenshots.");
      }
      expect(first.browserSessionId).not.toBe(second.browserSessionId);
      const [firstPixels, secondPixels] = await inspectPixels([first.bytes, second.bytes]);
      expect(firstPixels).toMatchObject({ width: 240, height: 150 });
      expect(firstPixels?.colors).toContain("16,120,80");
      for (const privateColor of ["255,0,255", "251,9,22", "245,211,1", "3,255,7"]) {
        expect(firstPixels?.colors).not.toContain(privateColor);
      }
      expect(secondPixels?.colors).toContain("85,28,77");
      expect(secondPixels?.colors).not.toContain("255,54,10");
      expect(fixture.runtime.approvalScopeId).toBe(scopeId);
      expect(fixture.brokerRequests.map(({ authorization }) => authorization)).toEqual([
        "Bearer " + brokerToken,
        "Bearer " + brokerToken,
      ]);
      expect(fixture.previewRequests).toEqual([
        { path: baseCheck.path, authorization: undefined, cookie: undefined },
        { path: "/fixtures/second", authorization: undefined, cookie: undefined },
      ]);
    } finally {
      await fixture.stop();
    }
  }, 30_000);

  it("fails closed on an excluded capture region and does not return pixels", async () => {
    const fixture = await startFixture({
      getDocument: () =>
        `<main data-wallie-private data-testid="approved-region" style="${region}">Canary</main>`,
    });
    try {
      await expect(
        fixture.runtime.captureScreenshot({ identity, check: baseCheck }),
      ).resolves.toEqual({ status: "failed", reason: "policy_excluded" });
    } finally {
      await fixture.stop();
    }
  }, 15_000);

  it("rejects closed shadow content instead of capturing pixels it cannot inspect", async () => {
    const fixture = await startFixture({
      getDocument: () => `<main data-testid="approved-region" style="${region}"><div></div></main>
        <script>document.querySelector('div').attachShadow({mode:'closed'}).textContent = 'uninspectable';</script>`,
    });
    try {
      await expect(
        fixture.runtime.captureScreenshot({ identity, check: baseCheck }),
      ).resolves.toEqual({ status: "failed", reason: "policy_excluded" });
    } finally {
      await fixture.stop();
    }
  }, 15_000);

  it("blocks navigation side effects even on the sealed fixture origin", async () => {
    const fixture = await startFixture({
      getDocument: () => `<main data-testid="approved-region" style="${region}">
        <a href="/side-effect" data-testid="navigate">Leave fixture</a>
      </main>`,
    });
    try {
      const result = await fixture.runtime.captureScreenshot({
        identity,
        check: { ...baseCheck, interactions: [{ action: "click", testId: "navigate" }] },
      });
      expect(result.status).toBe("failed");
      expect(fixture.previewRequests.map(({ path }) => path)).toEqual([baseCheck.path]);
    } finally {
      await fixture.stop();
    }
  }, 15_000);
});

const videoCheck: BrowserVerificationPlan[number] = {
  ...baseCheck,
  evidence: [{ kind: "video", required: true }],
  interactions: [
    { action: "click", testId: "toggle" },
    { action: "expectVisible", testId: "updated" },
  ],
  excludedTestIds: ["private-example"],
};
const realVideoAvailable =
  process.env.WALLIE_REQUIRE_BROWSER_VIDEO_TESTS === "1" ||
  (realBrowserAvailable && existsSync(ffmpeg) && existsSync(ffprobe));

function decodeFrames(bytes: Buffer, width: number, height: number, count: number) {
  const frameSize = width * height * 3;
  const decoded = execFileSync(
    ffmpeg,
    ["-v", "error", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { input: bytes, maxBuffer: frameSize * count + 1 },
  );
  expect(decoded.length).toBe(frameSize * count);
  return Array.from({ length: count }, (_, index) =>
    decoded.subarray(index * frameSize, (index + 1) * frameSize),
  );
}

function containsColor(frame: Buffer, color: [number, number, number]) {
  for (let index = 0; index < frame.length; index += 3) {
    if (color.every((channel, offset) => Math.abs(channel - frame[index + offset]) <= 18)) {
      return true;
    }
  }
  return false;
}

describe.skipIf(!realVideoAvailable)("real isolated WebM recording", () => {
  it("verifies every decoded frame and keeps a new session free of prior storage", async () => {
    const changingSecrets = firstDocument.replace(
      "document.querySelector('strong').hidden = false;",
      `document.querySelector('strong').hidden = false;
        document.querySelector('[data-wallie-credential]').style.left = '55px';
        document.querySelector('[data-wallie-private]').style.top = '100px';
        document.querySelector('[data-wallie-private]').style.background = 'rgb(255,70,10)';`,
    );
    const fixture = await startFixture({
      getDocument: (path) => (path === baseCheck.path ? changingSecrets : secondDocument),
    });
    try {
      const first = await fixture.videoRuntime.captureVideo({ identity, check: videoCheck });
      const second = await fixture.videoRuntime.captureVideo({
        identity,
        check: { ...videoCheck, path: "/fixtures/second", interactions: [], excludedTestIds: [] },
      });
      expect(first).toMatchObject({
        status: "captured",
        identity,
        timeline: { widthPx: 240, heightPx: 150, frameOffsetsMs: [0, 500, 1000], durationMs: 1500 },
      });
      expect(second).toMatchObject({
        status: "captured",
        timeline: { widthPx: 240, heightPx: 150, frameOffsetsMs: [0], durationMs: 500 },
      });
      if (first.status !== "captured" || second.status !== "captured") {
        throw new Error("Expected two complete isolated clips.");
      }
      expect(first.browserSessionId).not.toBe(second.browserSessionId);
      expect(Date.parse(first.completedAt)).toBeGreaterThanOrEqual(Date.parse(first.startedAt));
      const frames = decodeFrames(first.bytes, 240, 150, 3);
      const fresh = decodeFrames(second.bytes, 240, 150, 1)[0];
      expect(containsColor(frames[0], [12, 100, 180])).toBe(true);
      for (const frame of frames.slice(1)) {
        expect(containsColor(frame, [16, 120, 80])).toBe(true);
      }
      for (const frame of frames) {
        for (const excluded of [
          [255, 0, 255],
          [251, 9, 22],
          [245, 211, 1],
          [3, 255, 7],
          [255, 70, 10],
        ] as const) {
          expect(containsColor(frame, [...excluded])).toBe(false);
        }
      }
      expect(containsColor(fresh, [85, 28, 77])).toBe(true);
      expect(containsColor(fresh, [255, 54, 10])).toBe(false);
      expect(fixture.videoRuntime.approvalScopeId).toBe(videoScopeId);
      expect(
        fixture.previewRequests.every(({ authorization, cookie }) => !authorization && !cookie),
      ).toBe(true);
    } finally {
      await fixture.stop();
    }
  }, 30_000);

  it("captures an isolated clip when the Node worker loads TypeScript", async () => {
    const fixture = await startFixture({ getDocument: () => firstDocument });
    try {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          "--import",
          "./scripts/register-server-only.mjs",
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `const mod = await import("./src/lib/validation-evidence/browser-runtime.ts");
           const createRuntime = mod.createBrowserVideoRuntime ?? mod.default?.createBrowserVideoRuntime;
           const result = await createRuntime().captureVideo(JSON.parse(process.argv[1]));
           console.log(JSON.stringify({ status: result.status, timeline: result.timeline }));`,
          JSON.stringify({ identity, check: videoCheck }),
        ],
        { env: { ...process.env, ...fixture.videoEnvironment }, timeout: 15_000 },
      );
      expect(JSON.parse(stdout)).toEqual({
        status: "captured",
        timeline: { widthPx: 240, heightPx: 150, frameOffsetsMs: [0, 500, 1000], durationMs: 1500 },
      });
    } finally {
      await fixture.stop();
    }
  }, 20_000);

  it("discards the whole recording when an interaction makes a later frame unsafe", async () => {
    const fixture = await startFixture({
      getDocument: () => `<main data-testid="approved-region" style="${region}">
        <button data-testid="hide" onclick="this.parentNode.setAttribute('data-wallie-private','')">Hide</button>
      </main>`,
    });
    try {
      await expect(
        fixture.videoRuntime.captureVideo({
          identity,
          check: {
            ...videoCheck,
            interactions: [{ action: "click", testId: "hide" }],
            excludedTestIds: [],
          },
        }),
      ).resolves.toEqual({ status: "failed", reason: "policy_excluded" });
    } finally {
      await fixture.stop();
    }
  }, 15_000);

  it("discards the whole recording when a successful encoder leaves truncated output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wallie-truncated-webm-test-"));
    try {
      const ffmpegPath = join(directory, "truncate-output.cjs");
      await writeFile(
        ffmpegPath,
        `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const { truncateSync } = require("node:fs");
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(ffmpeg)}, args, { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
truncateSync(args.at(-1), 64);
`,
        { mode: 0o700 },
      );
      const fixture = await startFixture({ getDocument: () => firstDocument, ffmpegPath });
      try {
        await expect(
          fixture.videoRuntime.captureVideo({ identity, check: videoCheck }),
        ).resolves.toEqual({ status: "failed", reason: "capture_failed" });
      } finally {
        await fixture.stop();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("never finishes a cancelled workflow", async () => {
    const fixture = await startFixture({ getDocument: () => firstDocument });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_000);
    try {
      await expect(
        fixture.videoRuntime.captureVideo({
          identity,
          check: {
            ...videoCheck,
            interactions: [{ action: "expectVisible", testId: "never-visible" }],
          },
          signal: controller.signal,
        }),
      ).resolves.toEqual({ status: "failed", reason: "capture_failed" });
    } finally {
      clearTimeout(timer);
      await fixture.stop();
    }
  }, 15_000);
});
