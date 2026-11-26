import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test, type Browser, type Locator, type Page, type Route } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod/v4";

import {
  connectorDeliveryPageSchema,
  type ConnectorDeliveryPage,
  type ConnectorRetryCommand,
} from "../src/lib/connectors/diagnostics-contracts";
import type { Database } from "../src/lib/supabase/database.types";
import { signInViaMagicLink } from "./helpers/auth";

const fixtureSchema = z.object({
  workspaceId: z.uuid(),
  workspaceSlug: z.string().regex(/^op651-\d{8}$/u),
  factoryId: z.uuid(),
  siblingFactoryId: z.uuid(),
  githubResourceId: z.uuid(),
  githubRetryId: z.uuid(),
  githubFailedId: z.uuid(),
  linearResourceId: z.uuid(),
  linearEmptyResourceId: z.uuid(),
  linearStateId: z.uuid(),
  linearRetryId: z.uuid(),
  ownerUserId: z.uuid(),
  ownerEmail: z.email(),
  managerEmail: z.email(),
  viewerEmail: z.email(),
  managerMemberId: z.uuid(),
});
const variants = [
  { name: "desktop-light", theme: "light", viewport: { width: 1440, height: 900 } },
  { name: "desktop-dark", theme: "dark", viewport: { width: 1440, height: 900 } },
  { name: "mobile-light", theme: "light", viewport: { width: 390, height: 844 } },
  { name: "mobile-dark", theme: "dark", viewport: { width: 390, height: 844 } },
] as const;
const proofDirectory = resolve(".symphony", "screenshots");
const privateFixtureText = "OP680_PRIVATE_";

type Variant = (typeof variants)[number];
type Provider = "GitHub" | "Linear";

function requireLoopback(value: string | undefined) {
  if (!value)
    throw new Error("Connector Settings proof requires explicit isolated app and Supabase URLs.");
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Connector Settings proof must use an isolated loopback server.");
  }
  return url.origin;
}

async function openSettings(
  browser: Browser,
  destinations: { app: string; supabase: string; settings: string; linearStateId: string },
  email: string,
  variant: Variant,
) {
  const context = await browser.newContext({
    viewport: variant.viewport,
    colorScheme: variant.theme,
    reducedMotion: "reduce",
    serviceWorkers: "block",
    timezoneId: "UTC",
    locale: "en-US",
  });
  await context.route("**/*", (route) => {
    const origin = new URL(route.request().url()).origin;
    return origin === destinations.app || origin === destinations.supabase
      ? route.continue()
      : route.abort();
  });
  await context.route(/\/connectors\/catalog\?/u, (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== destinations.app) return route.abort();
    const provider = url.searchParams.get("provider");
    const kind = url.searchParams.get("kind");
    return route.fulfill({
      json: {
        provider,
        kind,
        tenant: { id: "fixture-tenant", label: "Fixture organization" },
        resources:
          provider === "linear" && kind === "state"
            ? [
                {
                  id: destinations.linearStateId,
                  label: "In progress",
                  description: "Platform · started",
                },
              ]
            : [],
        nextCursor: null,
      },
    });
  });
  const page = await context.newPage();
  await page.addInitScript(
    (theme) => window.localStorage.setItem("wallie-theme", theme),
    variant.theme,
  );
  await signInViaMagicLink(page, destinations.settings, { baseURL: destinations.app, email });
  await expect(page.locator("html")).toHaveAttribute("data-theme", variant.theme);
  return { context, page, panel: page.locator("#connector-resources") };
}

async function selectProviderResource(panel: Locator, provider: Provider, resourceId: string) {
  const providerPicker = panel.getByRole("combobox", { name: "Provider", exact: true });
  await providerPicker.click();
  await panel
    .page()
    .getByRole("listbox")
    .getByRole("option", { name: provider, exact: true })
    .click();
  const resourcePicker = panel.getByRole("combobox", { name: "Provider resource", exact: true });
  await resourcePicker.click();
  await panel
    .page()
    .getByRole("listbox", { name: "Provider resource", exact: true })
    .locator(`[role="option"][data-value="${resourceId}"]`)
    .click();
  await expect(resourcePicker).toHaveAttribute("data-value", resourceId);
}

