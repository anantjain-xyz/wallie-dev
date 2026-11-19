import "server-only";

import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { z } from "zod";

import {
  readBrowserFixtureApprovalScope,
  readBrowserFixtureEnvironment,
} from "@/env/browser-fixture";

import {
  BROWSER_CAPTURE_DIMENSIONS,
  BROWSER_VIDEO_FRAME_MS,
  MAX_BROWSER_SCREENSHOT_BYTES,
  browserRunIdentitySchema,
  browserVerificationPlanSchema,
  type BrowserScreenshotFailure,
  type BrowserScreenshotInput,
  type BrowserScreenshotResult,
  type BrowserScreenshotRuntime,
  type BrowserVideoResult,
  type BrowserVideoRuntime,
} from "./browser-contract";
import {
  resolveBrowserFixtureDocument,
  type BrowserFixtureConfiguration,
} from "./browser-fixture-target";

import {
  browserVideoEncoderPaths,
  encodeBrowserVideo,
  hasBrowserVideoEncoder,
} from "./browser-video-encoder";
import { sanitizeBrowserScreenshot } from "./screenshot-png";

const viewport = BROWSER_CAPTURE_DIMENSIONS;
const maxImageBytes = MAX_BROWSER_SCREENSHOT_BYTES;
const fixtureOrigin = "https://wallie-browser-fixture.invalid";
const fixtureContentPolicy = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");
const mandatoryExclusions = [
  "[data-wallie-private]",
  "[data-wallie-credential]",
  "[data-private]",
  "[data-sensitive]",
  "[contenteditable]",
  "input",
  "textarea",
  "select",
  "form",
  "frame",
  "iframe",
  "object",
  "embed",
  "canvas",
  "video",
  "audio",
  "img",
  "svg",
];

const clipSchema = z.strictObject({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().positive().max(viewport.width),
  height: z.number().int().positive().max(viewport.height),
});

function testIdSelector(testId: string) {
  return `[data-testid="${testId}"]`;
}

// This function is serialized into Chromium and must not reference worker code.
// Remove unsafe nodes even when their bounds are outside the region, since
// their shadows, pseudo-elements, or overflow could otherwise paint into it.
function isolateRegion(options: {
  regionSelector: string;
  excludedSelectors: string[];
  forbiddenSelector: string;
  viewport: { width: number; height: number };
  reversible: boolean;
}) {
  const body = document.body;
  const matches = document.querySelectorAll(options.regionSelector);
  const region = matches.item(0);
  if (
    !body ||
    matches.length !== 1 ||
    !(region instanceof HTMLElement) ||
    body === region ||
    !body.contains(region) ||
    document.querySelectorAll("*").length > 2500 ||
    options.excludedSelectors.some((selector) => document.querySelectorAll(selector).length !== 1)
  ) {
    return null;
  }

  const unsafe = Array.from(document.querySelectorAll(options.forbiddenSelector));
  if (unsafe.some((element) => element.contains(region))) return null;
  const toRemove = new Set<Node>(unsafe);
  // Leave the approved region and its layout ancestors as the only painted
  // subtree. There is no sibling overlay to escape the approved clip.
  for (let element: Element = region; element !== body; ) {
    const parent = element.parentElement;
    if (!parent) return null;
    for (const sibling of Array.from(parent.childNodes)) {
      if (sibling !== element) toRemove.add(sibling);
    }
    element = parent;
  }
  const removed: Array<{ node: Node; parent: Node; next: Node | null }> = [];
  for (const node of toRemove) {
    const parent = node.parentNode;
    if (!parent) continue;
    if (options.reversible) removed.push({ node, parent, next: node.nextSibling });
    parent.removeChild(node);
  }

  const style = document.createElement("style");
  style.textContent =
    "* { animation: none !important; transition: none !important; caret-color: transparent !important; } " +
    "*::before, *::after, *::marker { content: none !important; }";
  document.head.append(style);
  if (options.reversible) {
    const x = window.scrollX;
    const y = window.scrollY;
    const captureWorld = globalThis as typeof globalThis & { restoreWallieFrame?: () => boolean };
    captureWorld.restoreWallieFrame = () => {
      for (const { node, parent, next } of removed.reverse()) parent.insertBefore(node, next);
      style.remove();
      window.scrollTo({ left: x, top: y, behavior: "instant" });
      delete captureWorld.restoreWallieFrame;
      return true;
    };
  }
  window.scrollTo({ left: 0, top: 0, behavior: "instant" });
  const rect = region.getBoundingClientRect();
  const css = getComputedStyle(region);
  if (
    css.visibility !== "visible" ||
    css.opacity === "0" ||
    window.scrollX !== 0 ||
    window.scrollY !== 0 ||
    rect.left < 0 ||
    rect.top < 0 ||
    rect.right > options.viewport.width ||
    rect.bottom > options.viewport.height
  ) {
    return null;
  }
  const x = Math.ceil(rect.left);
  const y = Math.ceil(rect.top);
  return { x, y, width: Math.floor(rect.right) - x, height: Math.floor(rect.bottom) - y };
}

