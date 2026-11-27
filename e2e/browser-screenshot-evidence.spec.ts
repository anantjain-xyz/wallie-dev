import { createHash } from "node:crypto";

import { expect, test } from "@playwright/test";

const sessionId = "11111111-1111-4111-8111-111111111111";
const artifactId = "33333333-3333-4333-8333-333333333333";
const runId = "58400000-0000-4000-8000-000000000010";
const availableId = "58400000-0000-4000-8000-000000000011";
const missingId = "58400000-0000-4000-8000-000000000012";
const path = "/dev/artifact-evidence";
const commitSha = "a39cadb8125a6c1eced1b3f36fdbf8ed62fd580a";
const treeSha = "b776e07946a04c2cc201588fadc53d1a14373112";
const metadataPath = `/api/sessions/${sessionId}/validation-evidence`;
const imagePath = `${metadataPath}/browser-assets/`;
const screenshotAnchor = `browser-screenshot-${availableId}`;

for (const profile of ["desktop", "mobile"] as const) {
  test(`inspect exact browser screenshots on ${profile}`, async ({ browser, page }, testInfo) => {
    const fixture = await browser.newPage({ viewport: { width: 590, height: 280 } });
    let png: Buffer;
    try {
      await fixture.setContent(`<!doctype html><html><head><title>Screenshot fixture</title></head>
        <body style="margin:0;background:#edf2f6;font:16px system-ui;color:#14212d">
          <main style="padding:25px 30px;background:white;border:1px solid #d2dae2;min-height:228px">
            <p style="font-size:13px;letter-spacing:0.06em;color:#536a7d">Verification workspace</p>
            <h1 style="font-weight:650;font-size:23px;margin:6px 0 20px">Review queue</h1>
            <div style="border-top:1px solid #dee6ed;padding:12px 0;display:flex;justify-content:space-between">
              <span>Validate checkout flow</span><span style="color:#176447">Ready for review</span>
            </div>
            <div style="border-top:1px solid #dee6ed;padding:12px 0;display:flex;justify-content:space-between">
              <span>Check empty-state copy</span><span style="color:#415468">Complete</span>
            </div>
          </main>
        </body></html>`);
      png = await fixture.screenshot();
    } finally {
      await fixture.close();
    }
    const digest = createHash("sha256").update(png).digest("hex");
    let reads = 0;
    const byteRequests: string[] = [];
    const record = (assetId: string, key: string) => ({
      key,
      kind: "screenshot",
      path: "/fixtures/review-queue",
      policy: "isolated-fixture-v1",
      status: "captured",
      browserSessionId: "58400000-0000-4000-8000-000000000013",
      manifest: { assetId, contentType: "image/png", sha256: digest, sizeBytes: png.length },
      downloadUrl: `${imagePath}${assetId}?runId=${runId}&artifactId=${artifactId}`,
    });
    await page.route(
      (url) => url.pathname === metadataPath,
      async (route) => {
        const url = new URL(route.request().url());
        expect(url.searchParams.get("artifactId")).toBe(artifactId);
        reads++;
        await route.fulfill({
          json: {
            browserEvidence: [
              {
                runId,
                attemptCount: 2,
                commitSha,
                treeSha,
                createdAt: "2026-11-19T17:25:00.000Z",
                records: [
                  record(availableId, "review-queue"),
                  record(missingId, "removed-screenshot"),
                ],
              },
            ],
          },
        });
      },
    );
    await page.route(
      (url) => url.pathname.startsWith(imagePath),
      async (route) => {
        const url = new URL(route.request().url());
        expect(url.searchParams.get("artifactId")).toBe(artifactId);
        expect(url.searchParams.get("runId")).toBe(runId);
        byteRequests.push(url.pathname);
        if (url.pathname.endsWith(missingId)) {
          await route.fulfill({ status: 409, json: { error: "Evidence image is unavailable." } });
        } else {
          await route.fulfill({ contentType: "image/png", body: png });
        }
      },
    );

    await page.setViewportSize(
      profile === "mobile" ? { width: 390, height: 844 } : { width: 1280, height: 1000 },
    );
    if (profile === "mobile") await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(path);
    await page.getByText("Evidence", { exact: true }).press("Enter");
    const disclosure = page.getByRole("button", { name: "Browser screenshots" });
    await expect(disclosure).toBeVisible();
    expect(reads).toBe(0);
    expect(byteRequests).toEqual([]);

    await disclosure.focus();
    await page.keyboard.press("Enter");
    const evidence = page.locator(`#${screenshotAnchor}`);
    await expect(evidence.getByText(commitSha)).toBeVisible();
    await expect(evidence.getByText(treeSha)).toBeVisible();
    expect(reads).toBe(1);
    expect(byteRequests).toEqual([]);

    const view = evidence.getByRole("button", { name: "View screenshot" });
    await view.focus();
    await page.keyboard.press("Enter");
    const image = evidence.getByRole("img", { name: "Screenshot captured for review-queue" });
    await expect(image).toBeVisible();
    await expect
      .poll(() =>
        image.evaluate((element) =>
          element instanceof HTMLImageElement ? element.naturalWidth : 0,
        ),
      )
      .toBe(590);
    await expect(evidence.getByRole("button", { name: "Hide screenshot" })).toBeFocused();
    expect(byteRequests).toEqual([imagePath + availableId]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      profile === "mobile" ? 390 : 1280,
    );
    await evidence.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`op585-review-screenshot-${profile}.png`),
      fullPage: true,
    });

    const missing = page.locator(`#browser-screenshot-${missingId}`);
    await missing.getByRole("button", { name: "View screenshot" }).click();
    await expect(missing.getByText("Screenshot unavailable.", { exact: false })).toBeVisible();
    await expect(missing.getByText(commitSha)).toBeVisible();
    await expect(missing.getByText(digest)).toBeVisible();
    await missing.scrollIntoViewIfNeeded();
    if (profile === "desktop") {
      await missing.screenshot({
        path: testInfo.outputPath("op585-review-screenshot-unavailable.png"),
      });
    }
    const link = evidence.getByRole("link", { name: "Link to screenshot evidence" });
    const artifactEvidenceQuery = `?artifactStage=build&artifactId=${artifactId}&artifactVersion=2&browserScreenshotEvidence=1`;
    await expect(link).toHaveAttribute("href", `${artifactEvidenceQuery}#${screenshotAnchor}`);

    await page.goto("about:blank");
    await page.goto(path + artifactEvidenceQuery + `#${screenshotAnchor}`);
    await expect(evidence.getByText(commitSha)).toBeVisible();
    await expect(evidence.getByRole("button", { name: "View screenshot" })).toBeVisible();
    expect(byteRequests).toHaveLength(2);
    await expect(page.getByRole("tab", { name: "Rendered" })).toBeVisible();
  });
}
