import { expect, test, type Page, type Request } from "@playwright/test";

import { signIn, WORKSPACE_PATH as workspacePath } from "./helpers/auth";

const detailPath = /^\/w\/acme-corp\/sessions\/\d+$/;

function isDetailRscRequest(request: Request) {
  const url = new URL(request.url());
  return request.headers().rsc === "1" && detailPath.test(url.pathname);
}

async function transferredBytes(requests: Request[]) {
  const sizes = await Promise.all(
    requests.map(async (request) => {
      try {
        const response = await Promise.race([
          request.response().then(async (response) => {
            await response?.finished();
            return request.sizes();
          }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
        ]);
        if (!response) return 0;
        return (
          response.requestBodySize +
          response.requestHeadersSize +
          response.responseBodySize +
          response.responseHeadersSize
        );
      } catch {
        return 0;
      }
    }),
  );
  return sizes.reduce((total, size) => total + size, 0);
}

async function measureClickToVisible(
  page: Page,
  click: () => Promise<void>,
  visible: () => Promise<void>,
) {
  const requests: Request[] = [];
  const onRequest = (request: Request) => requests.push(request);
  page.on("request", onRequest);
  const startedAt = await page.evaluate(() => performance.now());
  await click();
  await visible();
  const durationMs = await page.evaluate((start) => performance.now() - start, startedAt);
  await page.waitForTimeout(250);
  page.off("request", onRequest);
  return {
    durationMs: Math.round(durationMs),
    requestCount: requests.length,
    transferredBytes: await transferredBytes(requests),
  };
}

test("reports fixed-seed production interaction baselines without an elapsed-time gate", async ({
  page,
}) => {
  test.setTimeout(3 * 60_000);
  await page.addInitScript(() => {
    // Keep the benchmark deterministic and prevent its own run from emitting sampled custom RUM.
    window.sessionStorage.setItem("wallie-interaction-rum-sampled-v1", "0");
  });
  await signIn(page, `${workspacePath}/sessions`);

  const idleDetailRequests: Request[] = [];
  page.on("request", (request) => {
    if (isDetailRscRequest(request)) idleDetailRequests.push(request);
  });

  await page.goto(workspacePath);
  await expect(page.getByRole("heading", { name: "Pipeline", exact: true })).toBeVisible();
  await page.waitForTimeout(750);
  // Pipeline cards use Next.js <Link>; viewport prefetch is expected. Gate runaway fan-out.
  expect(
    idleDetailRequests.length,
    "Pipeline idle detail prefetches should stay bounded",
  ).toBeLessThan(20);
  const pipelineIdleDetailPrefetches = idleDetailRequests.length;
  idleDetailRequests.length = 0;

  const pipelineToSessions = await measureClickToVisible(
    page,
    () => page.getByRole("link", { name: "Sessions" }).first().click(),
    async () => {
      await expect(page).toHaveURL(`${workspacePath}/sessions`);
      await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
    },
  );
  await page.waitForTimeout(750);
  expect(
    idleDetailRequests.length,
    "Sessions idle detail prefetches should stay bounded",
  ).toBeLessThan(20);
  const sessionsIdleDetailPrefetches = idleDetailRequests.length;
  idleDetailRequests.length = 0;

  const firstDetailLink = page.locator(`a[href^="${workspacePath}/sessions/"]`).first();
  const destination = await firstDetailLink.getAttribute("href");
  expect(destination).toMatch(detailPath);
  if (!destination) throw new Error("Fixed seed did not provide a session detail link.");

  const sessionsToDetail = await measureClickToVisible(
    page,
    () => firstDetailLink.click(),
    async () => {
      await expect(page).toHaveURL(destination);
      await expect(page.locator("#main-content")).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    },
  );

  console.log(
    `interaction-benchmark ${JSON.stringify({
      pipelineIdleDetailPrefetches,
      pipelineToSessions,
      sessionsIdleDetailPrefetches,
      sessionsToDetail,
    })}`,
  );
});
