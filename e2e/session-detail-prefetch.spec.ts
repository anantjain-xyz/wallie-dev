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
  await expect(page.getByRole("heading", { name: "Pipeline" })).toBeVisible();
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
  await expect.poll(() => detailRequests.length).toBe(1);
  await pipelineSessionLink.hover();
  await pipelineSessionLink.focus();
  await page.waitForTimeout(500);

  expect(detailRequests, "focus and hover must share one href-level prefetch").toHaveLength(1);
  expect(new URL(detailRequests[0]!.url()).pathname).toBe(intentHref);

  await page.getByRole("link", { name: "Sessions" }).click();
  await expect(page).toHaveURL(`${workspacePath}/sessions`);
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
  await page.waitForTimeout(750);
  expect(detailRequests, "Sessions must not prefetch visible session rows").toHaveLength(1);

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
  expect(detailRequests, "click navigation should request only its destination").toHaveLength(2);

  releaseNavigation();
  await expect(page).toHaveURL(navigationHref);
  await expect(page.getByRole("status", { name: "Loading session" })).toBeHidden();

  const requestedPaths = detailRequests.map((request) => new URL(request.url()).pathname);
  expect(new Set(requestedPaths)).toEqual(new Set([intentHref, navigationHref]));

  console.log(
    `session-detail RSC requests: initial Pipeline=0, initial Sessions=0, intent=1, after click=${detailRequests.length}`,
  );
});
