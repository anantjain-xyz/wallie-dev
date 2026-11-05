import { readFileSync, writeFileSync } from "node:fs";

import {
  expect,
  test,
  type Browser,
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
  await expect(page.getByRole("navigation", { name: "Pipeline stages" })).toBeVisible();
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
    return performance.getEntriesByType("resource").map((entry) => {
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
    (request) => request.failed || (request.status !== null && request.status >= 500),
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
  writeFileSync(timingLogPath, "");
  const setup = await browser.newContext();
  const setupPage = await setup.newPage();
  await signIn(setupPage, workspacePath);
  const storageState = "/tmp/wallie-navigation-bench-storage.json";
  await setup.storageState({ path: storageState });
  await setup.close();

  const samples: FlowSample[] = [];
  for (let run = 1; run <= runs; run += 1) {
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
    samples.push(
      await measure(browser, storageState, "session-open", run, async (page, begin) => {
        await page.goto(`${workspacePath}/sessions`, { waitUntil: "commit" });
        await waitForSessions(page);
        const link = page.getByRole("link", {
          name: `Open session #1001: ${sessionTitle}`,
        });
        await expect(link).toBeVisible();
        await begin();
        const startedAt = await page.evaluate(() => performance.now());
        await link.click();
        await waitForSession(page);
        return page.evaluate((start) => performance.now() - start, startedAt);
      }),
    );
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

  const failed = samples.filter((sample) => !sample.ok);
  console.log(`navigation-bench ${JSON.stringify({ runs, samples })}`);
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
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
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
    await context.close();
  }
}