async function screenshot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("body")).not.toContainText(privateFixtureText);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  await page.locator("#connector-resources").screenshot({
    path: resolve(proofDirectory, `op680-${name}.png`),
    animations: "disabled",
    caret: "hide",
    style: "[data-shell-header], [data-shell-rail], .ui-skip-link { visibility: hidden; }",
  });
}

async function retryFromPanel(
  page: Page,
  panel: Locator,
  endpoint: string,
  expected: ConnectorRetryCommand,
) {
  const response = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === endpoint && candidate.request().method() === "POST",
  );
  const action = expected.mode === "observe" ? "Check provider status" : "Schedule retry";
  await panel.getByRole("button", { name: action, exact: true }).click();
  const result = await response;
  expect(result.request().postDataJSON()).toEqual(expected);
  expect(result.ok()).toBe(true);
  expect(await result.text()).not.toContain(privateFixtureText);
}

async function provePaginationRecovers(page: Page, panel: Locator, endpoint: string) {
  const matches = (url: URL) =>
    url.pathname === endpoint && url.searchParams.get("lane") === "ingress";
  const failure = "Delivery page unavailable.";
  let pageAttempts = 0;
  let releaseRetry: () => void = () => {};
  const heldRetry = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  async function handlePage(route: Route) {
    const url = new URL(route.request().url());
    if (!url.searchParams.has("cursor")) {
      url.searchParams.set("limit", "3");
      return route.continue({ url: url.toString() });
    }
    if (pageAttempts++ === 0) return route.fulfill({ status: 503, json: { error: failure } });
    await heldRetry;
    return route.continue();
  }

  await page.route(matches, handlePage);
  const history = panel.getByRole("region", { name: "Delivery history", exact: true });
  const loadOlder = history.getByRole("button", { name: "Load older deliveries", exact: true });
  try {
    await history.getByRole("button", { name: "Refresh history", exact: true }).click();
    await expect(history.getByRole("listitem")).toHaveCount(3);
    await loadOlder.click();
    await expect(history.getByRole("alert").filter({ hasText: failure })).toBeVisible();
    await loadOlder.click();
    await expect(history.getByRole("button", { name: "Loading…", exact: true })).toBeDisabled();
    await expect(history.getByText(failure, { exact: true })).toHaveCount(0);
    releaseRetry();
    await expect(history.getByRole("listitem")).toHaveCount(4);
    await expect(loadOlder).toHaveCount(0);
  } finally {
    releaseRetry();
    await page.unroute(matches, handlePage);
  }
}

async function proveStaleModeRefreshes(
  page: Page,
  panel: Locator,
  historyEndpoint: string,
  expected: Extract<ConnectorRetryCommand, { kind: "outbound" }>,
) {
  const retryEndpoint = `${historyEndpoint}/retry`;
  await page.route(
    `**${retryEndpoint}`,
    (route) => route.continue({ postData: JSON.stringify({ ...expected, mode: "retry" }) }),
    { times: 1 },
  );
  const refreshed = page.waitForResponse(
    (result) =>
      new URL(result.url()).pathname === historyEndpoint && result.request().method() === "GET",
  );
  const response = page.waitForResponse(
    (result) =>
      new URL(result.url()).pathname === retryEndpoint && result.request().method() === "POST",
  );
  await panel.getByRole("button", { name: "Check provider status", exact: true }).click();
  expect((await response).status()).toBe(409);
  expect((await refreshed).ok()).toBe(true);
  await expect(
    panel.getByRole("alert").filter({ hasText: "This delivery changed." }),
  ).toBeVisible();
  await expect(panel.getByText("Provider status check scheduled.")).toHaveCount(0);
}

