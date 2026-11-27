import { expect, test } from "@playwright/test";

import type { FactorySettingsSnapshot } from "../src/lib/factory-definitions/settings-contracts";

const defaultFactoryId = "22222222-2222-4222-8222-222222222222";
const selectedFactoryId = "33333333-3333-4333-8333-333333333333";
const draftId = "55555555-5555-4555-8555-555555555555";
const pipelineId = "66666666-6666-4666-8666-666666666666";
const snapshot = {
  activationNumber: 1,
  draft: { id: draftId, digest: "a".repeat(64) },
  published: { id: "77777777-7777-4777-8777-777777777777", digest: "b".repeat(64) },
  publishedStages: [],
  repositoryId: "88888888-8888-4888-8888-888888888888",
  pipeline: {
    id: pipelineId,
    isDefault: true,
    name: "Product pipeline",
    operatingRulesMd: "",
    stages: [],
    archivedStages: [],
  },
  agent: {
    provider: "codex",
    model: "gpt-5.5",
    effort: null,
    concurrencyLimit: 1,
    stallTimeoutMs: 900_000,
    maxRetries: 3,
    maxTurns: 5,
  },
  sandboxProvider: "vercel",
  executionPolicy: null,
  deliveryPolicy: null,
} satisfies FactorySettingsSnapshot;

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") return route.abort();
    if (path.endsWith("/factory-definition/settings")) return route.fulfill({ json: { snapshot } });
    if (path.endsWith("/connectors"))
      return route.fulfill({ json: { installations: [], resources: [], canConfigure: true } });
    if (path.endsWith("/candidate-tests")) {
      return route.fulfill({
        json: {
          tests: [],
          eligibility: {
            activationNumber: 1,
            eligible: false,
            reason: "Test the exact draft before publishing.",
            testId: null,
            canTest: true,
          },
        },
      });
    }
    return route.fulfill({ status: 404, json: {} });
  });
});

test("legacy URLs keep their scope and mobile jump links focus the destination", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `/dev/settings?category=workspace&factory=${selectedFactoryId}&github=failed#coding-agent`,
  );

  await expect(page).toHaveURL(
    (url) =>
      url.hash === "#runtime" &&
      url.searchParams.get("category") === "integrations" &&
      url.searchParams.get("factory") === selectedFactoryId &&
      url.searchParams.get("github") === "failed",
  );
  await expect(page.getByRole("heading", { name: "Agent runtime" })).toBeFocused();
  await expect(page.locator("#github").getByRole("alert")).toContainText(
    "GitHub installation failed.",
  );

  const jump = page.getByRole("button", { name: "Jump to a section" });
  const link = page.getByRole("link", { name: "Factory connectors" });
  await expect(link).toBeHidden();
  await jump.press("Enter");
  await expect(jump).toHaveAttribute("aria-expanded", "true");
  await link.press("Enter");
  await expect(page.getByRole("heading", { name: "Connector resources" })).toBeFocused();
  await expect(page).toHaveURL(
    (url) =>
      url.hash === "#connector-resources" && url.searchParams.get("factory") === selectedFactoryId,
  );
  await expect(jump).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("combobox", { name: "Factory", exact: true })).toBeFocused();
});

test("both the canonical secrets destination and legacy alias focus Workspace secrets", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const target of ["#workspace-secrets", "?category=workspace#secrets"]) {
    await page.goto(`/dev/settings${target}`);
    await expect(page).toHaveURL((url) => url.hash === "#workspace-secrets");
    await expect(
      page.getByRole("heading", { name: "Workspace secrets", exact: true }),
    ).toBeFocused();
  }
});

