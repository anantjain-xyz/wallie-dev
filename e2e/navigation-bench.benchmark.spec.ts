import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  expect,
  test,
  type Browser,
  type CDPSession,
  type Page,
  type Request,
  type Response,
} from "@playwright/test";

import { signIn } from "./helpers/auth";

const workspacePath = "/w/acme-corp";
const sessionPath = `${workspacePath}/sessions/1001`;
const sessionTitle = "[bench] Checkout latency";
const timingLogPath = process.env.WALLIE_TIMING_LOG_PATH ?? "/tmp/wallie-navigation-bench.jsonl";
const runs = Number(process.env.SNAPPY_RUNS ?? "5");
const sessionOnly = process.env.SNAPPY_SESSION_ONLY === "1";
const sessionIntent = process.env.SNAPPY_SESSION_INTENT ?? "immediate";
const profile = process.env.SNAPPY_PROFILE === "1";

test.use({ trace: "off" });

type SessionOpenTiming = {
  abortedRscRequestCount: number;
  clickToArtifactMs: number;
  clickToPushMs: number;
  clickToReviewReadyMs: number;
  clickToStageMs: number;
  intent: string;
  pushToReviewReadyMs: number;
  recoveryRequestCount: number;
  rscResponses: Array<{
    responseEndMs: number;
    responseStatus: number;
    serverTiming: string[];
    startMs: number;
  }>;
};

type FlowId =
  | "pipeline-load"
  | "sessions-switch"
  | "session-open"
  | "settings-switch"
  | "new-session-modal";

type CapturedRequest = {
  aborted: boolean;
  durationMs: number;
  failed: boolean;
  method: string;
  path: string;
  resourceType: string;
  startMs: number;
  status: number | null;
  transferBytes: number;
};

type ServerSegment = {
  durationMs: number;
  name: string;
  ok: boolean;
};

type ServerTimingRecord = {
  durationMs: number;
  name: string;
  ok: boolean;
  requestId: string | null;
  segments: ServerSegment[];
};

type FlowSample = {
  blockingRequestCount: number;
  documentBytes: number;
  durationMs: number;
  error: string | null;
  failedRequestCount: number;
  flow: FlowId;
  ok: boolean;
  requestCount: number;
  requests: CapturedRequest[];
  rscBytes: number;
  run: number;
  scriptBytes: number;
  serverTimings: ServerTimingRecord[];
  sessionOpen?: SessionOpenTiming;
  styleBytes: number;
  ttfbMs: number | null;
};

type ResourceTiming = {
  duration: number;
  initiatorType: string;
  name: string;
  renderBlockingStatus?: string;
  responseStatus?: number;
  startTime: number;
  transferSize: number;
};

function assertRunCount(value: number) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("SNAPPY_RUNS must be a positive integer.");
  }
}

function requestPath(url: string) {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

function readServerTimings(requestId: string): ServerTimingRecord[] {
  let raw = "";
  try {
    raw = readFileSync(timingLogPath, "utf8");
  } catch {
    return [];
  }

  const records: ServerTimingRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as {
        durationMs?: number;
        name?: string;
        ok?: boolean;
        requestId?: string | null;
        segments?: Array<{ durationMs?: number; name?: string; ok?: boolean }>;
      };
      if (parsed.requestId !== requestId || typeof parsed.name !== "string") continue;
      records.push({
        durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : 0,
        name: parsed.name,
        ok: parsed.ok !== false,
        requestId,
        segments: (parsed.segments ?? []).map((segment) => ({
          durationMs: typeof segment.durationMs === "number" ? segment.durationMs : 0,
          name: typeof segment.name === "string" ? segment.name : "unknown",
          ok: segment.ok !== false,
        })),
      });
    } catch {
      // Ignore a torn final line if the server is still writing.
    }
  }
  return records;
}

async function waitForShellHydration(page: Page) {
  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="New session"]');
    if (!(button instanceof HTMLButtonElement)) return false;
    return Object.keys(button).some((key) => key.startsWith("__reactFiber"));
  });
}

