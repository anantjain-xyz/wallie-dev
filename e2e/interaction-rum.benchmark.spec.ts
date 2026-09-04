import { expect, test, type Page, type Request } from "@playwright/test";

import { signIn } from "./helpers/auth";

const workspacePath = "/w/acme-corp";
const detailPath = /^\/w\/acme-corp\/sessions\/\d+$/;

function isDetailRscRequest(request: Request) {
  const url = new URL(request.url());
  return request.headers().rsc === "1" && detailPath.test(url.pathname);
}

async function transferredBytes(requests: Request[]) {
  const sizes = await Promise.all(
    requests.map(async (request) => {
      try {
        const size = await request.sizes();
        return (
          size.requestBodySize +
          size.requestHeadersSize +
          size.responseBodySize +
          size.responseHeadersSize
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
  const completed = new Set<Request>();
  const failed = new Set<Request>();
  const onRequest = (request: Request) => requests.push(request);
  const onFinished = (request: Request) => completed.add(request);
  const onFailed = (request: Request) => failed.add(request);
  page.on("request", onRequest);
  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFailed);
  let durationMs: number;
  try {
    const startedAt = await page.evaluate(() => performance.now());
    await click();
    await visible();
    durationMs = await page.evaluate((start) => performance.now() - start, startedAt);
    // Observe trailing requests without waiting for open-ended RSC/prefetch streams.
    await page.waitForTimeout(250);
  } finally {
    page.off("request", onRequest);
    page.off("requestfinished", onFinished);
    page.off("requestfailed", onFailed);
  }
  const completedRequests = requests.filter((request) => completed.has(request));
  const failedRequestCount = requests.filter((request) => failed.has(request)).length;
  return {
    durationMs: Math.round(durationMs),
    requestCount: requests.length,
    completedRequestCount: completedRequests.length,
    failedRequestCount,
    pendingRequestCount: requests.length - completedRequests.length - failedRequestCount,
    completedTransferredBytes: await transferredBytes(completedRequests),
  };
}

test("reports fixed-seed production interaction baselines without an elapsed-time gate", async ({
  page,
}) => {
  await page.addInitScript(() => {
    // Keep the benchmark deterministic and prevent its own run from emitting sampled custom RUM.
    window.sessionStorage.setItem("wallie-interaction-rum-sampled-v1", "0");
  });
  await signIn(page);

  const idleDetailRequests: Request[] = [];
  page.on("request", (request) => {
    if (isDetailRscRequest(request)) idleDetailRequests.push(request);
  });

  await page.goto(workspacePath);
  await expect(
    page.getByRole("heading", { level: 1, name: "Pipeline", exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(750);
  expect(idleDetailRequests, "Pipeline must make zero idle detail prefetches").toHaveLength(0);

  const pipelineToSessions = await measureClickToVisible(
    page,
    () => page.getByRole("link", { name: "Sessions" }).first().click(),
    async () => {
      await expect(page).toHaveURL(`${workspacePath}/sessions`);
      await expect(
        page.getByRole("heading", { level: 1, name: "Sessions", exact: true }),
      ).toBeVisible();
    },
  );
  await page.waitForTimeout(750);
  expect(idleDetailRequests, "Sessions must make zero idle detail prefetches").toHaveLength(0);

  const firstDetailLink = page.locator(`a[href^="${workspacePath}/sessions/"]`).first();
  const destination = await firstDetailLink.getAttribute("href");
  const sessionTitle = (await firstDetailLink.innerText()).trim();
  expect(sessionTitle).not.toBe("");
  expect(destination).toMatch(detailPath);
  if (!destination) throw new Error("Fixed seed did not provide a session detail link.");

  const sessionsToDetail = await measureClickToVisible(
    page,
    () => firstDetailLink.click(),
    async () => {
      await expect(page).toHaveURL(destination);
      await expect(
        page.getByRole("heading", { level: 1, name: sessionTitle, exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("navigation", { name: "Pipeline stages" }).getByRole("button").first(),
      ).toBeVisible();
    },
  );

  console.log(
    `interaction-benchmark ${JSON.stringify({
      idleDetailPrefetches: 0,
      pipelineToSessions,
      sessionsToDetail,
    })}`,
  );
});
