import { expect, test, type Page } from "@playwright/test";

import { signIn } from "./helpers/auth";

const workspace = "/w/acme-corp";
const sessions = `${workspace}/sessions`;
const settings = `${workspace}/settings`;
const runs = `${workspace}/runs`;
const automations = `${settings}/automations`;
const definition = `${settings}/factory-definition`;

const destinations = [
  { title: "Runs", path: runs, oldLink: "← Sessions" },
  { title: "Automations", path: automations, oldLink: "Back to Settings" },
  { title: "Factory definition", path: definition, oldLink: "Settings" },
];

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
    const navigation = page.getByRole("navigation", { name: "Workspace navigation" });
    let current = "Sessions";
    for (const destination of destinations) {
      if (width === 390) {
        await page.getByRole("button", { name: `Workspace navigation: ${current}` }).press("Enter");
        await expect(navigation.getByRole("link", { name: current, exact: true })).toHaveAttribute(
          "aria-current",
          "page",
        );
      }
      const link = navigation.getByRole("link", { name: destination.title, exact: true });
      await link.press("Enter");
      await expectPeerHeader(page, destination);
      if (width === 390) {
        await expect(page.getByRole("dialog", { name: "Workspace pages" })).toBeHidden();
        await expect(
          page.getByRole("button", { name: `Workspace navigation: ${destination.title}` }),
        ).toBeVisible();
      } else {
        await expect(link).toHaveAttribute("aria-current", "page");
      }
      current = destination.title;
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
  await main.getByRole("link", { name: "Runs", exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === runs);
  const filteredRuns = `${runs}?status=success&factory=all`;
  await page.goto(filteredRuns);
  const row = main.getByRole("list", { name: "Runs", exact: true }).getByRole("listitem").first();
  const session = row.getByRole("link", { name: /^Session #\d+$/u });
  await expect(session).toHaveAttribute("href", /\/sessions\/\d+#wallie-run-[\da-f-]+$/u);
  await row.getByRole("link", { name: /— .*?(?:attempt \d+|created )/u }).press("Enter");
  await expect(page).toHaveURL((url) => url.pathname.startsWith(`${runs}/`));
  const back = main.getByRole("link", { name: "← Back to filtered runs", exact: true });
  await expect(back).toHaveAttribute("href", filteredRuns);
  await back.click();
  await expect(page).toHaveURL(filteredRuns);
});

test("unavailable selections still offer scoped recovery", async ({ page }) => {
  await signIn(page, sessions);
  const main = page.getByRole("main");

  await page.goto(`${automations}?factory=unavailable`);
  await expect(main.getByRole("link", { name: "Back to automations" })).toHaveAttribute(
    "href",
    automations,
  );
  for (const path of [runs, definition]) {
    await page.goto(`${path}?factory=unavailable`);
    await expect(main.getByRole("link", { name: "View accessible sessions" })).toHaveAttribute(
      "href",
      `${sessions}?factory=all`,
    );
  }
});
