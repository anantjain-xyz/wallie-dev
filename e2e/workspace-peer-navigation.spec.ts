import { expect, test, type Page } from "@playwright/test";

import { signIn } from "./helpers/auth";

const workspace = "/w/acme-corp";
const sessions = `${workspace}/sessions`;
const settings = `${workspace}/settings`;
const runs = `${workspace}/runs`;
const automations = `${settings}/automations`;
const definition = `${settings}/factory-definition`;

const destinations = [
  { title: "Runs", path: runs, group: "Activity", oldLink: "Sessions" },
  { title: "Factory definition", path: definition, group: "Factory", oldLink: "Settings" },
  { title: "Automations", path: automations, group: "Factory", oldLink: "Back to Settings" },
] as const;

async function expectPeerHeader(
  page: Page,
  { title, path, oldLink }: (typeof destinations)[number],
) {
  await expect(page).toHaveURL((url) => url.pathname === path);
  const heading = page.getByRole("heading", { name: title, exact: true, level: 1 });
  const header = page.getByRole("main").locator("header").filter({ has: heading });
  await expect(header).toBeVisible();
  await expect(header.getByRole("link", { name: oldLink, exact: true })).toHaveCount(0);
}

for (const width of [1440, 390]) {
  test(`peer pages have no parent links on direct and workspace navigation at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await signIn(page, sessions);

    for (const destination of destinations) {
      await page.goto(destination.path);
      await expectPeerHeader(page, destination);
    }

    await page.goto(sessions);
    const drawer = page.getByRole("dialog", { name: "Workspace pages" });
    const navigation =
      width === 390 ? drawer : page.getByRole("navigation", { name: "Workspace navigation" });
    let current: string = "Sessions";
    for (const destination of destinations) {
      if (current === destination.group) {
        const sections = page.getByRole("navigation", { name: "Factory sections" });
        await sections.getByRole("link", { name: destination.title, exact: true }).press("Enter");
        await expectPeerHeader(page, destination);
        await expect(sections.locator('[aria-current="page"]')).toHaveText(destination.title);
        continue;
      }
      if (width === 390) {
        await page.getByRole("button", { name: `Workspace navigation: ${current}` }).press("Enter");
        await expect(navigation.getByRole("link", { name: current, exact: true })).toHaveAttribute(
          "aria-current",
          "page",
        );
      }
      const link = navigation.getByRole("link", { name: destination.group, exact: true });
      await link.press("Enter");
      await expectPeerHeader(page, destination);
      if (width === 390) {
        await expect(page.getByRole("dialog", { name: "Workspace pages" })).toBeHidden();
        await expect(
          page.getByRole("button", { name: `Workspace navigation: ${destination.group}` }),
        ).toBeVisible();
      } else {
        await expect(link).toHaveAttribute("aria-current", "page");
      }
      current = destination.group;
    }
  });
}

test("Settings and Sessions launches keep scoped recovery and exact run returns", async ({
  page,
}) => {
  await signIn(page, settings);
  const main = page.getByRole("main");

  await main.getByRole("link", { name: "Manage automations", exact: true }).click();
  await expect(page).toHaveURL(automations);
  await main.getByRole("link", { name: "New rule", exact: true }).click();
  await expect(page).toHaveURL((url) => url.searchParams.has("factory"));
  const factory = new URL(page.url()).searchParams.get("factory");
  const reviewDefinition = main.getByRole("link", { name: "Review Factory definition" });
  await expect(reviewDefinition).toHaveAttribute("href", `${definition}?factory=${factory}`);
  await reviewDefinition.click();
  await expect(page).toHaveURL(`${definition}?factory=${factory}`);

  await page.goto(settings);
  await main
    .getByRole("link", { name: /^(Open definition editor|Review configuration tests)$/u })
    .click();
  await expect(page).toHaveURL((url) => url.pathname === definition);

  await page.goto(sessions);
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("link", { name: "Activity", exact: true })
    .click();
  await expect(page).toHaveURL((url) => url.pathname === runs);
  const filteredRuns = `${runs}?status=success&factory=all`;
  await page.goto(filteredRuns);
  const row = main.getByRole("list", { name: "Runs", exact: true }).getByRole("listitem").first();
  const session = row.getByRole("link", { name: /^Session #\d+$/u });
  await expect(session).toHaveAttribute("href", /\/sessions\/\d+#wallie-run-[\da-f-]+$/u);
  await row.getByRole("link", { name: /— .*?(?:attempt \d+|created )/u }).press("Enter");
  await expect(page).toHaveURL((url) => url.pathname.startsWith(`${runs}/`));
  const back = main.getByRole("link", { name: "Back to filtered runs", exact: true });
  await expect(back).toHaveAttribute("href", filteredRuns);
  await expect(back.locator('svg[aria-hidden="true"]')).toBeVisible();
  await back.click();
  await expect(page).toHaveURL(filteredRuns);
});

test("unavailable selections still offer scoped recovery", async ({ page }) => {
  await signIn(page, sessions);
  const main = page.getByRole("main");

  await page.goto(`${automations}?factory=unavailable`);
  const backToAutomations = main.getByRole("link", { name: "Back to automations", exact: true });
  await expect(backToAutomations).toHaveAttribute("href", automations);
  await expect(backToAutomations.locator('svg[aria-hidden="true"]')).toBeVisible();
  for (const path of [runs, definition]) {
    await page.goto(`${path}?factory=unavailable`);
    await expect(main.getByRole("link", { name: "View accessible sessions" })).toHaveAttribute(
      "href",
      `${sessions}?factory=all`,
    );
  }
});