async function waitForPipeline(page: Page) {
  await expect(
    page.getByRole("heading", { level: 1, name: "Pipeline", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Pipeline board" })).toBeVisible();
  await expect(page.locator(`a[href^="${workspacePath}/sessions/"]`).first()).toBeVisible();
  await waitForShellHydration(page);
}

async function waitForSessions(page: Page) {
  await expect(page).toHaveURL(`${workspacePath}/sessions`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Sessions", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".session-list-row").first()).toBeVisible();
  await waitForShellHydration(page);
}

async function waitForSession(page: Page) {
  await expect(page).toHaveURL(sessionPath);
  await expect(
    page.getByRole("heading", { level: 1, name: sessionTitle, exact: true }),
  ).toBeVisible();
  const stageNav = page.getByRole("navigation", { name: "Pipeline stages" });
  await expect(stageNav).toBeVisible();
  await expect(stageNav.getByRole("button").first()).toBeVisible();
  await waitForShellHydration(page);
}

async function waitForSettings(page: Page) {
  await expect(page).toHaveURL(`${workspacePath}/settings`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Settings", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "GitHub", exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: "Loading integration details" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Pipeline", exact: true })).toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: "Integration details unavailable" }),
  ).toHaveCount(0);
  await waitForShellHydration(page);
}

async function waitForNewSession(page: Page) {
  await expect(page.getByRole("dialog", { name: "Start a new session" })).toBeVisible();
  await expect(page.locator("#session-title")).toBeVisible();
  await expect(page.getByText("Loading session form…")).toHaveCount(0);
  await expect(page.getByText("Loading repositories…")).toHaveCount(0);
  await expect(page.locator("#session-stages")).toBeVisible();
}

async function visibleNavLink(page: Page, name: string) {
  const link = page.getByRole("link", { name, exact: true });
  await expect(link).toHaveCount(1);
  return link;
}

async function installSessionOpenProbe(page: Page) {
  await page.addInitScript(
    ({ destination, title }) => {
      const mark = (name: string) => {
        const key = `session-open:${name}`;
        if (performance.getEntriesByName(key).length === 0) performance.mark(key);
      };
      type Router = { push: (href: string, options?: { scroll?: boolean }) => void };
      let next: { router?: Router };
      Object.defineProperty(window, "next", {
        configurable: true,
        get: () => next,
        set(value: { router?: Router }) {
          next = value;
          let router: Router;
          Object.defineProperty(value, "router", {
            configurable: true,
            get: () => router,
            set(value: Router) {
              router = value;
              const push = router.push;
              router.push = function (href, options) {
                if (new URL(href, location.origin).pathname === destination) mark("push");
                return push.call(this, href, options);
              };
            },
          });
        },
      });

      const visible = (element: Element | null) =>
        element !== null &&
        element.getClientRects().length > 0 &&
        getComputedStyle(element).visibility !== "hidden";
      const reviewReady = () => {
        if (location.pathname !== destination) return false;
        const heading = document.querySelector("h1");
        const stages = document.querySelector('nav[aria-label="Pipeline stages"] button');
        const stageReady = heading?.textContent?.trim() === title && visible(stages);
        if (stageReady) mark("stage");
        const panel = document.querySelector("#artifact-rendered-panel");
        const body = panel?.querySelector(".artifact-content");
        const artifactReady =
          visible(body ?? null) &&
          body?.querySelector("h1")?.textContent === "Checkout latency" &&
          body?.textContent?.includes(
            "The checkout path waits on inventory, tax, and shipping before it can show a total.",
          ) &&
          /v1\s*·\s*Latest/.test(panel?.textContent ?? "");
        if (artifactReady) mark("artifact");
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
        const enabled = (label: string) =>
          buttons.some(
            (button) => button.innerText.trim() === label && !button.disabled && visible(button),
          );
        return (
          stageReady && artifactReady && enabled("Approve stage") && enabled("Request changes")
        );
      };
      const check = () => {
        if (reviewReady()) {
          requestAnimationFrame(() => {
            if (reviewReady()) mark("review-ready");
            else requestAnimationFrame(check);
          });
        } else requestAnimationFrame(check);
      };
      document.addEventListener(
        "click",
        (event) => {
          const link = event.target instanceof Element ? event.target.closest("a") : null;
          if (link?.pathname !== destination) return;
          mark("click");
          requestAnimationFrame(check);
        },
        { capture: true, once: true },
      );
    },
    { destination: sessionPath, title: sessionTitle },
  );
}

