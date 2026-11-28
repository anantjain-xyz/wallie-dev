import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

import { signIn } from "./helpers/auth";

const workspacePath = "/w/acme-corp";

test("cancel and browser Back return from a direct launch to the original factory view", async ({
  page,
}) => {
  const origin = `${workspacePath}/runs?status=success&factory=all#main-content`;
  const launch = `${workspacePath}/sessions?${new URLSearchParams({ create: "1", returnTo: origin })}`;
  await page.goto(origin);
  await page.goto(launch);
  const dialog = page.getByRole("dialog", { name: "Start a new session" });
  await expect(dialog).toBeVisible();
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe(origin);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(origin);
  await expect(page.getByRole("main")).toBeFocused();

  await page.goto(launch);
  await expect(dialog).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(origin);
  await expect(dialog).toBeHidden();
});

test("workspace switcher navigation wins while its route response is delayed", async ({ page }) => {
  const createGate = deferred();
  const navigationGate = deferred();
  await page.route(`**${workspacePath}?*`, async (route) => {
    if (route.request().headers().rsc === "1") await navigationGate.promise;
    await route.continue();
  });
  await page.reload();
  await page.route("**/api/sessions", async (route) => {
    await createGate.promise;
    await route.fulfill({
      status: 201,
      json: { canonicalUrl: `${workspacePath}/sessions/1`, number: 1 },
    });
  });
  const canonicalRequests: string[] = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname === `${workspacePath}/sessions/1` &&
      request.headers().rsc === "1"
    )
      canonicalRequests.push(request.url());
  });
  await page.getByRole("button", { name: "New session" }).click();
  await page
    .getByLabel("Prompt", { exact: true })
    .fill("Respect workspace switcher navigation intent");
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page.locator("[data-session-creation]")).toBeVisible();
  await page.getByRole("button", { name: "Switch workspace: Acme Corp", exact: true }).click();
  const currentWorkspace = page.getByRole("menuitem", {
    name: "Acme Corp Current workspace",
    exact: true,
  });
  const boardHref = await currentWorkspace.getAttribute("href");
  if (!boardHref) throw new Error("Missing the active workspace's Board link.");
  await currentWorkspace.click();
  createGate.release();
  await expect(page.getByText("Session #1 created.", { exact: true })).toBeVisible();
  expect(canonicalRequests).toHaveLength(0);
  navigationGate.release();
  await expect(page).toHaveURL(boardHref);
  await expect(
    page.getByRole("navigation", { name: "Sessions views" }).locator('[aria-current="page"]'),
  ).toHaveText("Board");
});

test("returning to the workspace cancels a confirmed session's pending route handoff", async ({
  page,
}) => {
  const navigationGate = deferred();
  const navigationStarted = deferred();
  const navigationReleased = deferred();
  await page.route("**/api/sessions", (route) =>
    route.fulfill({
      status: 201,
      json: { canonicalUrl: `${workspacePath}/sessions/1`, number: 1 },
    }),
  );
  await page.route(`**${workspacePath}/sessions/1?*`, async (route) => {
    if (route.request().headers().rsc === "1") {
      navigationStarted.release();
      await navigationGate.promise;
    }
    try {
      await route.continue();
    } finally {
      navigationReleased.release();
    }
  });
  await page.getByRole("button", { name: "New session" }).click();
  await page
    .getByLabel("Prompt", { exact: true })
    .fill("Allow returning to the workspace during handoff");
  await page.getByRole("button", { name: "Start session" }).click();
  await navigationStarted.promise;
  await page.getByRole("button", { name: /Back to workspace/ }).click();
  await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeFocused();
  navigationGate.release();
  await navigationReleased.promise;
  await page.waitForLoadState("networkidle");
  await expect(page).toHaveURL(`${workspacePath}/sessions`);
  await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
});

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
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("link", { name: "Insights", exact: true })
    .click();
  await expect(page).toHaveURL((url) => url.pathname === `${workspacePath}/analytics`);
  const insights = page.url();
  createGate.release();
  await expect(page.getByText("Session #1 created.", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(insights);
  await page.getByRole("button", { name: "Open session", exact: true }).click();
  await expect(page).toHaveURL(`${workspacePath}/sessions/1`);
});