async function expectFocusRestored(page: Page, button: Locator, title: string) {
  await button.press("Enter");
  const dialog = page.getByRole("alertdialog", { name: title, exact: true });
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(button).toBeFocused();
}

function expectAdvancedRetryTime(previous: string | null, current: string | null) {
  expect(previous).not.toBeNull();
  expect(current).not.toBeNull();
  expect(Date.parse(previous ?? "") - Date.parse(current ?? "")).toBeGreaterThan(45 * 60 * 1000);
}

async function readHistory(page: Page, endpoint: string) {
  const response = await page.request.get(endpoint);
  expect(response.ok()).toBe(true);
  const body = await response.text();
  expect(body).not.toContain(privateFixtureText);
  return connectorDeliveryPageSchema.parse(JSON.parse(body));
}

function findDelivery(history: ConnectorDeliveryPage, id: string) {
  const delivery = history.deliveries.find((row) => row.id === id);
  if (!delivery) throw new Error("The retained delivery was missing from its scoped history.");
  return delivery;
}

test.use({ actionTimeout: 10_000 });

test("qualified operators can inspect and retry exact connector receipts from Settings", async ({
  browser,
  baseURL,
}) => {
  const fixturePath = process.env.WALLIE_OP680_FIXTURE_PATH;
  test.skip(!fixturePath, "Requires a disposable OP-680 connector Settings fixture.");
  test.setTimeout(180_000);
  const app = requireLoopback(baseURL);
  const supabase = requireLoopback(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  if (!fixturePath || !serviceKey)
    throw new Error("Provide the isolated fixture and local service-role key.");
  if (
    process.env.WALLIE_WORKER_WAKE_URL ||
    process.env.GITHUB_APP_PRIVATE_KEY ||
    process.env.OPENROUTER_API_KEY
  ) {
    throw new Error(
      "Connector Settings browser proof requires external provider transport to remain disabled.",
    );
  }
  const fixture = fixtureSchema.parse(JSON.parse(await readFile(fixturePath, "utf8")));
  const path = `/w/${fixture.workspaceSlug}/settings?category=integrations&factory=${fixture.factoryId}`;
  const destinations = {
    app,
    supabase,
    settings: `${path}#connector-resources`,
    linearStateId: fixture.linearStateId,
  };
  const factoryApi = `/api/workspaces/${fixture.workspaceId}/factories`;
  const connectors = `${factoryApi}/${fixture.factoryId}/connectors`;
  const githubHistory = `${connectors}/${fixture.githubResourceId}/deliveries`;
  const linearHistory = `${connectors}/${fixture.linearResourceId}/deliveries`;
  const githubRetry = {
    kind: "github_comment",
    id: fixture.githubRetryId,
    mode: "retry",
  } satisfies ConnectorRetryCommand;
  const linearRetry = {
    kind: "outbound",
    id: fixture.linearRetryId,
    mode: "observe",
  } satisfies ConnectorRetryCommand;
  await mkdir(proofDirectory, { recursive: true });

  for (const variant of variants) {
    const { context, page, panel } = await openSettings(
      browser,
      destinations,
      fixture.ownerEmail,
      variant,
    );
    try {
      await expect(
        panel.getByRole("heading", { name: "Connector resources", exact: true }),
      ).toBeVisible();
      await expect(panel.getByRole("combobox", { name: "Factory", exact: true })).toHaveAttribute(
        "data-value",
        fixture.factoryId,
      );
      await expect(
        panel.getByRole("heading", { name: "Connector setup", exact: true }),
      ).toBeVisible();
      await expect(page.locator("#github")).toBeVisible();
      await expect(page.locator("#linear")).toBeVisible();
      await selectProviderResource(panel, "GitHub", fixture.githubResourceId);
      await expect(
        panel.getByRole("heading", { name: "Delivery history", exact: true }),
      ).toBeVisible();
      await expect(
        panel.getByRole("button", { name: "Schedule retry", exact: true }),
      ).toBeVisible();
      await expect(panel.getByText("Pending", { exact: true })).toBeVisible();
      await expect(panel.getByText("Failed", { exact: true }).first()).toBeVisible();
      await expect(panel.getByText("Rejected", { exact: true })).toBeVisible();
      await screenshot(page, `github-${variant.name}`);

      await selectProviderResource(panel, "Linear", fixture.linearResourceId);
      await expect(panel.getByText("Outcome unknown", { exact: true })).toBeVisible();
      await expect(panel.getByText(/Last scan failed/u)).toBeVisible();
      await expect(panel.getByText(/Wallie could not reach or read from Linear/u)).toBeVisible();
      await expect(
        panel.getByRole("button", { name: "Check provider status", exact: true }),
      ).toBeVisible();
      await screenshot(page, `linear-${variant.name}`);

      if (variant.name === "desktop-light") {
        await panel.getByText("Linear routing and outcomes", { exact: true }).click();
        await expect(
          panel.getByRole("checkbox", { name: "Discover issues on this resource" }),
        ).toBeChecked();
        const selectedStates = panel.getByRole("button", {
          name: "Workflow states 1 selected",
          exact: true,
        });
        await selectedStates.press("Enter");
        await expect(
          panel.getByRole("checkbox", { name: "In progress (Platform · started)" }),
        ).toBeChecked();
        await expect(
          panel.getByRole("checkbox", { name: "Post updates to linked issues" }),
        ).toBeChecked();
        await expect(
          panel.getByRole("checkbox", { name: "Change issue status after final approval" }),
        ).not.toBeChecked();
        await screenshot(page, "linear-policies-desktop-light");
      }
      if (variant.name === "mobile-dark") {
        await selectProviderResource(panel, "Linear", fixture.linearEmptyResourceId);
        await expect(
          panel.getByText("No deliveries for this resource.", { exact: true }),
        ).toBeVisible();
        await expect(
          panel.getByRole("button", { name: "Schedule retry", exact: true }),
        ).toHaveCount(0);
        await screenshot(page, "empty-mobile-dark");
        await panel.getByText("Linear routing and outcomes", { exact: true }).click();
        await expect(
          panel.getByRole("checkbox", { name: "Discover issues on this resource" }),
        ).not.toBeChecked();
        const stateChoices = panel.getByRole("button", {
          name: "Workflow states Choose workflow states",
          exact: true,
        });
        await stateChoices.press("Enter");
        await expect(
          panel.getByRole("checkbox", { name: "In progress (Platform · started)" }),
        ).not.toBeChecked();
        await expect(
          panel.getByRole("checkbox", { name: "Post updates to linked issues" }),
        ).not.toBeChecked();
        await expect(
          panel.getByRole("checkbox", { name: "Change issue status after final approval" }),
        ).not.toBeChecked();
      }
    } finally {
      await context.close();
    }
  }

  const owner = await openSettings(browser, destinations, fixture.ownerEmail, variants[0]);
  try {
    await selectProviderResource(owner.panel, "GitHub", fixture.githubResourceId);
    await expectFocusRestored(
      owner.page,
      owner.panel.getByRole("button", { name: "Disable mapping", exact: true }),
      "Disable this resource mapping?",
    );
    await expectFocusRestored(
      owner.page,
      owner.panel.getByRole("button", { name: "Disconnect connector", exact: true }),
      "Disconnect this connector?",
    );
    const wrongScope = await owner.page.request.post(
      `${factoryApi}/${fixture.siblingFactoryId}/connectors/${fixture.githubResourceId}/deliveries/retry`,
      { data: githubRetry },
    );
    expect(wrongScope.status()).toBe(404);
    const factory = owner.panel.getByRole("combobox", { name: "Factory", exact: true });
    await factory.click();
    await owner.page.getByRole("option", { name: "Audit-only factory", exact: true }).click();
    await expect(factory).toHaveAttribute("data-value", fixture.siblingFactoryId);
    const siblingInventory = await owner.page.request.get(
      `${factoryApi}/${fixture.siblingFactoryId}/connectors`,
    );
    expect(siblingInventory.ok()).toBe(true);
    expect(await siblingInventory.text()).not.toContain(fixture.githubResourceId);
  } finally {
    await owner.context.close();
  }

  const viewer = await openSettings(browser, destinations, fixture.viewerEmail, variants[0]);
  try {
    await expect(
      viewer.panel.getByRole("heading", { name: "Connector resources", exact: true }),
    ).toBeVisible();
    const unauthorized = await viewer.page.request.post(`${githubHistory}/retry`, {
      data: githubRetry,
    });
    expect([403, 404]).toContain(unauthorized.status());
    await expect(
      viewer.panel.getByText("Factory managers and workspace admins can view connector resources."),
    ).toBeVisible();
    await expect(
      viewer.panel.getByRole("button", { name: "Schedule retry", exact: true }),
    ).toHaveCount(0);
    await screenshot(viewer.page, "viewer-desktop-light");
  } finally {
    await viewer.context.close();
  }

  const manager = await openSettings(browser, destinations, fixture.managerEmail, variants[3]);
  try {
    await expect(
      manager.panel.getByText("Workspace admins can change connector setup."),
    ).toBeVisible();
    await expect(
      manager.panel.getByRole("heading", { name: "Connector setup", exact: true }),
    ).toHaveCount(0);
    const githubBefore = await readHistory(manager.page, githubHistory);
    const pendingComment = findDelivery(githubBefore, fixture.githubRetryId);
    expect(pendingComment).toMatchObject({ status: "pending", canRetry: true });
    expect(findDelivery(githubBefore, fixture.githubFailedId)).toMatchObject({
      status: "failed",
      canRetry: false,
    });
    const linearBefore = findDelivery(
      await readHistory(manager.page, linearHistory),
      fixture.linearRetryId,
    );
    expect(linearBefore).toMatchObject({ status: "unknown", uncertain: true, canRetry: true });

    await selectProviderResource(manager.panel, "GitHub", fixture.githubResourceId);
    await manager.panel
      .getByRole("combobox", { name: "Direction", exact: true })
      .selectOption("ingress");
    await expect(manager.panel.getByText("Rejected", { exact: true })).toBeVisible();
    await expect(manager.panel.getByText(/^Outbound delivery/)).toHaveCount(0);
    await provePaginationRecovers(manager.page, manager.panel, githubHistory);
    await retryFromPanel(manager.page, manager.panel, `${githubHistory}/retry`, githubRetry);
    await expect(manager.panel.getByText("Retry scheduled for this delivery.")).toBeVisible();
    const retriedComment = findDelivery(
      await readHistory(manager.page, githubHistory),
      fixture.githubRetryId,
    );
    expectAdvancedRetryTime(pendingComment.nextAttemptAt, retriedComment.nextAttemptAt);
    expect(
      findDelivery(await readHistory(manager.page, linearHistory), fixture.linearRetryId),
    ).toEqual(linearBefore);

    await selectProviderResource(manager.panel, "Linear", fixture.linearResourceId);
    await expect(
      manager.panel.getByText("Linear routing and outcomes", { exact: true }),
    ).toHaveCount(0);
    await manager.panel
      .getByRole("combobox", { name: "Direction", exact: true })
      .selectOption("outbound");
    await proveStaleModeRefreshes(manager.page, manager.panel, linearHistory, linearRetry);
    expect(
      findDelivery(await readHistory(manager.page, linearHistory), fixture.linearRetryId),
    ).toEqual(linearBefore);
    await retryFromPanel(manager.page, manager.panel, `${linearHistory}/retry`, linearRetry);
    await expect(manager.panel.getByText("Provider status check scheduled.")).toBeVisible();
    const observingDelivery = findDelivery(
      await readHistory(manager.page, linearHistory),
      fixture.linearRetryId,
    );
    expect(observingDelivery).toMatchObject({
      status: "unknown",
      uncertain: true,
      attempts: linearBefore.attempts,
    });
    expectAdvancedRetryTime(linearBefore.nextAttemptAt, observingDelivery.nextAttemptAt);
    await screenshot(manager.page, "retry-mobile-dark");

    const admin = createClient<Database>(supabase, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const revoked = await admin.rpc("revoke_factory_membership", {
      p_workspace_id: fixture.workspaceId,
      p_factory_id: fixture.factoryId,
      p_actor_user_id: fixture.ownerUserId,
      p_member_id: fixture.managerMemberId,
      p_reason: "Connector Settings browser proof",
    });
    expect(revoked.error).toBeNull();
    const [revokedRead, revokedRetry] = await Promise.all([
      manager.page.request.get(githubHistory),
      manager.page.request.post(`${linearHistory}/retry`, { data: linearRetry }),
    ]);
    expect([403, 404]).toContain(revokedRead.status());
    expect([403, 404]).toContain(revokedRetry.status());
    await manager.page.reload();
    await expect(
      manager.panel.getByText(
        "Factory managers and workspace admins can view connector resources.",
      ),
    ).toBeVisible();
    await expect(
      manager.panel.getByRole("heading", { name: "Connector resources", exact: true }),
    ).toBeVisible();
    await expect(
      manager.panel.getByRole("button", { name: "Schedule retry", exact: true }),
    ).toHaveCount(0);
    await screenshot(manager.page, "revoked-mobile-dark");
  } finally {
    await manager.context.close();
  }

  const ruleOwner = await openSettings(browser, destinations, fixture.ownerEmail, variants[0]);
  try {
    await selectProviderResource(ruleOwner.panel, "GitHub", fixture.githubResourceId);
    const source = ruleOwner.panel.getByRole("combobox", { name: "Request source", exact: true });
    const disableIssue = ruleOwner.panel.getByRole("button", { name: "Disable issue intake" });
    await expect(disableIssue).toBeVisible();
    await source.selectOption("pull_request");
    const disablePullRequest = ruleOwner.panel.getByRole("button", {
      name: "Disable pull request intake",
      exact: true,
    });
    await expectFocusRestored(ruleOwner.page, disablePullRequest, "Disable pull request intake?");
    await disablePullRequest.press("Enter");
    const disabled = ruleOwner.page.waitForResponse(
      (result) =>
        new URL(result.url()).pathname === `${connectors}/setup` &&
        result.request().method() === "POST",
    );
    await ruleOwner.page
      .getByRole("alertdialog", { name: "Disable pull request intake?", exact: true })
      .getByRole("button", { name: "Disable pull request intake", exact: true })
      .click();
    const result = await disabled;
    expect(result.ok()).toBe(true);
    expect(result.request().postDataJSON()).toEqual({
      action: "disable_github_request",
      resourceId: fixture.githubResourceId,
      sourceKind: "pull_request",
      expectedRevision: 1,
    });
    await expect(
      ruleOwner.panel.getByText("Intake is disabled for this request source."),
    ).toBeVisible();
    await expect(source).toBeEnabled();
    await expect(disablePullRequest).toHaveCount(0);
    await screenshot(ruleOwner.page, "github-pull-request-intake-disabled");
    await source.selectOption("issue");
    await expect(disableIssue).toBeVisible();
    await expect(ruleOwner.panel.getByText("Connected", { exact: true })).toBeVisible();
    await expect(ruleOwner.panel.getByText("Pending", { exact: true })).toBeVisible();
  } finally {
    await ruleOwner.context.close();
  }
});
