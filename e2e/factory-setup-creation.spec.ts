import { expect, test, type Page } from "@playwright/test";

import { signInViaMagicLink } from "./helpers/auth";
import { seedFactoryAnalytics } from "./helpers/factory-analytics";

function creationResponse(page: Page, endpoint: string) {
  return page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === endpoint && response.request().method() === "POST",
  );
}

test("factory setup opens on request and keeps exact scope and drafts", async ({
  baseURL,
  browser,
  page,
}) => {
  test.skip(process.env.WALLIE_FACTORY_SETUP_E2E !== "1", "Requires disposable local Supabase.");
  test.setTimeout(180_000);
  const fixture = await seedFactoryAnalytics(baseURL);
  const workspace = `/w/${fixture.slug}`;
  const secondary = `?factory=${fixture.siblingFactoryId}`;
  const primary = `?factory=${fixture.factoryId}`;
  const api = `/api/workspaces/${fixture.workspaceId}/factories`;
  const name = { exact: true } as const;
  const agentName = page.getByRole("textbox", { name: "Agent name", ...name });
  const scorerName = page.getByRole("textbox", { name: "Scorer name", ...name });
  const workflowName = page.getByRole("textbox", { name: "Workflow name", ...name });
  const principalName = page.getByRole("textbox", { name: "Principal name", ...name });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInViaMagicLink(page, `${workspace}/agents${secondary}`, {
      baseURL: fixture.app,
      email: fixture.ownerEmail,
    });
    const newAgent = page.getByRole("link", { name: "New agent", ...name });
    await expect(newAgent).toHaveCount(1);
    await expect(agentName).toHaveCount(0);
    await newAgent.press("Enter");
    await expect(page.getByRole("heading", { name: "New agent", ...name })).toBeFocused();
    await page.getByRole("link", { name: "Back to agents" }).click();
    await expect(newAgent).toBeFocused();
    await newAgent.click();
    await agentName.fill("Delivery reviewer");
    await Promise.all([
      page.waitForEvent("dialog").then(async (dialog) => {
        const message = dialog.message();
        await dialog.dismiss();
        expect(message).toBe("Leave without saving your agent draft?");
      }),
      page.getByRole("link", { name: "Back to agents" }).click(),
    ]);
    await expect(agentName).toHaveValue("Delivery reviewer");
    const advanced = page.getByText("Advanced", name);
    await advanced.click();
    const identifier = page.getByRole("textbox", { name: "Identifier", ...name });
    await identifier.fill("Invalid identifier");
    await advanced.click();
    const createAgent = page.getByRole("button", { name: "Create agent", ...name });
    await createAgent.click();
    await expect(identifier).toBeFocused();
    await expect(agentName).toHaveValue("Delivery reviewer");
    await identifier.fill("delivery-reviewer");
    await page
      .getByRole("textbox", { name: "Implementation prompt" })
      .fill("Review fixture output.");
    const agentCreated = creationResponse(page, `${api}/${fixture.siblingFactoryId}/agents`);
    await createAgent.click();
    expect((await agentCreated).status()).toBe(201);
    await expect(page.getByRole("heading", { name: "Delivery reviewer", ...name })).toBeVisible();
    await page.goto(`${workspace}/agents${secondary}`);
    await page.getByRole("link", { name: "Delivery reviewer", ...name }).click();
    await expect(page.getByRole("heading", { name: "Delivery reviewer", ...name })).toBeVisible();

    await page.goto(`${workspace}/scorers${secondary}`);
    await expect(
      page
        .getByRole("region", { name: "Factory scorers" })
        .getByText("No scorers in this factory yet."),
    ).toBeVisible();
    const newScorer = page.getByRole("link", { name: "New scorer", ...name });
    await expect(newScorer).toHaveCount(1);
    await expect(scorerName).toHaveCount(0);
    await newScorer.press("Enter");
    await expect(page.getByRole("heading", { name: "New scorer", ...name })).toBeFocused();
    await page.getByRole("button", { name: "Validate rubric", ...name }).click();
    await expect(scorerName).toBeFocused();
    await expect(
      page.getByRole("alert").filter({ hasText: "Review the highlighted fields" }),
    ).toBeVisible();
    await scorerName.fill("Unpublished fixture scorer");
    const backToScorers = page.getByRole("link", { name: "Back to scorers" });
    await backToScorers.click();
    await page.getByRole("button", { name: "Keep editing", ...name }).click();
    await expect(backToScorers).toBeFocused();
    await expect(scorerName).toHaveValue("Unpublished fixture scorer");
    await backToScorers.click();
    await page.getByRole("button", { name: "Discard changes", ...name }).click();
    await expect(newScorer).toBeFocused();

    await page.goto(`${workspace}/workflows${secondary}`);
    const serial = page.getByRole("link", { name: "Edit serial pipeline" });
    await expect(serial).toHaveAttribute(
      "href",
      `${workspace}/settings/factory-definition${secondary}#definition-field-stages`,
    );
    await expect(
      page
        .getByRole("region", { name: "Graph workflows" })
        .getByText("No workflows in this factory yet."),
    ).toBeVisible();
    await expect(workflowName).toHaveCount(0);
    const newWorkflow = page.getByRole("button", { name: "New workflow", ...name });
    await newWorkflow.press("Enter");
    const workflowDialog = page.getByRole("dialog", { name: "New workflow", ...name });
    await expect(workflowDialog).toHaveAccessibleDescription(/Restricted delivery/);
    await expect(workflowName).toBeFocused();
    await workflowName.fill("   ");
    const createWorkflow = workflowDialog.getByRole("button", { name: "Create workflow", ...name });
    await createWorkflow.click();
    await expect(workflowDialog.getByRole("alert")).toHaveText("Enter a workflow name.");
    await expect(workflowName).toBeFocused();
    await workflowName.fill("Fixture graph");
    await page.keyboard.press("Escape");
    await expect(newWorkflow).toBeFocused();
    await newWorkflow.press("Enter");
    await expect(workflowName).toHaveValue("Fixture graph");
    const workflowCreated = creationResponse(page, `${api}/${fixture.siblingFactoryId}/workflows`);
    await createWorkflow.click();
    expect((await workflowCreated).status()).toBe(201);
    await expect(page.getByRole("heading", { name: "Fixture graph", ...name })).toBeVisible();
    await page.getByRole("link", { name: "All workflows" }).click();
    await expect(newWorkflow).toHaveCount(1);
    await page.getByRole("link", { name: "Fixture graph Edit draft", ...name }).click();
    await expect(page.getByRole("heading", { name: "Fixture graph", ...name })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${workspace}/governance${primary}`);
    const newPrincipal = page.getByRole("button", { name: "New service principal", ...name });
    await expect(newPrincipal).toHaveCount(1);
    await expect(principalName).toHaveCount(0);
    await newPrincipal.click();
    const principalDialog = page.getByRole("dialog", { name: "New service principal", ...name });
    await expect(principalDialog).toHaveAccessibleDescription(
      /Product delivery.*does not grant access or issue credentials/,
    );
    await expect(principalName).toBeFocused();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await principalName.fill("Fixture notifier");
    await identifier.fill("deployment-observer");
    const createPrincipal = principalDialog.getByRole("button", {
      name: "Create service principal",
      ...name,
    });
    await createPrincipal.click();
    await expect(principalDialog.getByRole("alert")).toContainText(
      "This identifier is already in use",
    );
    await expect(principalName).toHaveValue("Fixture notifier");
    await expect(identifier).toHaveValue("deployment-observer");
    await identifier.fill("fixture-notifier");
    const principalCreated = creationResponse(
      page,
      `${api}/${fixture.factoryId}/service-principals`,
    );
    await createPrincipal.click();
    expect((await principalCreated).status()).toBe(201);
    await expect(
      page.getByRole("heading", { name: "Service principal", exact: true }),
    ).toBeVisible();

    const reader = await browser.newPage();
    try {
      await signInViaMagicLink(reader, `${workspace}/agents${primary}`, {
        baseURL: fixture.app,
        email: fixture.viewerEmail,
      });
      await reader.goto(`${workspace}/agents${primary}&new=1#new-agent`);
      await expect(reader.getByRole("heading", { name: "Agents", ...name })).toBeVisible();
      await expect(reader.getByRole("link", { name: "New agent", ...name })).toHaveCount(0);
      await reader.goto(`${workspace}/scorers${primary}&preset=blank#new-scorer`);
      await expect(reader.getByRole("heading", { name: "Scorers", ...name })).toBeVisible();
      await expect(reader.getByRole("link", { name: "New scorer", ...name })).toHaveCount(0);
      await reader.goto(`${workspace}/workflows${primary}`);
      await expect(
        reader.getByRole("heading", { name: "Factory unavailable", ...name }),
      ).toBeVisible();
      await expect(reader.getByRole("button", { name: "New workflow", ...name })).toHaveCount(0);
      await expect(reader.getByRole("link", { name: "Edit serial pipeline" })).toHaveCount(0);
      await reader.goto(`${workspace}/governance${primary}`);
      await expect(
        reader.getByRole("button", { name: "New service principal", ...name }),
      ).toHaveCount(0);
      await expect(reader.getByRole("textbox", { name: "Principal name", ...name })).toHaveCount(0);

      const nameAndSlug = { name: "Unauthorized fixture", slug: "unauthorized-fixture" };
      const writes = {
        agents: { ...nameAndSlug, promptMd: "Review fixture output." },
        scorers: {
          ...nameAndSlug,
          definition: {
            schemaVersion: 1,
            rubric: "Check that the fixture run retained a validation report.",
            requiredEvidence: ["validation_report"],
            scoring: { kind: "boolean", passValue: true },
          },
        },
        workflows: { displayName: nameAndSlug.name, workflowId: crypto.randomUUID() },
        "service-principals": nameAndSlug,
      };
      for (const [resource, data] of Object.entries(writes)) {
        const response = await reader.request.post(
          `${fixture.app}${api}/${fixture.factoryId}/${resource}`,
          { data, headers: { Origin: fixture.app } },
        );
        expect(response.status(), `write to ${resource}`).toBe(403);
      }
    } finally {
      await reader.close();
    }
  } finally {
    await fixture.cleanup();
  }
});
