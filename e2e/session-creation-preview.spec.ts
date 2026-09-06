import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";

import { signIn } from "./helpers/auth";

const workspacePath = "/w/acme-corp";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("creation from a deep link closes immediately and lets navigation win over a late success", async ({
  page,
}) => {
  await page.goto(`${workspacePath}/sessions?create=1`);
  await page.getByLabel("Prompt", { exact: true }).fill("Keep working during creation");
  const createGate = deferred();
  const dismissGate = deferred();
  await page.route("**/api/sessions", async (route) => {
    await createGate.promise;
    await route.fulfill({
      status: 201,
      json: { canonicalUrl: `${workspacePath}/sessions/1`, number: 1 },
    });
  });
  await page.route(`**${workspacePath}/sessions?*`, async (route) => {
    const url = new URL(route.request().url());
    if (route.request().headers().rsc === "1" && !url.searchParams.has("create"))
      await dismissGate.promise;
    await route.continue();
  });
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.locator("[data-session-creation]")).toBeVisible();
  dismissGate.release();
  await expect(page).toHaveURL(`${workspacePath}/sessions`);
  await page.getByRole("link", { name: "Pipeline", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Pipeline", exact: true })).toBeVisible();
  createGate.release();
  await expect(page.getByText("Session #1 created.", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(workspacePath);
  await page.getByRole("button", { name: "Open session", exact: true }).click();
  await expect(page).toHaveURL(`${workspacePath}/sessions/1`);
});

test.beforeEach(async ({ page }) => {
  await page.route("**/api/workspaces/*/session-repositories", (route) =>
    route.fulfill({
      json: {
        defaultGithubRepositoryId: "repo-fixture",
        repositoryOptions: [{ id: "repo-fixture", fullName: "acme/wallie" }],
        pipelineId: "pipeline-fixture",
        stageOptions: [
          { id: "plan-fixture", name: "Plan", position: 0, description: "Plan the work" },
          { id: "build-fixture", name: "Build", position: 1, description: "Implement the plan" },
        ],
      },
    }),
  );
  await signIn(page);
});

for (const mobile of [false, true]) {
  test(`creation previews work before the response and restores a rejected draft (${mobile ? "mobile" : "desktop"})`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const gate = deferred();
    const requests: unknown[] = [];
    await page.route("**/api/sessions", async (route) => {
      requests.push(route.request().postDataJSON());
      await gate.promise;
      await route.fulfill({
        status: 422,
        json: {
          error: "The selected repository is unavailable. Choose another repository and retry.",
        },
      });
    });
    await page.getByRole("button", { name: "New session" }).click();
    await page
      .getByLabel("Prompt", { exact: true })
      .fill("Add keyboard shortcuts to quickly move between sessions and their artifacts.");
    await page.getByLabel("Title (optional)").fill("Make every session feel effortless");
    await page.getByRole("button", { name: "Start session" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    const preview = page.locator("[data-session-creation]");
    await expect(preview).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Make every session feel effortless" }),
    ).toBeFocused();
    await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeHidden();
    await expect(preview.getByText("Creating session…")).toBeVisible();
    expect(requests).toHaveLength(1);
    await expect(page).toHaveURL(`${workspacePath}/sessions`);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await mkdir(".wallie/screenshots", { recursive: true });
    await page.screenshot({
      path: `.wallie/screenshots/creation-pending-${mobile ? "mobile" : "desktop"}.png`,
      fullPage: true,
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect
      .poll(() =>
        preview.evaluate((element) => parseFloat(getComputedStyle(element).animationDuration)),
      )
      .toBeLessThan(0.001);
    gate.release();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
      "Add keyboard shortcuts to quickly move between sessions and their artifacts.",
    );
    await expect(page.getByLabel("Prompt", { exact: true })).toBeEnabled();
    await expect(page.getByText(/selected repository is unavailable/)).toBeVisible();
    await expect(page.locator("#create-session-error")).toBeFocused();
    await page.screenshot({
      path: `.wallie/screenshots/creation-rejected-${mobile ? "mobile" : "desktop"}.png`,
      fullPage: true,
    });
    if (mobile)
      await page.screenshot({ path: ".wallie/screenshots/creation-rejected-mobile-viewport.png" });
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
    expect(requests).toHaveLength(1);
  });
}

test("a lost response retries the same request and keeps its preview until the canonical route commits", async ({
  page,
}) => {
  const requests: unknown[] = [];
  const createGate = deferred();
  const navigationGate = deferred();
  await page.route("**/api/workspaces/*/session-attachments", (route) =>
    route.fulfill({
      json: {
        id: "attachment-fixture",
        fileName: "reference.png",
        contentType: "image/png",
        sizeBytes: 68,
      },
    }),
  );
  await page.route("**/api/sessions", async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) return route.abort("failed");
    await createGate.promise;
    await route.fulfill({
      status: 201,
      json: { canonicalUrl: `${workspacePath}/sessions/1`, number: 1 },
    });
  });
  await page.route(`**${workspacePath}/sessions/1?*`, async (route) => {
    if (route.request().headers().rsc === "1") await navigationGate.promise;
    await route.continue();
  });
  await page.getByRole("button", { name: "New session" }).click();
  await page
    .getByLabel("Prompt", { exact: true })
    .fill("Create once, even when the response is lost");
  await page.getByLabel("Add images", { exact: true }).setInputFiles({
    name: "reference.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC8kAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(page.getByText(/68 B · Ready/)).toBeVisible();
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page.getByRole("button", { name: "Retry creation" })).toBeVisible();
  await expect(page.getByLabel("Prompt", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Retry creation" }).click();
  const preview = page.locator("[data-session-creation]");
  await expect(preview).toBeVisible();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual(requests[0]);
  createGate.release();
  // Hold the destination response so the shell cannot briefly expose the old list.
  await expect(page.locator("[data-route-progress]")).toBeVisible();
  await expect(preview).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeHidden();
  const imageUrl = await preview.getByRole("img", { name: "reference.png" }).getAttribute("src");
  expect(
    await page.evaluate(async (url) => {
      try {
        return (await fetch(url!)).ok;
      } catch {
        return false;
      }
    }, imageUrl),
  ).toBe(true);
  navigationGate.release();
  await expect(page).toHaveURL(`${workspacePath}/sessions/1`);
  await expect(preview).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Add SSO login via Google Workspace", exact: true }),
  ).toBeVisible();
});
