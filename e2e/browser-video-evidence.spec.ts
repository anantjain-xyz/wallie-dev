import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

const previewPath = "/dev/artifact-evidence";
const sessionId = "11111111-1111-4111-8111-111111111111";
const artifactId = "33333333-3333-4333-8333-333333333333";
const runId = "58700000-0000-4000-8000-000000000010";
const availableId = "58700000-0000-4000-8000-000000000011";
const missingId = "58700000-0000-4000-8000-000000000012";
const metadataPath = `/api/sessions/${sessionId}/validation-evidence`;
const videoPath = `${metadataPath}/browser-videos/`;
const artifactQuery = `?artifactStage=build&artifactId=${artifactId}&artifactVersion=2&browserRecordingEvidence=1`;
const commitSha = "a39cadb8125a6c1eced1b3f36fdbf8ed62fd580a";
const treeSha = "b776e07946a04c2cc201588fadc53d1a14373112";
const completedAt = "2026-11-19T17:25:01.500Z";
// Silent VP8, with independently decodable red, green, and blue frames at 0, 500, and 1000 ms.
const bytes = readFileSync(join(__dirname, "fixtures", "browser-verification.webm"));
const digest = createHash("sha256").update(bytes).digest("hex");
const steps = [
  { action: "entry", offsetMs: 0 },
  { action: "click", testId: "open-review", offsetMs: 500 },
  { action: "expectVisible", testId: "confirmation", offsetMs: 1000 },
];
const anchor = (assetId: string, offsetMs: number) => `#browser-recording-${assetId}-${offsetMs}`;

async function stubEvidence(page: Page, waitForVideo?: Promise<void>) {
  const requested = { metadata: 0, video: [] as string[] };
  const record = (assetId: string, key: string) => ({
    key,
    path: "/fixtures/review-queue",
    policy: "isolated-fixture-v1",
    kind: "video",
    status: "captured",
    browserSessionId: "58700000-0000-4000-8000-000000000013",
    startedAt: "2026-11-19T17:25:00.000Z",
    completedAt,
    manifest: {
      assetId,
      contentType: "video/webm",
      sha256: digest,
      sizeBytes: bytes.length,
      durationMs: 1500,
      frameOffsetsMs: [0, 500, 1000],
      widthPx: 128,
      heightPx: 72,
    },
  });
  await page.route(
    (url) => url.pathname === metadataPath,
    async (route) => {
      expect(new URL(route.request().url()).searchParams.get("artifactId")).toBe(artifactId);
      requested.metadata++;
      await route.fulfill({
        json: {
          browserEvidence: [
            {
              runId,
              attemptCount: 2,
              commitSha,
              treeSha,
              createdAt: completedAt,
              records: [
                record(availableId, "review-queue"),
                record(missingId, "removed-recording"),
                {
                  key: "incomplete-recording",
                  path: "/fixtures/review-queue",
                  policy: "isolated-fixture-v1",
                  kind: "video",
                  status: "failed",
                  reason: "capture_failed",
                },
              ],
              videoFindings: [availableId, missingId].map((assetId) => ({ assetId, steps })),
            },
          ],
        },
      });
    },
  );
  await page.route(
    (url) => url.pathname.startsWith(videoPath),
    async (route) => {
      const url = new URL(route.request().url());
      expect(url.searchParams.get("artifactId")).toBe(artifactId);
      expect(url.searchParams.get("runId")).toBe(runId);
      const assetId = url.pathname.slice(videoPath.length);
      requested.video.push(assetId);
      if (assetId === missingId) {
        await route.fulfill({ status: 409, json: { error: "Evidence video is unavailable." } });
        return;
      }
      await waitForVideo;
      await route.fulfill({ contentType: "video/webm", body: bytes });
    },
  );
  return requested;
}

async function expectPausedAt(video: Locator, seconds: number) {
  await expect
    .poll(() =>
      video.evaluate(
        (element: HTMLVideoElement, target) =>
          element.paused &&
          !element.seeking &&
          element.readyState === element.HAVE_ENOUGH_DATA &&
          Math.abs(element.currentTime - target) < 0.1,
        seconds,
      ),
    )
    .toBe(true);
}

async function frameDominates(video: Locator, channel: 0 | 1 | 2) {
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement, index) => {
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext("2d");
        if (!context) return false;
        context.drawImage(element, 0, 0, 1, 1);
        const rgb = [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
        return rgb[index]! - Math.max(...rgb.filter((_, other) => other !== index)) > 80;
      }, channel),
    )
    .toBe(true);
}