async function preparePage(context: BrowserContext, html: string, url: string) {
  let delivered = false;
  let blocked = false;
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (
      !delivered &&
      request.url() === url &&
      request.method() === "GET" &&
      request.isNavigationRequest() &&
      request.resourceType() === "document"
    ) {
      delivered = true;
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        headers: {
          "Content-Security-Policy": fixtureContentPolicy,
          "Referrer-Policy": "no-referrer",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
        body: html,
      });
      return;
    }
    blocked = true;
    await route.abort();
  });
  await context.routeWebSocket("**/*", async (route) => {
    blocked = true;
    await route.close();
  });
  const page = await context.newPage();
  context.on("page", (popup) => {
    blocked = true;
    void popup.close().catch(() => {});
  });
  page.on("download", (download) => {
    blocked = true;
    void download.cancel().catch(() => {});
  });
  return { page, passedIsolation: () => delivered && !blocked && page.frames().length === 1 };
}

async function captureClippedRegion({
  context,
  page,
  regionSelector,
  excludedSelectors,
  forbiddenSelector,
  reversible = false,
}: {
  context: BrowserContext;
  page: Page;
  regionSelector: string;
  excludedSelectors: string[];
  forbiddenSelector: string;
  reversible?: boolean;
}): Promise<Buffer | null> {
  const cdp = await context.newCDPSession(page);
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: "wallie-capture",
  });
  await cdp.send("Emulation.setScriptExecutionDisabled", { value: true });
  await cdp.send("DOM.enable");
  const { nodes } = await cdp.send("DOM.getFlattenedDocument", { depth: -1, pierce: true });
  if (
    nodes.length > 10_000 ||
    nodes.some(
      (node) =>
        (node.shadowRootType && node.shadowRootType !== "user-agent") ||
        node.shadowRoots?.some(({ shadowRootType }) => shadowRootType !== "user-agent"),
    )
  ) {
    return null;
  }
  const options = { regionSelector, excludedSelectors, forbiddenSelector, viewport, reversible };
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
    expression: `(${isolateRegion.toString()})(${JSON.stringify(options)})`,
    contextId: executionContextId,
    returnByValue: true,
  });
  const clip = clipSchema.safeParse(result.value);
  if (
    exceptionDetails ||
    !clip.success ||
    clip.data.x + clip.data.width > viewport.width ||
    clip.data.y + clip.data.height > viewport.height
  ) {
    return null;
  }

  try {
    const { data } = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { ...clip.data, scale: 1 },
    });
    if (data.length > Math.ceil(maxImageBytes / 3) * 4) return null;
    const bytes = Buffer.from(data, "base64");
    return bytes.length > 0 && bytes.length <= maxImageBytes ? bytes : null;
  } finally {
    if (reversible) {
      const restored = await cdp.send("Runtime.evaluate", {
        expression: "globalThis.restoreWallieFrame?.()",
        contextId: executionContextId,
        returnByValue: true,
      });
      if (restored.exceptionDetails || restored.result.value !== true) {
        throw new Error("Isolated capture state could not be restored.");
      }
      await cdp.send("Emulation.setScriptExecutionDisabled", { value: false });
      await cdp.detach();
    }
  }
}

type CaptureRequest =
  | { kind: "screenshot" }
  | { kind: "video"; encoder: NonNullable<ReturnType<typeof browserVideoEncoderPaths>> };