async function readSessionOpenTiming(page: Page, requests: Request[]): Promise<SessionOpenTiming> {
  await page.waitForFunction(
    () => performance.getEntriesByName("session-open:review-ready").length > 0,
  );
  const timing = await page.evaluate((destination) => {
    const at = (name: string) => {
      const entry = performance.getEntriesByName(`session-open:${name}`)[0];
      if (!entry) throw new Error(`Session timing is missing ${name}.`);
      return entry.startTime;
    };
    const click = at("click");
    const push = at("push");
    const ready = at("review-ready");
    return {
      clickToArtifactMs: at("artifact") - click,
      clickToPushMs: push - click,
      clickToReviewReadyMs: ready - click,
      clickToStageMs: at("stage") - click,
      pushToReviewReadyMs: ready - push,
      rscResponses: performance.getEntriesByType("resource").flatMap((entry) => {
        const resource = entry as PerformanceResourceTiming;
        const url = new URL(resource.name);
        return url.pathname === destination && url.searchParams.has("_rsc")
          ? [
              {
                responseEndMs: resource.responseEnd - click,
                responseStatus: resource.responseStatus,
                serverTiming: resource.serverTiming.map((entry) => entry.name),
                startMs: resource.startTime - click,
              },
            ]
          : [];
      }),
    };
  }, sessionPath);
  return {
    ...timing,
    abortedRscRequestCount: requests.filter(
      (request) =>
        new URL(request.url()).pathname === sessionPath &&
        request.headers().rsc === "1" &&
        request.failure() !== null,
    ).length,
    intent: sessionIntent,
    recoveryRequestCount: requests.filter((request) =>
      /\/review-capabilities(?:\?|$)|\/rpc\/get_session_detail_page(?:\?|$)/.test(request.url()),
    ).length,
  };
}

async function finishProfile(session: CDPSession, path: string) {
  const complete = new Promise<string>((resolve, reject) => {
    session.once("Tracing.tracingComplete", ({ stream }) => {
      if (stream) resolve(stream);
      else reject(new Error("Chrome returned a trace without a stream."));
    });
  });
  await session.send("Tracing.end");
  const handle = await complete;
  let trace = "";
  for (;;) {
    const chunk = await session.send("IO.read", { handle });
    trace += chunk.base64Encoded ? Buffer.from(chunk.data, "base64").toString("utf8") : chunk.data;
    if (chunk.eof) break;
  }
  await session.send("IO.close", { handle });
  await session.detach();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, trace);
  console.log(`session-open diagnostic trace ${path}`);
}

