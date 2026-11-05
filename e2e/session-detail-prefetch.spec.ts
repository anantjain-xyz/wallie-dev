import { expect, test, type Request } from "@playwright/test";

import { signIn } from "./helpers/auth";

const workspacePath = "/w/acme-corp";
const sessionDetailPathPattern = /^\/w\/acme-corp\/sessions\/\d+$/;

function isSessionDetailRscRequest(request: Request) {
  const url = new URL(request.url());

  return request.headers().rsc === "1" && sessionDetailPathPattern.test(url.pathname);
}

test("session detail prefetch requires intent and stays deduplicated", async ({ page }) => {
  await signIn(page);

  const detailRequests: Request[] = [];
  page.on("request", (request) => {
    if (isSessionDetailRscRequest(request)) detailRequests.push(request);
  });

  await page.goto(workspacePath);
  await expect(page.getByRole("heading", { name: "Pipeline", exact: true })).toBeVisible();
  await page.waitForTimeout(750);
  expect(detailRequests, "Pipeline must not prefetch visible session cards").toHaveLength(0);

  const pipelineSessionLink = page.getByRole("link", { name: /^Open session / }).first();
  const intentHref = await pipelineSessionLink.getAttribute("href");
  expect(intentHref).toMatch(sessionDetailPathPattern);
  if (!intentHref) throw new Error("Pipeline session link is missing its href");

  await pipelineSessionLink.dispatchEvent("pointerover", { pointerType: "touch" });
  await pipelineSessionLink.dispatchEvent("touchstart");
  await page.waitForTimeout(250);
  expect(detailRequests, "touch interaction must not trigger intent prefetch").toHaveLength(0);

  await pipelineSessionLink.focus();
  await expect
    .poll(async () => {
      const before = detailRequests.length;
      if (before === 0) return false;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return detailRequests.length === before;
    })
    .toBe(true);
  const intentRequestCount = detailRequests.length;
  await pipelineSessionLink.hover();
  await pipelineSessionLink.focus();
  await page.waitForTimeout(500);

  // A full prefetch can be more than one RSC response for the same href.
  // Focus and hover still share that one prefetch.
  expect(
    detailRequests.map((request) => new URL(request.url()).pathname),
    "focus and hover must prefetch only the focused session",
  ).toEqual(Array.from({ length: detailRequests.length }, () => intentHref));
  expect(detailRequests, "hover must not start a second prefetch").toHaveLength(intentRequestCount);

  await page.getByRole("link", { name: "Sessions", exact: true }).click();
  await expect(page).toHaveURL(`${workspacePath}/sessions`);
  await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
  await page.waitForTimeout(750);
  expect(detailRequests, "Sessions must not prefetch visible session rows").toHaveLength(
    intentRequestCount,
  );

  const unprefetchedSessionLink = page
    .locator(`a[href^="${workspacePath}/sessions/"]:not([href="${intentHref}"])`)
    .first();
  const navigationHref = await unprefetchedSessionLink.getAttribute("href");
  expect(navigationHref).toMatch(sessionDetailPathPattern);
  expect(navigationHref).not.toBe(intentHref);
  if (!navigationHref) throw new Error("Sessions row link is missing its href");

  let releaseNavigation!: () => void;
  const navigationGate = new Promise<void>((resolve) => {
    releaseNavigation = resolve;
  });

  await page.route(`**${navigationHref}**`, async (route) => {
    if (isSessionDetailRscRequest(route.request())) await navigationGate;
    await route.continue();
  });

  await unprefetchedSessionLink.evaluate((element) => {
    (element as HTMLAnchorElement).click();
  });
  await expect(page.getByRole("status", { name: "Loading session" })).toBeVisible();
  expect(
    detailRequests.slice(intentRequestCount).map((request) => new URL(request.url()).pathname),
    "click navigation should request only its destination",
  ).toEqual([navigationHref]);

  releaseNavigation();
  await expect(page).toHaveURL(navigationHref);
  await expect(page.getByRole("status", { name: "Loading session" })).toBeHidden();

  const requestedPaths = detailRequests.map((request) => new URL(request.url()).pathname);
  expect(new Set(requestedPaths)).toEqual(new Set([intentHref, navigationHref]));

  console.log(
    `session-detail RSC requests: initial Pipeline=0, initial Sessions=0, intent=${intentRequestCount}, after click=${detailRequests.length}`,
  );
});