async function mockRepositoryOptions(page: Page, factoryDefinitionDigest?: string) {
  await page.route(
    (url) => url.pathname.endsWith("/session-repositories"),
    (route) => {
      const factoryId = new URL(route.request().url()).searchParams.get("factoryId");
      expect(factoryId).toBeTruthy();
      return route.fulfill({
        json: {
          defaultGithubRepositoryId: "repo-fixture",
          factoryDefinitionDigest,
          factoryId,
          linearIssueLinking: true,
          repositoryOptions: [{ id: "repo-fixture", fullName: "acme/wallie" }],
          pipelineId: "pipeline-fixture",
          stageOptions: [
            { id: "plan-fixture", name: "Plan", position: 0, description: "Plan the work" },
            { id: "build-fixture", name: "Build", position: 1, description: "Implement the plan" },
          ],
        },
      });
    },
  );
}

async function authorizedSessionFactoryId(page: Page) {
  const board = page.getByRole("navigation", { name: "Sessions views" }).getByRole("link", {
    name: "Board",
  });
  const boardHref = await board.getAttribute("href");
  const factoryId = boardHref && new URL(boardHref, page.url()).searchParams.get("factory");
  if (!factoryId) throw new Error("Missing the authorized Board factory.");
  return factoryId;
}

test("a newer workflow launch keeps its publication and return while an earlier request settles", async ({
  page,
}) => {
  const sessions = `${workspacePath}/sessions`;
  const factoryId = await authorizedSessionFactoryId(page);
  const definitionDigest = "d".repeat(64);
  const earlier = {
    workflowId: "00000000-0000-4000-8000-000000000011",
    activationId: "00000000-0000-4000-8000-000000000012",
    label: "Earlier publication",
  };
  const newer = {
    ...earlier,
    activationId: "00000000-0000-4000-8000-000000000013",
    label: "Newer publication",
  };
  const launch = (activationId: string, returnTo: string) =>
    `${sessions}?${new URLSearchParams({ factory: factoryId, create: "1", returnTo, workflowActivation: activationId })}`;
  const origin = (q: string) =>
    `${workspacePath}/workflows?${new URLSearchParams({ factory: factoryId, q })}#workflow-${q}`;
  await mockRepositoryOptions(page, definitionDigest);
  await page.route("**/workflows/intake-options", (route) =>
    route.fulfill({ json: { definitionDigest, options: [earlier, newer] } }),
  );
  const responseGate = deferred();
  const canonicalUrl = `${sessions}/1`;
  await page.route("**/api/sessions", async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      factoryId,
      workflowSelection: { workflowId: earlier.workflowId, activationId: earlier.activationId },
    });
    await responseGate.promise;
    await route.fulfill({ status: 201, json: { canonicalUrl, number: 1 } });
  });

  try {
    await page.goto(launch(earlier.activationId, origin("earlier")));
    const dialog = page.getByRole("dialog", { name: "Start a new session", exact: true });
    await dialog.getByLabel("Prompt", { exact: true }).fill("Prepare the earlier release");
    await dialog.getByRole("button", { name: "Start session", exact: true }).click();
    const preview = page.locator("[data-session-creation]");
    await expect(preview).toBeVisible();
    await expect(page).toHaveURL(`${sessions}?factory=${factoryId}`);

    const newerHref = launch(newer.activationId, origin("newer"));
    await page.evaluate((href) => window.history.pushState(null, "", href), newerHref);
    await expect(dialog.getByText(newer.label, { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeEnabled();
    const submit = dialog.getByRole("button", { name: "Start session", exact: true });
    await expect(submit).toBeDisabled();
    await expect(preview).toBeHidden();
    responseGate.release();
    await expect(submit).toBeEnabled();
    await expect(page.getByText("Session #1 created.", { exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(newerHref);
    await expect(dialog.getByText(newer.label, { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(origin("newer"));
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Session #1 created.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Open session" }).press("Enter");
    await expect(page).toHaveURL(canonicalUrl);
  } finally {
    responseGate.release();
  }
});

test("retry returns to the original launch when only the workflow return address changes", async ({
  page,
}) => {
  const sessions = `${workspacePath}/sessions`;
  const factoryId = await authorizedSessionFactoryId(page);
  const definitionDigest = "d".repeat(64);
  const workflow = {
    workflowId: "00000000-0000-4000-8000-000000000011",
    activationId: "00000000-0000-4000-8000-000000000012",
    label: "Release publication",
  };
  const launch = (search: string) => {
    const returnTo = `${workspacePath}/workflows?${new URLSearchParams({ factory: factoryId, q: search })}#workflow-${search}`;
    return `${sessions}?${new URLSearchParams({ factory: factoryId, create: "1", returnTo, workflowActivation: workflow.activationId })}`;
  };
  const original = launch("release");
  const later = launch("later");
  await mockRepositoryOptions(page, definitionDigest);
  await page.route("**/workflows/intake-options", (route) =>
    route.fulfill({ json: { definitionDigest, options: [workflow] } }),
  );
  const lostResponse = deferred();
  const requests: unknown[] = [];
  const canonicalUrl = `${sessions}/1`;
  await page.route("**/api/sessions", async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) {
      await lostResponse.promise;
      await route.abort();
      return;
    }
    await route.fulfill({ status: 201, json: { canonicalUrl, number: 1 } });
  });

  try {
    await page.goto(original);
    const dialog = page.getByRole("dialog", { name: "Start a new session", exact: true });
    await dialog.getByLabel("Prompt", { exact: true }).fill("Prepare the release");
    await dialog.getByRole("button", { name: "Start session", exact: true }).click();
    await expect(page).toHaveURL(`${sessions}?factory=${factoryId}`);
    await page.getByRole("button", { name: /Back to workspace/ }).click();
    lostResponse.release();
    await expect(page.getByRole("button", { name: "Open draft", exact: true })).toBeVisible();

    await page.evaluate((href) => window.history.pushState(null, "", href), later);
    await expect(page).toHaveURL(later);
    const retry = dialog.getByRole("button", { name: "Retry creation", exact: true });
    await expect(retry).toBeDisabled();
    expect(requests).toHaveLength(1);
    const recovery = dialog.getByRole("button", { name: "Open original draft", exact: true });
    await expect(recovery).toBeInViewport();
    await expect(dialog.getByText(/Retry to check the original request/)).toHaveCount(0);
    await expect(dialog.getByRole("textbox", { name: "Linear issue URL" })).toBeVisible();
    await expect(dialog.locator('[aria-describedby~="create-session-error"]')).toHaveCount(0);
    await recovery.press("Enter");
    await expect(page).toHaveURL(original);
    await expect(dialog.getByText(workflow.label, { exact: true })).toBeVisible();
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect(page).toHaveURL(canonicalUrl);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ factoryId, requestId: expect.any(String) });
    expect(requests[1]).toEqual(requests[0]);
  } finally {
    lostResponse.release();
  }
});

test.beforeEach(async ({ page }) => {
  await mockRepositoryOptions(page);
  await signIn(page);
});

for (const mobile of [false, true]) {
  test(`creation previews work before the response and restores a rejected draft (${mobile ? "mobile" : "desktop"})`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const factoryId = await authorizedSessionFactoryId(page);
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
    expect(requests).toEqual([expect.objectContaining({ factoryId })]);
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
  const factoryId = await authorizedSessionFactoryId(page);
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
  expect(requests[0]).toMatchObject({ factoryId, requestId: expect.any(String) });
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