async function collectSample(
  page: Page,
  flow: FlowId,
  run: number,
  wallStart: number,
  requestId: string,
  startedRequests: Request[],
  finished: Map<Request, Response | null>,
  failed: Set<Request>,
  aborted: Set<Request>,
  pageErrors: string[],
): Promise<FlowSample> {
  const resourceTimings = await page.evaluate(() => {
    const startedAt = performance.getEntriesByName("snappy-begin").at(-1)?.startTime ?? 0;
    return performance
      .getEntriesByType("resource")
      .filter((entry) => entry.startTime >= startedAt)
      .map((entry) => {
        const resource = entry as PerformanceResourceTiming;
        const withStatus = resource as PerformanceResourceTiming & {
          renderBlockingStatus?: string;
          responseStatus?: number;
        };
        return {
          duration: resource.duration,
          initiatorType: resource.initiatorType,
          name: resource.name,
          renderBlockingStatus: withStatus.renderBlockingStatus,
          responseStatus: withStatus.responseStatus,
          startTime: resource.startTime,
          transferSize: resource.transferSize,
        };
      });
  });
  const navigation = await page.evaluate(() => {
    const entry = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (!entry) return null;
    return {
      responseStart: entry.responseStart,
      requestStart: entry.requestStart,
    };
  });

  const requests: CapturedRequest[] = [];
  for (const request of startedRequests) {
    let transferBytes = 0;
    let status: number | null = null;
    const response = finished.get(request);
    if (response) {
      status = response.status();
      try {
        const sizes = await request.sizes();
        transferBytes =
          sizes.requestBodySize +
          sizes.requestHeadersSize +
          sizes.responseBodySize +
          sizes.responseHeadersSize;
      } catch {
        transferBytes = 0;
      }
    }
    const timing = request.timing();
    requests.push({
      aborted: aborted.has(request),
      durationMs: Math.max(0, Math.round(timing.responseEnd)),
      failed: failed.has(request),
      method: request.method(),
      path: requestPath(request.url()),
      resourceType: request.resourceType(),
      startMs: Math.round(timing.startTime - wallStart),
      status,
      transferBytes,
    });
  }

  const blockingPaths = new Set(
    (resourceTimings as ResourceTiming[])
      .filter((entry) => entry.renderBlockingStatus === "blocking")
      .map((entry) => requestPath(entry.name)),
  );
  const scriptBytes = requests
    .filter((request) => request.resourceType === "script")
    .reduce((total, request) => total + request.transferBytes, 0);
  const styleBytes = requests
    .filter((request) => request.resourceType === "stylesheet")
    .reduce((total, request) => total + request.transferBytes, 0);
  const documentBytes = requests
    .filter((request) => request.resourceType === "document")
    .reduce((total, request) => total + request.transferBytes, 0);
  const rscBytes = requests
    .filter((request) => request.path.includes("_rsc="))
    .reduce((total, request) => total + request.transferBytes, 0);
  const failedRequestCount = requests.filter(
    (request) => request.failed || (request.status !== null && request.status >= 400),
  ).length;
  const error = pageErrors[0] ?? null;

  return {
    blockingRequestCount: blockingPaths.size,
    documentBytes,
    durationMs: 0,
    error,
    failedRequestCount,
    flow,
    ok: error === null && failedRequestCount === 0,
    requestCount: requests.length,
    requests,
    rscBytes,
    run,
    scriptBytes,
    serverTimings: readServerTimings(requestId),
    styleBytes,
    ttfbMs:
      navigation && flow === "pipeline-load"
        ? Math.round(navigation.responseStart - navigation.requestStart)
        : null,
  };
}