async function captureBrowserMedia(
  configuration: BrowserFixtureConfiguration,
  input: BrowserScreenshotInput,
  request: CaptureRequest,
): Promise<BrowserScreenshotResult | BrowserVideoResult> {
  const runIdentity = browserRunIdentitySchema.safeParse(input.identity);
  const plan = browserVerificationPlanSchema.safeParse([input.check]);
  const check = plan.success ? plan.data[0] : undefined;
  if (!runIdentity.success || !check?.evidence.some(({ kind }) => kind === request.kind)) {
    return { status: "failed", reason: "source_changed" };
  }

  const identity = runIdentity.data;
  const plannedCheck = check;
  const duration = check.timeoutSeconds * 1000;
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + duration;
  const timeout = AbortSignal.timeout(duration);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const remainingTime = () => {
    signal.throwIfAborted();
    return Math.max(1, deadline - Date.now());
  };
  const captureFailed = {
    status: "failed",
    reason: "capture_failed",
  } satisfies BrowserScreenshotFailure;
  const policyExcluded = {
    status: "failed",
    reason: "policy_excluded",
  } satisfies BrowserScreenshotFailure;
  const aborted = Promise.withResolvers<BrowserScreenshotFailure>();
  let browser: Browser | undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    if (browser && !closing) closing = browser.close().catch(() => {});
    return closing;
  };
  const onAbort = () => {
    void close();
    aborted.resolve(captureFailed);
  };

  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    return await Promise.race([aborted.promise, capture()]);
  } catch {
    return captureFailed;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }

  async function capture(): Promise<BrowserScreenshotResult | BrowserVideoResult> {
    try {
      if (request.kind === "video" && !(await hasBrowserVideoEncoder(request.encoder))) {
        return { status: "unavailable", reason: "runtime_unavailable" };
      }
      if (
        request.kind === "video" &&
        (plannedCheck.interactions.length + 1) * BROWSER_VIDEO_FRAME_MS > duration
      ) {
        return captureFailed;
      }

      const html = await resolveBrowserFixtureDocument({
        configuration,
        identity,
        check: plannedCheck,
        signal,
      });
      if (html === null) return { status: "unavailable", reason: "isolated_target_unavailable" };
      try {
        browser = await chromium.launch({
          headless: true,
          chromiumSandbox: true,
          args: [
            "--host-resolver-rules=MAP * ~NOTFOUND",
            "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
          ],
          env: { PATH: "/usr/bin:/bin", LANG: "C" },
          timeout: remainingTime(),
        });
      } catch {
        return signal.aborted
          ? captureFailed
          : { status: "unavailable", reason: "runtime_unavailable" };
      }
      signal.throwIfAborted();
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: 1,
        serviceWorkers: "block",
        acceptDownloads: false,
        permissions: [],
      });
      const url = fixtureOrigin + plannedCheck.path;
      const { page, passedIsolation } = await preparePage(context, html, url);
      await page.goto(url, { waitUntil: "load", timeout: remainingTime() });
      const excludedSelectors = plannedCheck.excludedTestIds.map(testIdSelector);
      const forbiddenSelector = [...mandatoryExclusions, ...excludedSelectors].join(",");
      const regionSelector = testIdSelector(plannedCheck.regionTestId);
      const frames: Buffer[] = [];
      const captureFrame = async () => {
        signal.throwIfAborted();
        if (!passedIsolation() || page.url() !== url) return null;
        const frame = await captureClippedRegion({
          context,
          page,
          regionSelector,
          excludedSelectors,
          forbiddenSelector,
          reversible: request.kind === "video",
        });
        signal.throwIfAborted();
        if (!frame || !passedIsolation() || page.url() !== url) return null;
        return request.kind === "video" ? sanitizeBrowserScreenshot(frame) : frame;
      };
      if (request.kind === "video") {
        const initial = await captureFrame();
        if (!initial) return policyExcluded;
        frames.push(initial);
      }
      for (const interaction of plannedCheck.interactions) {
        const target = page.getByTestId(interaction.testId);
        await target.waitFor({ state: "visible", timeout: remainingTime() });
        const belongsToRegion = await target.evaluate(
          (element, { regionSelector, forbiddenSelector }) =>
            document.querySelector(regionSelector)?.contains(element) &&
            !element.closest(forbiddenSelector),
          { regionSelector, forbiddenSelector },
          { timeout: remainingTime() },
        );
        if (!belongsToRegion) return policyExcluded;
        if (interaction.action === "click") await target.click({ timeout: remainingTime() });
        if (request.kind === "video") {
          const frame = await captureFrame();
          if (!frame) return policyExcluded;
          frames.push(frame);
        }
      }
      const captured = {
        status: "captured",
        identity,
        path: plannedCheck.path,
        browserSessionId: randomUUID(),
      } as const;
      if (request.kind === "video") {
        // Close Chromium before encoding. The encoder receives only normalized crops.
        await close();
        signal.throwIfAborted();
        const encoded = await encodeBrowserVideo({ frames, paths: request.encoder, signal });
        signal.throwIfAborted();
        return { ...captured, ...encoded, startedAt, completedAt: new Date().toISOString() };
      }
      const bytes = await captureFrame();
      return bytes ? { ...captured, bytes } : policyExcluded;
    } finally {
      await close();
    }
  }
}

/** Only the Node worker entrypoint instantiates these adapters. */
export function createBrowserScreenshotRuntime(
  env: Record<string, string | undefined> = process.env,
): BrowserScreenshotRuntime | null {
  const configuration = readBrowserFixtureEnvironment(env);
  const approvalScopeId = readBrowserFixtureApprovalScope(
    env.WALLIE_BROWSER_FIXTURE_APPROVAL_SCOPE,
  );
  if (!configuration || !approvalScopeId || approvalScopeId.endsWith("/record_video")) return null;
  return {
    approvalScopeId,
    captureScreenshot: (input) => captureBrowserMedia(configuration, input, { kind: "screenshot" }),
  };
}

export function createBrowserVideoRuntime(
  env: Record<string, string | undefined> = process.env,
): BrowserVideoRuntime | null {
  const configuration = readBrowserFixtureEnvironment(env);
  const approvalScopeId = readBrowserFixtureApprovalScope(env.WALLIE_BROWSER_VIDEO_APPROVAL_SCOPE);
  const encoder = browserVideoEncoderPaths(env);
  if (!configuration || !approvalScopeId?.endsWith("/record_video") || !encoder) return null;
  return {
    approvalScopeId,
    captureVideo: async (input) => {
      const result = await captureBrowserMedia(configuration, input, { kind: "video", encoder });
      if (result.status !== "captured" || "timeline" in result) return result;
      return { status: "failed", reason: "capture_failed" };
    },
  };
}