test("changing connector selection never retargets or drops the default factory edit", async ({
  page,
}) => {
  await page.goto(`/dev/settings?factory=${selectedFactoryId}#connector-resources`);
  const connectors = page.locator("#connector-resources");
  const factory = page.locator("#factory-configuration");
  await expect(connectors).toContainText("Selected factory: Support factory");
  await expect(factory).toContainText("Product factory is the workspace default.");
  await expect(factory.getByRole("button", { name: "Publish draft" })).toBeDisabled();

  const model = page.locator("#runtime").getByRole("textbox", { name: "Model" });
  await model.fill("gpt-unsaved");
  await expect(factory).toContainText("Save or discard your edits before publishing.");
  await expect(page.locator("#provider-access")).toHaveCount(0);
  const providerAccess = page.locator("#runtime").getByRole("link", { name: "Provider access" });
  await expect(providerAccess).toHaveAttribute(
    "href",
    "/w/northwind/settings?category=personal&provider=codex#provider-access",
  );
  await providerAccess.click();
  await expect(
    page.getByText("Save or discard your runtime edits before opening provider access."),
  ).toBeVisible();

  await connectors.getByRole("combobox", { name: "Factory", exact: true }).click();
  await page.getByRole("option", { name: "Product factory", exact: true }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get("factory") === defaultFactoryId);
  await expect(connectors).toContainText("Selected factory: Product factory");
  await expect(model).toHaveValue("gpt-unsaved");
  await expect(factory.getByRole("link", { name: "Review configuration tests" })).toHaveAttribute(
    "href",
    "/w/northwind/settings/factory-definition#candidate-tests",
  );
});

test("delivery blockers stay visible when technical details are closed", async ({ page }) => {
  const resourceId = "99999999-9999-4999-8999-999999999999";
  await page.route(`**/factories/${selectedFactoryId}/connectors`, (route) =>
    route.fulfill({
      json: {
        canConfigure: false,
        installations: [],
        resources: [
          {
            id: resourceId,
            installationId: defaultFactoryId,
            provider: "github",
            kind: "repository",
            externalId: "1001",
            label: "northwind/web",
            mappingRevision: 1,
            enabled: true,
            connectionStatus: "credential_unavailable",
            githubRequests: [],
          },
        ],
      },
    }),
  );
  await page.route(
    (url) =>
      url.pathname.endsWith(`/connectors/${resourceId}/deliveries`) &&
      url.searchParams.get("lane") === "all",
    (route) =>
      route.fulfill({
        json: {
          deliveries: [
            {
              id: pipelineId,
              kind: "outbound",
              status: "blocked",
              reason: "credential_unavailable",
              recordedAt: "2026-05-16T18:00:00.000Z",
              nextAttemptAt: null,
              deadlineAt: null,
              attempts: 1,
              observationAttempts: 0,
              uncertain: false,
              canRetry: false,
              sessionId: null,
              sessionNumber: null,
              operation: "reply",
              sourceReference: null,
            },
          ],
          nextCursor: null,
          linearDiscovery: null,
        },
      }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/dev/settings?factory=${selectedFactoryId}#connector-resources`);

  const delivery = page.getByRole("region", { name: "Delivery history" });
  await expect(delivery.getByText("Provider access is unavailable.")).toBeVisible();
  await expect(delivery.getByText("Attempts 1")).toBeHidden();
  await delivery.locator("summary").press("Enter");
  await expect(delivery.getByText("Attempts 1")).toBeVisible();
});

test("the 320px settings fixture separates workspace and personal actions", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  for (const role of ["owner", "admin", "member"] as const) {
    await page.goto(`/dev/settings?category=workspace&role=${role}#members`);
    const team = page.locator("#members");
    await expect(team.getByRole("heading", { name: "Team access" })).toBeFocused();
    const invite = team.getByRole("button", { name: "Invite member" });
    if (role === "member") await expect(invite).toHaveCount(0);
    else {
      await expect(invite).toBeVisible();
      await expect(team).toContainText("jordan@example.test");
      await invite.press("Enter");
      await expect(page.getByRole("dialog", { name: "Invite a workspace member" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(invite).toBeFocused();
    }
    await expect(team.getByRole("button", { name: "Edit profile" })).toHaveCount(0);
    await expect(page.locator("#profile")).toHaveCount(0);
    await expect(page.locator("#connected-clients")).toHaveCount(0);
    await expect(
      page.locator("#danger-zone").getByRole("button", {
        name: role === "owner" ? "Delete workspace" : "Leave workspace",
        exact: true,
      }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320,
    );

    await page.goto(`/dev/settings?category=workspace&role=${role}#profile`);
    await expect(page).toHaveURL(
      (url) => url.searchParams.get("category") === "personal" && url.hash === "#profile",
    );
    await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeFocused();
    await expect(page.getByRole("button", { name: "Edit profile" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Provider access", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Connected clients" })).toBeVisible();
    await expect(page.locator("#members")).toHaveCount(0);
    await expect(page.locator("#danger-zone")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320,
    );
  }
});