test("measures five logged-in navigation flows", async ({ browser }) => {
  assertRunCount(runs);
  if (!["immediate", "settled", "keyboard", "touch"].includes(sessionIntent)) {
    throw new Error("SNAPPY_SESSION_INTENT must be immediate, settled, keyboard, or touch.");
  }
  writeFileSync(timingLogPath, "");
  const setup = await browser.newContext();
  const setupPage = await setup.newPage();
  await signIn(setupPage, workspacePath);
  const storageState = "/tmp/wallie-navigation-bench-storage.json";
  await setup.storageState({ path: storageState });
  await setup.close();

  const samples: FlowSample[] = [];
  for (let run = 1; run <= runs; run += 1) {
    if (!sessionOnly) {
      samples.push(
        await measure(browser, storageState, "pipeline-load", run, async (page, begin) => {
          await begin();
          await page.goto(workspacePath, { waitUntil: "commit" });
          await waitForPipeline(page);
          return page.evaluate(() => performance.now());
        }),
      );
      samples.push(
        await measure(browser, storageState, "sessions-switch", run, async (page, begin) => {
          await page.goto(workspacePath, { waitUntil: "commit" });
          await waitForPipeline(page);
          const link = await visibleNavLink(page, "Sessions");
          await begin();
          const startedAt = await page.evaluate(() => performance.now());
          await link.click();
          await waitForSessions(page);
          return page.evaluate((start) => performance.now() - start, startedAt);
        }),
      );
    }
    samples.push(
      await measure(browser, storageState, "session-open", run, async (page, begin) => {
        await page.goto(`${workspacePath}/sessions`, { waitUntil: "commit" });
        await waitForSessions(page);
        const link = page.getByRole("link", {
          name: `Open session #1001: ${sessionTitle}`,
        });
        await expect(link).toBeVisible();
        await begin();
        if (sessionIntent === "settled") {
          const pageResponse = page.waitForResponse((response) => {
            const headers = response.request().headers();
            return (
              new URL(response.url()).pathname === sessionPath &&
              headers.rsc === "1" &&
              Boolean(headers["next-router-state-tree"]) &&
              !("next-router-prefetch" in headers) &&
              !("next-router-segment-prefetch" in headers)
            );
          });
          await link.hover();
          const response = await pageResponse;
          expect(response.ok()).toBe(true);
          await page.waitForFunction((responseUrl) => {
            const resource = performance.getEntriesByName(responseUrl)[0] as
              | PerformanceResourceTiming
              | undefined;
            return (
              resource !== undefined &&
              resource.responseEnd > 0 &&
              performance.now() - resource.responseEnd > 150
            );
          }, response.url());
        } else if (sessionIntent === "keyboard") await link.focus();
        const startedAt = await page.evaluate(() => performance.now());
        if (sessionIntent === "keyboard") await page.keyboard.press("Enter");
        else if (sessionIntent === "touch") await link.tap();
        else await link.click();
        await waitForSession(page);
        return page.evaluate((start) => performance.now() - start, startedAt);
      }),
    );
    if (!sessionOnly) {
      samples.push(
        await measure(browser, storageState, "settings-switch", run, async (page, begin) => {
          await page.goto(workspacePath, { waitUntil: "commit" });
          await waitForPipeline(page);
          const link = await visibleNavLink(page, "Settings");
          await begin();
          const startedAt = await page.evaluate(() => performance.now());
          await link.click();
          await waitForSettings(page);
          return page.evaluate((start) => performance.now() - start, startedAt);
        }),
      );
      samples.push(
        await measure(browser, storageState, "new-session-modal", run, async (page, begin) => {
          await page.goto(workspacePath, { waitUntil: "commit" });
          await waitForPipeline(page);
          const button = page.getByRole("button", { name: "New session", exact: true });
          await expect(button).toHaveCount(1);
          await begin();
          const startedAt = await page.evaluate(() => performance.now());
          await button.click();
          await waitForNewSession(page);
          return page.evaluate((start) => performance.now() - start, startedAt);
        }),
      );
    }
  }

  const failed = samples.filter((sample) => !sample.ok);
  console.log(`navigation-bench ${JSON.stringify({ diagnostic: profile, runs, samples })}`);
  expect(
    failed.map(
      (sample) =>
        `${sample.flow}#${sample.run}: ${sample.error ?? `${sample.failedRequestCount} failed requests`}`,
    ),
  ).toEqual([]);
});

