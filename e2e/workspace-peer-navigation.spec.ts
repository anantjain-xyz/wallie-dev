import { expect, test, type Page } from "@playwright/test";

import { signIn } from "./helpers/auth";

const workspace = "/w/acme-corp";
const sessions = `${workspace}/sessions`;
const settings = `${workspace}/settings`;
const runs = `${workspace}/runs`;
const automations = `${settings}/automations`;
const definition = `${settings}/factory-definition`;

const destinations = [
  { title: "Runs", path: runs, group: "Runs", oldLink: "Sessions" },
  { title: "Pipeline", path: definition, group: "Factory", oldLink: "Settings" },
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
  if (path === runs) {
    await expect(page.getByRole("navigation", { name: /^(Activity|Runs) views$/u })).toHaveCount(0);
  }
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
        const views = page.getByRole("navigation", { name: "Factory views" });
        await views.getByRole("link", { name: destination.title, exact: true }).press("Enter");
        await expectPeerHeader(page, destination);
        await expect(views.locator('[aria-current="page"]')).toHaveText(destination.title);
        continue;
      }
      if (width === 390) {
        await page.getByRole("button", { name: `Workspace navigation: ${current}` }).press("Enter");
        await expect(navigation.getByRole("link", { name: current, exact: true })).toHaveAttribute(
          "aria-current",
          "page",
        );
      }
      await expect(navigation.getByRole("link", { name: /^(Activity|Feed)$/u })).toHaveCount(0);
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

  await page.goto(`${sessions}?factory=all`);
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("link", { name: "Runs", exact: true })
    .click();
  await expect(page).toHaveURL(`${runs}?factory=all`);
  const filteredRuns = `${runs}?status=success&limit=1&factory=all`;
  await page.goto(filteredRuns);
  await main.getByRole("link", { name: "Older runs", exact: true }).press("Enter");
  await expect(page).toHaveURL((url) => url.pathname === runs && url.searchParams.has("cursor"));
  const olderPage = new URL(page.url());
  const row = main.getByRole("list", { name: "Runs", exact: true }).getByRole("listitem").first();
  const session = row.getByRole("link", { name: /^Session #\d+$/u });
  await expect(session).toHaveAttribute("href", /\/sessions\/\d+#wallie-run-[\da-f-]+$/u);
  await row.getByRole("link", { name: /— .*?(?:attempt \d+|created )/u }).press("Enter");
  await expect(page).toHaveURL((url) => url.pathname.startsWith(`${runs}/`));
  const back = main.getByRole("link", { name: "Back to filtered runs", exact: true });
  await expect(back).toBeVisible();
  const fromRuns = new URL(page.url()).searchParams.get("fromRuns");
  expect(Object.fromEntries(new URLSearchParams(fromRuns ?? ""))).toEqual(
    Object.fromEntries(olderPage.searchParams),
  );
  await expect(back).toHaveAttribute("href", `${runs}?${fromRuns}`);
  await expect(back.locator('svg[aria-hidden="true"]')).toBeVisible();
  await back.click();
  await expect(page).toHaveURL(`${runs}?${fromRuns}`);
  await expect(main.getByRole("link", { name: "Latest runs", exact: true })).toHaveAttribute(
    "href",
    filteredRuns,
  );
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

  const fromRuns = "status=success&limit=1&factory=all";
  await page.goto(
    `${runs}/00000000-0000-4000-8000-000000000001?${new URLSearchParams({ fromRuns })}`,
  );
  await expect(main.getByRole("heading", { name: "This page isn’t available" })).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Workspace navigation" })
      .getByRole("link", { name: "Runs", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(main.getByRole("link", { name: "Back to filtered runs" })).toHaveAttribute(
    "href",
    `${runs}?${fromRuns}`,
  );
});

test("the retired Activity and actor routes do not redirect or render a Feed", async ({ page }) => {
  await signIn(page, runs);
  const activity = `${workspace}/activity`;
  for (const path of [
    activity,
    `${activity}?factory=all&actor=00000000-0000-4000-8000-000000000001`,
    `${activity}/actors?factory=all&q=sample`,
  ]) {
    const response = await page.request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(404);
  }
});
