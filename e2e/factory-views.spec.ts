import { expect, test } from "@playwright/test";

import { signInViaMagicLink } from "./helpers/auth";
import { seedFactoryAnalytics } from "./helpers/factory-analytics";

const views = [
  ["Pipeline", "settings/factory-definition"],
  ["Graph workflows", "workflows"],
  ["Agents", "agents"],
  ["Context", "context"],
  ["Memory", "memory"],
  ["Scorers", "scorers"],
  ["Automations", "settings/automations"],
  ["Access", "governance"],
] as const;

test("Factory views keep one current link and the selected factory on desktop and mobile", async ({
  baseURL,
  browser,
  page,
}) => {
  test.skip(process.env.WALLIE_FACTORY_SETUP_E2E !== "1", "Requires disposable local Supabase.");
  test.setTimeout(120_000);
  const fixture = await seedFactoryAnalytics(baseURL);
  const path = (leaf: string) => `/w/${fixture.slug}/${leaf}`;
  const scoped = (leaf: string) => `${path(leaf)}?factory=${fixture.factoryId}`;
  const pipeline = scoped("settings/factory-definition");
  const row = page.getByRole("navigation", { name: "Factory views" });
  const link = (name: string) => row.getByRole("link", { name, exact: true });
  const current = row.locator('[aria-current="page"]');
  const expectCurrent = async (name: string) => {
    await expect(current).toHaveCount(1);
    await expect(current).toHaveText(name);
  };

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await signInViaMagicLink(page, `${scoped("agents")}&q=missing`, {
      baseURL: fixture.app,
      email: fixture.ownerEmail,
    });
    await expectCurrent("Agents");
    await expect(row.getByRole("link")).toHaveText(views.map(([label]) => label));
    await expect(page.getByRole("navigation", { name: "Factory sections" })).toHaveCount(0);
    for (const [label, leaf] of views) {
      await expect(link(label)).toHaveAttribute("href", scoped(leaf));
      await expect(link(label)).toBeInViewport({ ratio: 0.99 });
    }

    await link("Pipeline").click();
    await expect(page).toHaveURL(pipeline);
    await expectCurrent("Pipeline");
    await expect(page.getByRole("heading", { name: "Pipeline", level: 1 })).toBeInViewport();
    await expect(page.getByRole("heading", { name: "Setup", exact: true })).toBeInViewport();
    for (const id of ["factory-setup", "definition-field-stages"]) {
      await page.goto(`${pipeline}#${id}`);
      await expect(page).toHaveURL(`${pipeline}#${id}`);
      await expect(page.locator(`#${id}`)).toBeInViewport();
      await expectCurrent("Pipeline");
    }

    await link("Graph workflows").click();
    await expect(page).toHaveURL(scoped("workflows"));
    await expectCurrent("Graph workflows");
    await expect(page.getByRole("region", { name: "Graph workflows" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Edit serial pipeline" })).toHaveAttribute(
      "href",
      `${pipeline}#definition-field-stages`,
    );

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(scoped("context"));
      await expectCurrent("Context");
      await expect(current).toBeInViewport({ ratio: 0.99 });
      await link("Pipeline").focus();
      for (const [index, [label]] of views.entries()) {
        if (index > 0) await page.keyboard.press("Tab");
        await expect(link(label)).toBeFocused();
        await expect(link(label)).toBeInViewport({ ratio: 0.99 });
      }
      await expect(row.getByRole("link").last()).toBeFocused();
      expect(
        await row.evaluate((nav) => ({
          rowCount: new Set(Array.from(nav.children, (tab) => tab.getBoundingClientRect().top))
            .size,
          scrolls: nav.scrollWidth > nav.clientWidth,
          overflows: document.documentElement.scrollWidth > innerWidth,
        })),
      ).toEqual({ rowCount: 1, scrolls: true, overflows: false });

      await link("Memory").press("Enter");
      await expect(page).toHaveURL(scoped("memory"));
      await expectCurrent("Memory");
      await expect(current).toBeInViewport({ ratio: 0.99 });
      await page.goBack();
      await expect(page).toHaveURL(scoped("context"));
      await expectCurrent("Context");
      await expect(current).toBeInViewport({ ratio: 0.99 });
      await page.goForward();
      await expect(page).toHaveURL(scoped("memory"));
      await expectCurrent("Memory");
      await expect(current).toBeInViewport({ ratio: 0.99 });
      await page.goto(scoped("memory"));
      await expectCurrent("Memory");
      await expect(current).toBeInViewport({ ratio: 0.99 });
    }

    const reader = await browser.newPage();
    try {
      await signInViaMagicLink(reader, scoped("agents"), {
        baseURL: fixture.app,
        email: fixture.viewerEmail,
      });
      const readOnly = reader.getByRole("navigation", { name: "Factory views" });
      await expect(readOnly.getByRole("link")).toHaveText(["Agents", "Scorers"]);
      await expect(readOnly.locator('[aria-current="page"]')).toHaveText("Agents");
      await expect(reader.getByRole("link", { name: "New agent" })).toHaveCount(0);
      await reader.goto(`${path("context")}?factory=${fixture.siblingFactoryId}`);
      await expect(reader.getByRole("heading", { name: "Factory unavailable" })).toBeVisible();
      await expect(readOnly.getByRole("link", { name: "Agents" })).toHaveAttribute(
        "href",
        `${path("agents")}?factory=unavailable`,
      );
    } finally {
      await reader.close();
    }
  } finally {
    await fixture.cleanup();
  }
});