for (const profile of ["desktop", "mobile"] as const) {
  test(`seeks exact private recordings on ${profile}`, async ({ page }, testInfo) => {
    const requested = await stubEvidence(page);
    await page.setViewportSize(
      profile === "mobile" ? { width: 390, height: 844 } : { width: 1280, height: 1000 },
    );
    if (profile === "mobile") await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(previewPath);
    const disclosure = page.getByRole("button", { name: "Browser recordings" });
    await expect(disclosure).toBeVisible();
    expect(requested).toEqual({ metadata: 0, video: [] });
    await disclosure.press("Enter");
    const captured = page
      .getByRole("list", { name: "Browser recordings" })
      .locator(":scope > li")
      .filter({ has: page.getByText("review-queue", { exact: true }) });
    await expect(captured.getByText("Complete capture")).toBeVisible();
    await expect(captured.getByText(treeSha)).toBeVisible();
    await expect(captured.getByText("0:01.5")).toBeVisible();
    expect(requested).toEqual({ metadata: 1, video: [] });

    const confirmation = captured.getByRole("link", {
      name: "0:01 Verify confirmation is visible",
    });
    await expect(confirmation).toHaveAttribute(
      "href",
      `${artifactQuery}${anchor(availableId, 1000)}`,
    );
    await confirmation.press("Enter");
    await expect(page).toHaveURL((url) => url.hash === anchor(availableId, 1000));
    const video = page.locator("video[aria-label='Recording captured for review-queue']");
    await expect(video).toBeVisible();
    await expectPausedAt(video, 1);
    await frameDominates(video, 2);
    await expect(confirmation).toHaveAttribute("aria-current", "location");
    expect(requested.video).toEqual([availableId]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      profile === "mobile" ? 390 : 1280,
    );
    await captured.screenshot({ path: testInfo.outputPath(`op587-recording-${profile}.png`) });

    const click = captured.getByRole("link", { name: "0:00.5 Click open-review" });
    await click.press("Enter");
    await expectPausedAt(video, 0.5);
    await frameDominates(video, 1);
    expect(requested.video).toEqual([availableId]);
    await video.press("Space");
    await expect
      .poll(() => video.evaluate((item: HTMLVideoElement) => item.currentTime > 0.55))
      .toBe(true);
    await click.press("Enter");
    await expectPausedAt(video, 0.5);

    const playerUrl = await video.getAttribute("src");
    expect(playerUrl).toMatch(/^blob:/);
    await captured.getByRole("button", { name: "Hide recording" }).press("Enter");
    await expect(video).toHaveCount(0);
    expect(
      await page.evaluate(async (url) => {
        try {
          return url !== null && (await fetch(url)).ok;
        } catch {
          return false;
        }
      }, playerUrl),
    ).toBe(false);

    const missing = page
      .getByRole("list", { name: "Browser recordings" })
      .locator(":scope > li")
      .filter({ has: page.getByText("removed-recording", { exact: true }) });
    await missing.getByRole("button", { name: "Load recording" }).press("Enter");
    await expect(missing.getByText("Recording unavailable.", { exact: false })).toBeVisible();
    await expect(missing.getByText(commitSha)).toBeVisible();
    await expect(missing.getByText(digest)).toBeVisible();
    await expect(page.getByText("Capture incomplete")).toBeVisible();
    if (profile === "desktop") {
      await missing.screenshot({ path: testInfo.outputPath("op587-recording-unavailable.png") });
    }
    await expect(page.getByRole("tab", { name: "Rendered" })).toBeVisible();
  });
}

test("keeps invalid finding times and dismissed requests from opening private media", async ({
  page,
}) => {
  let deliverVideo!: () => void;
  const waitForVideo = new Promise<void>((resolve) => {
    deliverVideo = resolve;
  });
  const requested = await stubEvidence(page, waitForVideo);
  await page.goto(previewPath + artifactQuery + anchor(availableId, 999));
  await expect(
    page.getByText("The linked recording or capture time is unavailable."),
  ).toBeVisible();
  expect(requested.video).toEqual([]);
  const captured = page
    .getByRole("list", { name: "Browser recordings" })
    .locator(":scope > li")
    .filter({ has: page.getByText("review-queue", { exact: true }) });
  await captured.getByRole("button", { name: "Load recording" }).click();
  await expect.poll(() => requested.video).toEqual([availableId]);
  await captured.getByRole("button", { name: "Hide recording" }).click();
  deliverVideo();
  await expect(captured.locator("video")).toHaveCount(0);
  await expect(captured.getByRole("button", { name: "Load recording" })).toBeVisible();
});
