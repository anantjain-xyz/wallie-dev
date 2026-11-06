import { readFileSync, readdirSync } from "node:fs";

import { expect, test, type Browser, type Page } from "@playwright/test";

import { signIn } from "./helpers/auth";

const sessionsPath = "/w/acme-corp/sessions";
const sessionPath = `${sessionsPath}/1001`;
const sessionTitle = "[bench] Checkout latency";
const sourcePrefixes = [
  "realtime:session-detail:",
  "realtime:wallie-runs:",
  "realtime:approval-review:",
];

async function holdSdk(browser: Browser, authPage: Page) {
  await signIn(authPage);
  const context = await browser.newContext({
    baseURL: new URL(authPage.url()).origin,
    storageState: await authPage.context().storageState(),
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const sdkChunks = new Set(
    readdirSync(".next/static/chunks").filter(
      (file) =>
        file.endsWith(".js") &&
        readFileSync(`.next/static/chunks/${file}`, "utf8").includes("GoTrueClient"),
    ),
  );
  expect(sdkChunks.size).toBeGreaterThan(0);
  let releaseSdk!: () => void;
  const sdkGate = new Promise<void>((resolve) => {
    releaseSdk = resolve;
  });
  let requested = false;
  await page.route("**/_next/static/chunks/*.js", async (route) => {
    if (sdkChunks.has(new URL(route.request().url()).pathname.split("/").at(-1)!)) {
      requested = true;
      await sdkGate;
    }
    await route.continue();
  });

  const joins: Array<{ topic: string; authenticated: boolean }> = [];
  const subscribed = new Set<string>();
  const leaves = new Set<string>();
  page.on("websocket", (socket) => {
    if (!socket.url().includes("/realtime/v1/websocket")) return;
    socket.on("framesent", ({ payload }) => {
      const [, , topic, event, data] = JSON.parse(payload.toString());
      if (event === "phx_join") joins.push({ topic, authenticated: Boolean(data.access_token) });
      if (event === "phx_leave") leaves.add(topic);
    });
    socket.on("framereceived", ({ payload }) => {
      const [, , topic, event, data] = JSON.parse(payload.toString());
      if (event === "system" && data.status === "ok") subscribed.add(topic);
    });
  });
  const waitForSubscriptions = async () => {
    for (const prefix of sourcePrefixes) {
      await expect.poll(() => [...subscribed].some((topic) => topic.startsWith(prefix))).toBe(true);
      const matching = joins.filter(({ topic }) => topic.startsWith(prefix));
      expect(matching).toHaveLength(1);
      expect(matching[0].authenticated).toBe(true);
    }
  };

  return {
    page,
    errors,
    joins,
    leaves,
    releaseSdk,
    requested: () => requested,
    waitForSubscriptions,
    close: async () => {
      releaseSdk();
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await context.close();
    },
  };
}

async function expectArtifact(page: Page) {
  await expect(page.getByRole("heading", { name: sessionTitle, exact: true })).toBeVisible();
  const artifact = page.locator("#artifact-rendered-panel:visible");
  await expect(artifact.locator(".artifact-content:visible")).toContainText(
    "The checkout path waits on inventory, tax, and shipping before it can show a total.",
  );
  await expect(artifact).toContainText(/v1\s*·\s*Latest/);
}

async function expectReviewReady(page: Page) {
  await expectArtifact(page);
  await expect(page.getByRole("button", { name: "Approve stage", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Request changes", exact: true })).toBeEnabled();
}

test("review and activity work while the SDK loads, then authenticated recovery joins", async ({
  browser,
  page: authPage,
}) => {
  const fixture = await holdSdk(browser, authPage);
  const { page } = fixture;
  let releaseApproval!: () => void;
  const approvalGate = new Promise<void>((resolve) => {
    releaseApproval = resolve;
  });
  let approvalRequested = false;
  await page.route("**/api/sessions/*/approval-review", async (route) => {
    const response = await route.fetch();
    approvalRequested = true;
    await approvalGate;
    await route.fulfill({ response });
  });
  try {
    await page.goto(sessionsPath);
    await page.getByRole("link", { name: `Open session #1001: ${sessionTitle}` }).click();
    await expectArtifact(page);
    await expect.poll(fixture.requested).toBe(true);
    await expect.poll(() => approvalRequested).toBe(true);
    await expect(page.getByRole("button", { name: "Approve stage", exact: true })).toBeDisabled();
    const approval = page.waitForResponse((response) =>
      /\/api\/sessions\/[^/]+\/approval-review$/.test(new URL(response.url()).pathname),
    );
    releaseApproval();
    const approvalResponse = await approval;
    expect(approvalResponse.ok()).toBe(true);
    expect(await approvalResponse.json()).toEqual({
      reviewRevision: expect.any(Number),
      blockingCount: 0,
    });
    await expectReviewReady(page);
    expect(fixture.joins).toHaveLength(0);

    const activity = page.getByRole("region", { name: "Session runs", exact: true });
    const disclosure = activity.getByRole("button", { name: /run activity: Completed/ }).first();
    await expect(disclosure).toBeVisible();
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");

    const review = page.waitForResponse((response) => /\/reviews\?/.test(response.url()));
    await page.getByRole("button", { name: "Request changes", exact: true }).click();
    expect((await review).ok()).toBe(true);
    const dialog = page.getByRole("dialog", { name: "Request changes", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

    const snapshot = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/rest/v1/rpc/get_session_detail_page"),
    );
    const capabilities = page.waitForResponse((response) =>
      /\/api\/sessions\/[^/]+\/review-capabilities$/.test(new URL(response.url()).pathname),
    );
    fixture.releaseSdk();
    const [snapshotResponse, capabilitiesResponse] = await Promise.all([
      snapshot,
      capabilities,
      fixture.waitForSubscriptions(),
    ]);
    expect(snapshotResponse.ok()).toBe(true);
    expect(capabilitiesResponse.ok()).toBe(true);
    await expectReviewReady(page);

    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    for (const prefix of sourcePrefixes) {
      await expect
        .poll(() => [...fixture.leaves].some((topic) => topic.startsWith(prefix)))
        .toBe(true);
    }
    expect(fixture.errors).toEqual([]);
  } finally {
    releaseApproval();
    await fixture.close();
  }
});

test("leaving before SDK completion does not retain the previous session subscription", async ({
  browser,
  page: authPage,
}) => {
  const fixture = await holdSdk(browser, authPage);
  const { page } = fixture;
  try {
    await page.goto(sessionPath, { waitUntil: "commit" });
    await expectReviewReady(page);
    await expect.poll(fixture.requested).toBe(true);
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    fixture.releaseSdk();

    await page.getByRole("link", { name: "Sessions", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
    await page.getByRole("link", { name: `Open session #1001: ${sessionTitle}` }).click();
    await expectReviewReady(page);
    await fixture.waitForSubscriptions();
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});
