import { expect, test, type Page, type Request } from "@playwright/test";

import { signIn } from "./helpers/auth";
import { SESSION_PAGE_DATA_SERVER_TIMING } from "../src/lib/performance/session-prefetch";

const workspacePath = "/w/acme-corp";
const sessionDetailPathPattern = /^\/w\/acme-corp\/sessions\/\d+$/;

function isSessionDetailRscRequest(request: Request) {
  const url = new URL(request.url());

  return request.headers().rsc === "1" && sessionDetailPathPattern.test(url.pathname);
}

async function prepareSessionLink(page: Page) {
  await page.addInitScript(() => {
    type Router = { push: (href: string, options?: { scroll?: boolean }) => void };
    type Next = { router?: Router };
    let next: Next | undefined;
    Object.defineProperty(window, "next", {
      configurable: true,
      get: () => next,
      set(value: Next) {
        next = value;
        let router: Router | undefined;
        Object.defineProperty(value, "router", {
          configurable: true,
          get: () => router,
          set(value: Router) {
            router = value;
            const push = value.push;
            value.push = function (href, options) {
              const root = document.documentElement;
              root.dataset.sessionPushes = String(Number(root.dataset.sessionPushes ?? "0") + 1);
              return push.call(this, href, options);
            };
          },
        });
      },
    });
  });
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
  const link = page.getByRole("link", { name: /^Open session / }).first();
  const href = await link.getAttribute("href");
  const title = (await link.getAttribute("aria-label"))?.replace(/^Open session #\d+: /, "");
  if (!href || !sessionDetailPathPattern.test(href) || !title) {
    throw new Error("The seeded sessions list has no session detail link.");
  }
  await page.waitForFunction((destination) => {
    const anchor = document.querySelector(`a[href="${destination}"]`);
    return anchor && Object.keys(anchor).some((key) => key.startsWith("__reactFiber"));
  }, href);
  return { href, link, title };
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

test("only completed session page data exposes the timing signal to the browser", async ({
  page,
}) => {
  const { href, link } = await prepareSessionLink(page);
  const treeResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === href &&
      response.request().headers()["next-router-segment-prefetch"] === "/_tree",
  );
  const pageResponse = page.waitForResponse((response) => {
    const headers = response.request().headers();
    return (
      new URL(response.url()).pathname === href &&
      headers.rsc === "1" &&
      Boolean(headers["next-router-state-tree"]) &&
      !("next-router-prefetch" in headers) &&
      !("next-router-segment-prefetch" in headers)
    );
  });
  await link.hover();
  const [tree, data] = await Promise.all([treeResponse, pageResponse]);
  expect((await tree.allHeaders())["server-timing"] ?? "").not.toContain(
    SESSION_PAGE_DATA_SERVER_TIMING,
  );
  expect((await data.allHeaders())["server-timing"]).toContain(SESSION_PAGE_DATA_SERVER_TIMING);
  await page.waitForFunction(
    ({ url, signal }) =>
      performance.getEntriesByName(url).some((entry) => {
        const resource = entry as PerformanceResourceTiming;
        return (
          resource.responseEnd > 0 && resource.serverTiming.some((item) => item.name === signal)
        );
      }),
    { url: data.url(), signal: SESSION_PAGE_DATA_SERVER_TIMING },
  );
});

for (const delayedPhase of ["tree", "page"] as const) {
  test(`session opening reuses a prefetch with its ${delayedPhase} response still pending`, async ({
    page,
  }) => {
    const { href, link, title } = await prepareSessionLink(page);
    const aborted: string[] = [];
    const recovery: string[] = [];
    const destinationRequests: Request[] = [];
    page.on("requestfailed", (request) => {
      if (isSessionDetailRscRequest(request))
        aborted.push(request.failure()?.errorText ?? "failed");
    });
    page.on("request", (request) => {
      if (isSessionDetailRscRequest(request)) destinationRequests.push(request);
      if (
        /\/review-capabilities(?:\?|$)|\/rpc\/get_session_detail_page(?:\?|$)/.test(request.url())
      ) {
        recovery.push(request.url());
      }
    });

    let release!: () => void;
    let held!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const responseHeld = new Promise<void>((resolve) => {
      held = resolve;
    });
    await page.route(`**${href}**`, async (route) => {
      const request = route.request();
      const tree = request.headers()["next-router-segment-prefetch"] === "/_tree";
      const response = await route.fetch();
      if (isSessionDetailRscRequest(request) && tree === (delayedPhase === "tree")) {
        held();
        await gate;
      }
      await route.fulfill({ response });
    });

    try {
      await link.hover();
      await responseHeld;
      if (delayedPhase === "page") {
        await page.waitForFunction((destination) => {
          return performance.getEntriesByType("resource").some((entry) => {
            const resource = entry as PerformanceResourceTiming;
            const url = new URL(resource.name);
            return (
              url.pathname === destination &&
              url.searchParams.has("_rsc") &&
              resource.responseEnd > 0 &&
              performance.now() - resource.responseEnd > 120
            );
          });
        }, href);
      }
      const whilePending = await link.evaluate((element) => {
        (element as HTMLAnchorElement).click();
        return new Promise<{ pathname: string; pushes: number }>((resolve) => {
          window.setTimeout(() => {
            resolve({
              pathname: location.pathname,
              pushes: Number(document.documentElement.dataset.sessionPushes ?? "0"),
            });
          }, 50);
        });
      });
      expect(whilePending.pathname).toBe(`${workspacePath}/sessions`);
      expect(whilePending.pushes, "navigation must not discard an in-flight prefetch").toBe(0);
      release();
      await expect(page).toHaveURL(href);
      await expect(
        page.locator("header").getByRole("heading", { level: 1, name: title, exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Pipeline stages" })).toBeVisible();
      await expect(page.getByRole("status", { name: "Loading session" })).toBeHidden();
      expect(await page.locator("html").getAttribute("data-session-pushes")).toBe("1");
      await page.waitForTimeout(250);
      expect(aborted, "the prefetched destination must not be aborted").toEqual([]);
      expect(destinationRequests, "click must reuse the two prefetch phases").toHaveLength(2);
      console.log(`delayed ${delayedPhase} prefetch: client recovery requests=${recovery.length}`);
      if (delayedPhase === "page") {
        await page.goBack();
        await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
        await link.hover();
        await link.click();
        await expect(page).toHaveURL(href);
        await expect(
          page.locator("header").getByRole("heading", { level: 1, name: title, exact: true }),
        ).toBeVisible();
        expect(await page.locator("html").getAttribute("data-session-pushes")).toBe("2");
      }
    } finally {
      release();
    }
  });
}

test("session opening recovers when the intent prefetch fails", async ({ page }) => {
  const { href, link } = await prepareSessionLink(page);
  let failedPrefetch = false;
  await page.route(`**${href}**`, async (route) => {
    const request = route.request();
    if (
      !failedPrefetch &&
      isSessionDetailRscRequest(request) &&
      request.headers()["next-router-segment-prefetch"] === "/_tree"
    ) {
      failedPrefetch = true;
      await route.fulfill({ status: 503, body: "Prefetch unavailable" });
      return;
    }
    await route.continue();
  });
  await link.hover();
  await expect.poll(() => failedPrefetch).toBe(true);
  await link.click();
  await expect(page).toHaveURL(href, { timeout: 8_000 });
  await expect(page.getByRole("navigation", { name: "Pipeline stages" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Loading session" })).toBeHidden();
});
