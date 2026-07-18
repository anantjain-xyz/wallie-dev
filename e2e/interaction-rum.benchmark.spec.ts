import { expect, test, type Page, type Request } from "@playwright/test";

const workspacePath = "/w/acme-corp";
const detailPath = /^\/w\/acme-corp\/sessions\/\d+$/;

async function signIn(page: Page) {
  await page.goto(`${workspacePath}/sessions`);
  await expect(page).toHaveURL(/\/login\?/);
  await page.getByText("Dev password").click();
  await page.getByPlaceholder("dev@localhost.com").fill("anant@example.com");
  await page.getByPlaceholder("Password (min 6)").fill("password123");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(`${workspacePath}/sessions`);
}

function isDetailRscRequest(request: Request) {
  const url = new URL(request.url());
  return request.headers().rsc === "1" && detailPath.test(url.pathname);
}

async function transferredBytes(requests: Request[]) {
  const sizes = await Promise.all(
    requests.map(async (request) => {
      try {
        const response = await request.response();
        await response?.finished();
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
  await expect(page.getByRole("heading", { name: "Pipeline" })).toBeVisible();
  await page.waitForTimeout(750);
  expect(idleDetailRequests, "Pipeline must make zero idle detail prefetches").toHaveLength(0);

  const pipelineToSessions = await measureClickToVisible(
    page,
    () => page.getByRole("link", { name: "Sessions" }).first().click(),
    async () => {
      await expect(page).toHaveURL(`${workspacePath}/sessions`);
      await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
    },
  );
  await page.waitForTimeout(750);
  expect(idleDetailRequests, "Sessions must make zero idle detail prefetches").toHaveLength(0);

  const firstDetailLink = page.locator(`a[href^="${workspacePath}/sessions/"]`).first();
  const destination = await firstDetailLink.getAttribute("href");
  expect(destination).toMatch(detailPath);
  if (!destination) throw new Error("Fixed seed did not provide a session detail link.");

  const sessionsToDetail = await measureClickToVisible(
    page,
    () => firstDetailLink.click(),
    async () => {
      await expect(page).toHaveURL(destination);
      await expect(page.getByRole("heading", { name: /Session #\d+/ })).toBeVisible();
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