async function measure(
  browser: Browser,
  storageState: string,
  flow: FlowId,
  run: number,
  runFlow: (page: Page, begin: () => Promise<void>) => Promise<number>,
): Promise<FlowSample> {
  const requestId = `snappy-${flow}-${run}-${Date.now()}`;
  const context = await browser.newContext({
    storageState,
    ...(flow === "session-open" && sessionIntent === "touch"
      ? { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } }
      : {}),
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  if (flow === "session-open") await installSessionOpenProbe(page);
  let profileSession: CDPSession | null = null;
  if (profile && flow === "session-open" && run === 1) {
    profileSession = await context.newCDPSession(page);
    await profileSession.send("Tracing.start", {
      categories:
        "devtools.timeline,blink.user_timing,toplevel,v8,disabled-by-default-v8.cpu_profiler",
      transferMode: "ReturnAsStream",
    });
  }
  await page.setExtraHTTPHeaders({ "x-request-id": `${requestId}-warmup` });
  const startedRequests: Request[] = [];
  const finished = new Map<Request, Response | null>();
  const failed = new Set<Request>();
  const aborted = new Set<Request>();
  const pageErrors: string[] = [];
  let recording = false;
  let wallStart = Date.now();

  const begin = async () => {
    startedRequests.length = 0;
    finished.clear();
    failed.clear();
    aborted.clear();
    pageErrors.length = 0;
    await page.setExtraHTTPHeaders({ "x-request-id": requestId });
    await page.evaluate(() => {
      performance.clearResourceTimings();
      performance.clearMarks("snappy-begin");
      performance.mark("snappy-begin");
    });
    wallStart = Date.now();
    recording = true;
  };

  page.on("request", (request) => {
    if (recording) startedRequests.push(request);
  });
  page.on("requestfinished", (request) => {
    if (!startedRequests.includes(request)) return;
    void request.response().then((response) => {
      finished.set(request, response);
    });
  });
  page.on("requestfailed", (request) => {
    if (!startedRequests.includes(request)) return;
    const errorText = request.failure()?.errorText ?? "";
    if (errorText.includes("ERR_ABORTED")) {
      aborted.add(request);
    } else {
      failed.add(request);
    }
    finished.set(request, null);
  });
  page.on("pageerror", (error) => {
    if (recording) pageErrors.push(error.message);
  });

  try {
    const durationMs = await runFlow(page, begin);
    if (flow === "session-open") {
      await page.waitForFunction(
        () => performance.getEntriesByName("session-open:review-ready").length > 0,
      );
      await page.waitForTimeout(250);
    }
    recording = false;
    const settleDeadline = Date.now() + 2_000;
    while (finished.size < startedRequests.length && Date.now() < settleDeadline) {
      await page.waitForTimeout(50);
    }
    const sample = await collectSample(
      page,
      flow,
      run,
      wallStart,
      requestId,
      startedRequests,
      finished,
      failed,
      aborted,
      pageErrors,
    );
    sample.durationMs = Math.round(durationMs);
    if (flow === "session-open") {
      sample.sessionOpen = await readSessionOpenTiming(page, startedRequests);
      const reviewResponse = page.waitForResponse((response) =>
        /\/api\/sessions\/[^/]+\/reviews\?/.test(response.url()),
      );
      await page.getByRole("button", { name: "Request changes", exact: true }).click();
      expect(
        (await reviewResponse).ok(),
        "Review controls must load the displayed artifact's review",
      ).toBe(true);
      await expect(
        page.getByRole("dialog", { name: "Request changes", exact: true }),
      ).toBeVisible();
    }
    if (flow === "pipeline-load" && sample.serverTimings.length === 0) {
      sample.ok = false;
      sample.error = sample.error ?? "Server timing log has no record for the pipeline document.";
    }
    if (flow === "new-session-modal" && sample.serverTimings.length === 0) {
      const sawOptions = startedRequests.some((request) =>
        request.url().includes("/session-repositories"),
      );
      if (!sawOptions) {
        sample.ok = false;
        sample.error = sample.error ?? "New session dialog did not request repository options.";
      }
    }
    return sample;
  } catch (error) {
    return {
      blockingRequestCount: 0,
      documentBytes: 0,
      durationMs: 0,
      error: error instanceof Error ? error.message : String(error),
      failedRequestCount: 0,
      flow,
      ok: false,
      requestCount: startedRequests.length,
      requests: [],
      rscBytes: 0,
      run,
      scriptBytes: 0,
      serverTimings: readServerTimings(requestId),
      styleBytes: 0,
      ttfbMs: null,
    };
  } finally {
    if (profileSession) {
      await finishProfile(
        profileSession,
        process.env.SNAPPY_PROFILE_PATH ?? test.info().outputPath("session-open.trace.json"),
      );
    }
    await context.close();
  }
}
