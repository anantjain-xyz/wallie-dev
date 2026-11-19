import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { chromium, type APIResponse, type BrowserContext, type Page } from "playwright-core";
import { expect } from "vitest";
import { z } from "zod";

import type { Database } from "@/lib/supabase/database.types";
import { browserScreenshotPath, browserVideoPath } from "@/lib/validation-evidence/browser-assets";
import { VALIDATION_EVIDENCE_BUCKET } from "@/lib/validation-evidence/contracts";

import type { FactoryBrowserReviewFixture } from "./factory-runtime-fixture";

type BrowserQualificationOptions = {
  appUrl: string;
  proofDir?: string;
  supabaseUrl: string;
  serviceKey: string;
  publishableKey: string;
};

const routeOptions = { maxRedirects: 0, timeout: 20_000 };
const uiTimeout = 25_000;
const evidenceLabel = "qualification";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function loopbackOrigin(value: string) {
  const url = new URL(value);
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
    "Expected a loopback fixture.",
  );
  assert.ok(
    url.protocol === "http:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/",
    "Expected a fixture origin.",
  );
  return url.origin;
}

async function signInBrowser({
  context,
  app,
  supabase,
  publishableKey,
  credentials,
}: {
  context: BrowserContext;
  app: string;
  supabase: string;
  publishableKey: string;
  credentials: FactoryBrowserReviewFixture["owner"];
}) {
  const jar = new Map<string, string>();
  const signed = createServerClient<Database>(supabase, publishableKey, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (writes) => writes.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  const result = await signed.auth.signInWithPassword(credentials);
  assert.ok(!result.error && result.data.user && jar.size, "Synthetic reviewer did not sign in.");
  await context.addCookies(
    [...jar].map(([name, value]) => ({ name, value, url: app, httpOnly: true })),
  );
  return signed;
}

function exactStatus(response: APIResponse, code: number, operation: string) {
  assert.equal(response.status(), code, operation);
}

function privateFailure(response: APIResponse, code: number, operation: string) {
  exactStatus(response, code, operation);
  const headers = response.headers();
  assert.match(headers["content-type"] ?? "", /^application\/json(?:;|$)/);
  assert.equal(headers.location, undefined);
  assert.equal(headers["content-disposition"], undefined);
}

async function capture(page: Page, proofDir: string | undefined, name: string) {
  if (proofDir)
    await page.screenshot({ path: join(proofDir, `${name}.png`), animations: "disabled" });
}

async function decodedScreenshot(page: Page) {
  await page
    .getByRole("button", { name: "View screenshot", exact: true })
    .click({ timeout: uiTimeout });
  const image = page.getByRole("img", {
    name: `Screenshot captured for ${evidenceLabel}`,
    exact: true,
  });
  await image.waitFor({ timeout: uiTimeout });
  const pixels = await image.evaluate(async (element) => {
    if (!(element instanceof HTMLImageElement)) return { canary: 0, revealed: 0 };
    await element.decode();
    const canvas = document.createElement("canvas");
    canvas.width = element.naturalWidth;
    canvas.height = element.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Screenshot pixel reader was unavailable.");
    context.drawImage(element, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let canary = 0;
    let revealed = 0;
    for (let index = 0; index < data.length; index += 4) {
      const red = data[index];
      const green = data[index + 1];
      const blue = data[index + 2];
      if (red === 255 && green === 0 && blue === 255) canary++;
      if (red === 25 && green === 108 && blue === 85) revealed++;
    }
    return { canary, revealed };
  });
  assert.equal(pixels.canary, 0, "The exclusion canary must be absent from the PNG.");
  assert.ok(pixels.revealed > 100, "The click must reveal actual screenshot pixels.");
  return image;
}

async function verifyPlayback(page: Page, milliseconds: number) {
  const player = page.locator(`video[aria-label="Recording captured for ${evidenceLabel}"]`);
  await player.waitFor({ timeout: uiTimeout });
  await expect
    .poll(
      () =>
        player.evaluate((element, seconds) => {
          return (
            element instanceof HTMLVideoElement &&
            !element.seeking &&
            element.paused &&
            element.readyState >= 2 &&
            Math.abs(element.currentTime - seconds) < 0.08
          );
        }, milliseconds / 1000),
      { timeout: uiTimeout },
    )
    .toBe(true);
  return player;
}

async function frozenInputHistory(page: Page, fixture: FactoryBrowserReviewFixture) {
  const frozen = page.locator("#frozen-inputs");
  for (const value of [
    fixture.context.sourceId,
    fixture.context.revisionId,
    fixture.context.sha256,
    fixture.memory.entryId,
    fixture.memory.approvedRevisionId,
    fixture.memory.sha256,
  ]) {
    await frozen.getByText(value, { exact: true }).waitFor({ timeout: uiTimeout });
  }
  for (const { id, revision, pageKind, entryKey } of [
    {
      id: fixture.context.sourceId,
      revision: fixture.context.revisionId,
      pageKind: "context",
      entryKey: "source",
    },
    {
      id: fixture.memory.entryId,
      revision: fixture.memory.approvedRevisionId,
      pageKind: "memory",
      entryKey: "memory",
    },
  ]) {
    const row = frozen.getByRole("listitem").filter({ hasText: id });
    const href = await row.getByRole("link").getAttribute("href", { timeout: uiTimeout });
    assert.ok(href, `The historical ${pageKind} revision has no link.`);
    const target = new URL(href, page.url());
    assert.equal(target.pathname, `/w/${fixture.workspaceSlug}/${pageKind}`);
    assert.equal(target.searchParams.get("factory"), fixture.factoryId);
    assert.equal(target.searchParams.get(entryKey), id);
    assert.equal(target.searchParams.get("revision"), revision);
  }
  return frozen;
}

/** Inspects the actual accepted browser evidence and frozen inputs after worker teardown. */
export async function runAuthenticatedBrowserQualification(
  fixture: FactoryBrowserReviewFixture,
  { appUrl, proofDir, supabaseUrl, serviceKey, publishableKey }: BrowserQualificationOptions,
) {
  const app = loopbackOrigin(appUrl);
  const supabase = loopbackOrigin(supabaseUrl);
  assert.notEqual(app, supabase, "The fixture app and Storage must use separate origins.");
  assert.match(fixture.owner.email, /@example\.test$/i);
  assert.notEqual(fixture.run.id, fixture.run.otherRunId);
  z.array(z.string().uuid()).parse([
    fixture.workspaceId,
    fixture.run.id,
    fixture.screenshot.id,
    fixture.recording.id,
  ]);
  if (proofDir) {
    assert.ok(isAbsolute(proofDir), "The optional synthetic proof directory must be absolute.");
    await mkdir(proofDir, { recursive: true, mode: 0o700 });
  }
  const admin = createClient<Database>(supabase, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const mediaBucket = admin.storage.from(VALIDATION_EVIDENCE_BUCKET);
  const pngPath = browserScreenshotPath(fixture.workspaceId, fixture.run.id, fixture.screenshot.id);
  const webmPath = browserVideoPath(fixture.workspaceId, fixture.run.id, fixture.recording.id);
  const api = `${app}/api/sessions/${fixture.sessionId}`;
  const evidence = `${api}/validation-evidence`;
  const exact = new URLSearchParams({ runId: fixture.run.id, artifactId: fixture.artifact.id });
  const wrongRun = new URLSearchParams({
    runId: fixture.run.otherRunId,
    artifactId: fixture.artifact.id,
  });
  const workspace = `${app}/w/${fixture.workspaceSlug}`;
  const session = `${workspace}/sessions/${fixture.sessionNumber}`;
  const artifactQuery = new URLSearchParams({
    artifactStage: fixture.artifact.stageSlug,
    artifactId: fixture.artifact.id,
    artifactVersion: String(fixture.artifact.version),
  });
  const withScreenshot = new URLSearchParams(artifactQuery);
  withScreenshot.set("browserScreenshotEvidence", "1");
  const withRecording = new URLSearchParams(artifactQuery);
  withRecording.set("browserRecordingEvidence", "1");
  const screenshotHash = `#browser-screenshot-${fixture.screenshot.id}`;
  const recordingHash = (offset: number) => `#browser-recording-${fixture.recording.id}-${offset}`;
  const runPage = `${workspace}/runs/${fixture.run.id}`;
  const assets = [
    {
      id: fixture.screenshot.id,
      sha256: fixture.screenshot.sha256,
      path: pngPath,
      mime: "image/png",
      endpoint: "browser-assets",
    },
    {
      id: fixture.recording.id,
      sha256: fixture.recording.sha256,
      path: webmPath,
      mime: "video/webm",
      endpoint: "browser-videos",
    },
  ];
  const screenshotUrl = `${evidence}/browser-assets/${fixture.screenshot.id}?${exact}`;
  const recordingUrl = `${evidence}/browser-videos/${fixture.recording.id}?${exact}`;

  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
  });
  const outsider = {
    email: `media-outsider-${randomUUID()}@example.test`,
    password: randomBytes(32).toString("hex"),
  };
  let outsiderId: string | undefined;
  try {
    const created = await admin.auth.admin.createUser({ ...outsider, email_confirm: true });
    assert.ok(!created.error && created.data.user, "Could not create disposable non-member.");
    outsiderId = created.data.user.id;
    const ownerContext = await browser.newContext({
      viewport: { width: 1280, height: 950 },
      reducedMotion: "reduce",
    });
    const outsiderContext = await browser.newContext();
    const anonymousContext = await browser.newContext();
    const ownerStore = await signInBrowser({
      context: ownerContext,
      app,
      supabase,
      publishableKey,
      credentials: fixture.owner,
    });
    await signInBrowser({
      context: outsiderContext,
      app,
      supabase,
      publishableKey,
      credentials: outsider,
    });
    const page = await ownerContext.newPage();
    const owner = ownerContext.request;

    for (const asset of assets) {
      const base = `${evidence}/${asset.endpoint}/${asset.id}`;
      const exactUrl = `${base}?${exact}`;
      const response = await owner.get(exactUrl, routeOptions);
      exactStatus(response, 200, `Owner can read exact ${asset.mime}`);
      assert.equal(response.headers()["content-type"], asset.mime);
      assert.equal(response.headers()["cache-control"], "private, no-store");
      assert.equal(digest(await response.body()), asset.sha256, `Exact bytes for ${asset.mime}`);
      privateFailure(
        await anonymousContext.request.get(exactUrl, routeOptions),
        401,
        "Signed-out request",
      );
      privateFailure(
        await outsiderContext.request.get(exactUrl, routeOptions),
        404,
        "Signed-in non-member request",
      );
      privateFailure(
        await owner.get(`${base}?${wrongRun}`, routeOptions),
        409,
        "Wrong run for the exact artifact",
      );
      privateFailure(
        await owner.get(`${base}?runId=${fixture.run.otherRunId}`, routeOptions),
        404,
        "Wrong run without an artifact selector",
      );
      const storage = ownerStore.storage.from(VALIDATION_EVIDENCE_BUCKET);
      const direct = await storage.download(asset.path);
      assert.ok(
        direct.error && !direct.data,
        `Direct user access to ${asset.mime} must be denied.`,
      );
      const signed = await storage.createSignedUrl(asset.path, 60);
      assert.ok(
        signed.error && !signed.data,
        `Direct user signing of ${asset.mime} must be denied.`,
      );
    }
    privateFailure(
      await owner.get(`${evidence}/browser-assets/${fixture.recording.id}?${exact}`, routeOptions),
      409,
      "WebM offered to PNG endpoint",
    );
    privateFailure(
      await owner.get(`${evidence}/browser-videos/${fixture.screenshot.id}?${exact}`, routeOptions),
      404,
      "PNG offered to recording endpoint",
    );
    const range = await owner.get(recordingUrl, {
      ...routeOptions,
      headers: { Range: "bytes=0-31" },
    });
    exactStatus(range, 200, "Range request must receive the independently verified full recording");
    assert.equal(digest(await range.body()), fixture.recording.sha256);

    await page.goto(`${session}?${withScreenshot}${screenshotHash}`);
    const screenshot = await decodedScreenshot(page);
    await page
      .getByText(fixture.screenshot.sha256, { exact: true })
      .waitFor({ timeout: uiTimeout });
    await screenshot.scrollIntoViewIfNeeded();
    await capture(page, proofDir, "01-workbench-screenshot");
    await page.goto(`${session}?${withRecording}${recordingHash(fixture.recording.stepOffsetMs)}`);
    await verifyPlayback(page, fixture.recording.stepOffsetMs);

    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`${runPage}${recordingHash(0)}`);
    await verifyPlayback(page, 0);
    const step = page.getByRole("link", { name: /click qualification-action/i });
    await step.focus();
    await step.press("Enter");
    await page.waitForURL((url) => url.hash === recordingHash(fixture.recording.stepOffsetMs));
    const player = await verifyPlayback(page, fixture.recording.stepOffsetMs);
    const playback = page.getByRole("list", { name: "Browser recordings" });
    for (const value of [
      fixture.run.id,
      fixture.run.commitSha,
      fixture.run.validationTreeSha,
      fixture.recording.sha256,
    ]) {
      await playback.getByText(value, { exact: true }).waitFor({ timeout: uiTimeout });
    }
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      "The 390px inspector must fit horizontally.",
    );
    const frozen = await frozenInputHistory(page, fixture);
    await player.scrollIntoViewIfNeeded();
    await capture(page, proofDir, "02-run-inspector-recording");
    await page.setViewportSize({ width: 1280, height: 950 });
    if (proofDir) {
      await frozen.screenshot({
        path: join(proofDir, "03-frozen-input-receipt.png"),
        animations: "disabled",
      });
    }

    // Remove only the exact synthetic PNG. The immutable receipt and other retained bytes remain.
    const removed = await mediaBucket.remove([pngPath]);
    assert.ok(
      !removed.error && removed.data.length === 1,
      "The synthetic PNG did not physically disappear.",
    );
    privateFailure(
      await owner.get(screenshotUrl, routeOptions),
      409,
      "Missing PNG with its original receipt",
    );
    exactStatus(
      await owner.get(recordingUrl, routeOptions),
      200,
      "Recording unaffected by missing PNG",
    );
    await page.goto(`${runPage}${screenshotHash}`);
    await page
      .getByRole("button", { name: "View screenshot", exact: true })
      .click({ timeout: uiTimeout });
    await page
      .getByText("Screenshot unavailable. The capture receipt is still available.", { exact: true })
      .waitFor({ timeout: uiTimeout });
    await page
      .getByText(fixture.screenshot.sha256, { exact: true })
      .waitFor({ timeout: uiTimeout });
    assert.equal(
      await page
        .getByRole("img", { name: `Screenshot captured for ${evidenceLabel}`, exact: true })
        .count(),
      0,
    );

    exactStatus(
      await owner.post(`${api}/archive`, routeOptions),
      200,
      "Archive accepted synthetic session",
    );
    await page.setViewportSize({ width: 1280, height: 950 });
    await page.goto(`${session}?${artifactQuery}`);
    await page
      .getByRole("button", { name: "Erase retained content", exact: true })
      .click({ timeout: uiTimeout });
    const dialog = page.getByRole("alertdialog", { name: "Erase retained session content?" });
    await dialog.waitFor({ timeout: uiTimeout });
    const erasure = page.waitForResponse(
      (response) =>
        response.url() === `${api}/retained-content` && response.request().method() === "DELETE",
      { timeout: uiTimeout },
    );
    await dialog.getByRole("button", { name: "Erase content", exact: true }).click();
    const erased = await erasure;
    assert.equal(erased.status(), 200, "Exact archived session erasure");
    const erasedState = z.object({
      erasedAt: z.string().datetime({ offset: true }),
      canErase: z.literal(false),
    });
    erasedState.parse(await erased.json());
    await page.reload();
    await page
      .getByText("Retained content erased", { exact: true })
      .waitFor({ timeout: uiTimeout });
    assert.equal(await page.getByRole("button", { name: "Unarchive", exact: true }).count(), 0);
    const physicalVideo = await mediaBucket.download(webmPath);
    assert.ok(
      !physicalVideo.error && physicalVideo.data,
      "Withholding must be proved while WebM remains in Storage.",
    );
    assert.equal(
      digest(Buffer.from(await physicalVideo.data.arrayBuffer())),
      fixture.recording.sha256,
    );
    for (const url of [screenshotUrl, recordingUrl]) {
      const response = await owner.get(url, { ...routeOptions, headers: { Range: "bytes=0-31" } });
      privateFailure(response, 410, "Erased media must return no partial or full bytes");
      assert.equal(response.headers()["cache-control"], "private, no-store");
      z.object({ availability: z.literal("erased") }).parse(await response.json());
    }
    await page.goto(`${session}?${withRecording}${recordingHash(fixture.recording.stepOffsetMs)}`);
    const unavailable = page.getByText(
      "Recording unavailable. The capture receipt is still available.",
      { exact: true },
    );
    await unavailable.waitFor({ timeout: uiTimeout });
    await page.getByText(fixture.recording.sha256, { exact: true }).waitFor({ timeout: uiTimeout });
    assert.equal(await page.locator("video").count(), 0);
    await unavailable.scrollIntoViewIfNeeded();
    await capture(page, proofDir, "04-erased-recording-receipt");
  } finally {
    try {
      await browser.close();
    } finally {
      if (outsiderId) {
        const removed = await admin.auth.admin.deleteUser(outsiderId);
        assert.ok(!removed.error, "Could not clean up the disposable non-member.");
      }
    }
  }
}
