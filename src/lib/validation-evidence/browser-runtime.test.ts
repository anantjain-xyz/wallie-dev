import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  BROWSER_CAPTURE_POLICY,
  browserRunIdentitySchema,
  type BrowserVerificationPlan,
} from "./browser-contract";
import { createBrowserScreenshotRuntime } from "./browser-runtime";

const identity = {
  runId: "58400000-0000-4000-8000-000000000001",
  attemptCount: 2,
  commitSha: "a".repeat(40),
  treeSha: "b".repeat(40),
};
const scopeId = "58400000-0000-4000-8000-000000000002/capture";
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
}: {
  getDocument?: (path: string) => string;
  reply?: (target: TargetReply) => TargetReply;
  mediaType?: string;
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
  const runtime = createBrowserScreenshotRuntime({
    WALLIE_BROWSER_FIXTURE_BROKER_URL: origin + "/broker",
    WALLIE_BROWSER_FIXTURE_BROKER_TOKEN: brokerToken,
    WALLIE_BROWSER_FIXTURE_ORIGIN: origin,
    WALLIE_BROWSER_FIXTURE_APPROVAL_SCOPE: scopeId,
  });
  if (!runtime) throw new Error("Fixture runtime is not configured.");
  return {
    brokerRequests,
    previewRequests,
    runtime,
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
