import { expect, test, type Page } from "@playwright/test";

import { signIn, signInViaMagicLink } from "./helpers/auth";

const boardPath = "/w/acme-corp";
const listPath = `${boardPath}/sessions`;
const archivedTitle = "CI/CD pipeline with GitHub Actions";
const firstReviewTitle = "Add SSO login via Google Workspace";
const views = (page: Page) => page.getByRole("navigation", { name: "Sessions views" });
const currentView = (page: Page) => views(page).locator('[aria-current="page"]');
const status = (page: Page) => page.getByRole("combobox", { name: "Filter by status" });
const factory = (page: Page) => page.getByRole("combobox", { name: "Factory", exact: true });

async function applyBoardSearch(page: Page, query: string) {
  const input = page.getByRole("searchbox", { name: "Search active board" });
  await input.fill(query);
  await expect(page.getByRole("button", { name: "Search", exact: true })).toBeEnabled();
  await input.press("Enter");
}

test("one Sessions entry marks both views and carries compatible factory and status", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, boardPath);
  const rail = page.getByRole("navigation", { name: "Workspace navigation" });
  const sessions = rail.getByRole("link", { name: "Sessions", exact: true });
  await expect(sessions).toHaveCount(1);
  await expect(sessions).toHaveAttribute("href", boardPath);
  await expect(rail.getByRole("link", { name: "Pipeline", exact: true })).toHaveCount(0);
  await expect(sessions).toHaveAttribute("aria-current", "page");
  await expect(currentView(page)).toHaveText("Board");

  const boardSearch = page.getByRole("searchbox", { name: "Search active board" });
  await status(page).click();
  await page.getByRole("option", { name: "Awaiting review", exact: true }).click();
  await expect(page).toHaveURL(`${boardPath}?status=awaiting_review`);
  await applyBoardSearch(page, "Google Workspace");
  await expect(
    page.getByRole("link", { name: `Review session ${firstReviewTitle}` }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Review session Dark mode and theme customization" }),
  ).toHaveCount(0);
  const factoryId = await factory(page).getAttribute("data-value");
  expect(factoryId).toMatch(/^[a-f\d-]{36}$/u);
  await expect(page).toHaveURL(`${boardPath}?status=awaiting_review`);

  const listLink = views(page).getByRole("link", { name: "List" });
  const listHref = `${listPath}?factory=${factoryId}&scope=active&status=awaiting_review`;
  await expect(listLink).toHaveAttribute("href", listHref);
  await listLink.press("Enter");
  await expect(page).toHaveURL(listHref);
  await expect(sessions).toHaveAttribute("aria-current", "page");
  await expect(sessions).toHaveAttribute("href", `${listPath}?factory=${factoryId}`);
  await expect(currentView(page)).toHaveText("List");
  await expect(factory(page)).toHaveAttribute("data-value", factoryId!);
  await expect(status(page)).toHaveText("Awaiting review");
  await expect(page.getByRole("searchbox")).toHaveValue("");
  await expect(page.getByText("Dark mode and theme customization", { exact: true })).toBeVisible();
  await expect(page.getByText(archivedTitle, { exact: true })).toHaveCount(0);

  const boardLink = views(page).getByRole("link", { name: "Board" });
  const boardHref = `${boardPath}?factory=${factoryId}&status=awaiting_review`;
  await expect(boardLink).toHaveAttribute("href", boardHref);
  await boardLink.click();
  await expect(page).toHaveURL(boardHref);
  await expect(currentView(page)).toHaveText("Board");
  await expect(boardSearch).toHaveValue("");
  await expect(status(page)).toHaveText("Awaiting review");
  await page.goBack();
  await expect(currentView(page)).toHaveText("List");
  await page.goBack();
  await expect(currentView(page)).toHaveText("Board");
  await expect(boardSearch).toHaveValue("Google Workspace");
  await expect(status(page)).toHaveText("Awaiting review");
  await sessions.click();
  await expect(page).toHaveURL(boardPath);
  await expect(boardSearch).toHaveValue("");
  await expect(status(page)).toHaveText("All statuses");
  await page.goBack();
  await expect(boardSearch).toHaveValue("Google Workspace");
  await expect(status(page)).toHaveText("Awaiting review");
});

test("archived list filters and deep links return intact without carrying search to Board", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const filtered = `${listPath}?factory=all&scope=archived&sort=oldest&stage=land&status=approved&q=CI%2FCD`;
  await page.goto(filtered);
  const archived = page.getByRole("radio", { name: /^Archived / });
  const archivedSession = page.getByRole("link", {
    name: `Open session #6: ${archivedTitle}`,
    exact: true,
  });
  const search = page.getByRole("searchbox");
  await expect(archivedSession).toBeVisible();
  await expect(archived).toHaveAttribute("aria-checked", "true");
  await expect(search).toHaveValue("CI/CD");
  await page.setViewportSize({ width: 320, height: 760 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  const board = views(page).getByRole("link", { name: "Board" });
  await expect(board).toHaveAttribute("href", `${boardPath}?factory=all`);
  await board.click();
  await expect(page).toHaveURL(`${boardPath}?factory=all`);
  await expect(factory(page)).toHaveAttribute("data-value", "all");
  await expect(status(page)).toHaveText("All statuses");
  await expect(search).toHaveValue("");
  await expect(page.getByRole("region", { name: "All factories overview" })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Pipeline stage" })).toHaveCount(0);
  await expect(page.getByText(archivedTitle, { exact: true })).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(filtered);
  await expect(archived).toHaveAttribute("aria-checked", "true");
  await expect(search).toHaveValue("CI/CD");
  await expect(status(page)).toHaveText("Approved");
  await expect(page.getByRole("combobox", { name: "Filter by stage key" })).toHaveText(
    "Stage key: land",
  );
  await expect(page.getByRole("combobox", { name: "Sort sessions" })).toHaveText("Oldest updated");

  await archivedSession.click();
  await expect(page).toHaveURL((url) => url.pathname === `${listPath}/6`);
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  const returnHref = await breadcrumb.getByRole("link", { name: "Sessions" }).getAttribute("href");
  expect(Object.fromEntries(new URL(returnHref!, page.url()).searchParams)).toEqual(
    Object.fromEntries(new URL(filtered, page.url()).searchParams),
  );
  await page.goBack();
  await expect(page).toHaveURL(filtered);
  await expect(archivedSession).toBeVisible();

  await page.goto(`${listPath}?factory=all&scope=all&status=approved`);
  await expect(board).toHaveAttribute("href", `${boardPath}?factory=all`);
  await page.goto(`${listPath}?factory=all&q=nonexistent-synthetic-title`);
  await expect(
    page.getByRole("main").getByText("No matching sessions", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Clear search", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Show unfiltered sessions" })).toHaveCount(0);
  await page.goto(`${listPath}?factory=unavailable`);
  await expect(page.getByRole("heading", { name: "Factory unavailable" })).toBeVisible();
  await expect(board).toHaveAttribute("href", `${boardPath}?factory=unavailable`);
  await board.click();
  await expect(currentView(page)).toHaveText("Board");
  await expect(page.getByRole("heading", { name: "Factory unavailable" })).toBeVisible();
  await expect(page.getByRole("link", { name: "View accessible sessions" })).toHaveAttribute(
    "href",
    `${listPath}?factory=all`,
  );
});

test("the All factories overview links to the exact board and restores applied search history", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const aggregateHref = `${boardPath}?factory=all`;
  await signIn(page, aggregateHref);
  const overview = page.getByRole("region", { name: "All factories overview" });
  const defaultBoard = overview.getByRole("link", { name: "Open board for Default factory" });
  const exactHref = await defaultBoard.getAttribute("href");
  expect(exactHref).toMatch(/^\/w\/acme-corp\?factory=[a-f\d-]{36}$/u);
  await expect(overview.getByRole("heading", { name: "Plan", exact: true })).toBeVisible();
  await expect(overview.getByRole("tablist")).toHaveCount(0);

  const query = "PR #12";
  const search = page.getByRole("searchbox", { name: "Search active board" });
  const match = overview.getByRole("link", {
    name: "Review session Keyboard shortcuts for session triage",
  });
  const other = overview.getByRole("link", { name: `Review session ${firstReviewTitle}` });
  await search.fill(query);
  await expect(other).toBeVisible();
  await search.press("Enter");
  await expect(other).toHaveCount(0);
  await expect(match).toBeVisible();
  await expect(page).toHaveURL(aggregateHref);
  await page.goBack();
  await expect(search).toHaveValue("");
  await expect(other).toBeVisible();
  await page.goForward();
  await expect(search).toHaveValue(query);
  await expect(other).toHaveCount(0);
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(search).toBeFocused();
  await expect(other).toBeVisible();

  await defaultBoard.click();
  await expect(page).toHaveURL(exactHref!);
  await expect(page.getByRole("region", { name: "Pipeline board" })).toBeVisible();
});

test("compact Board keeps stage arrow keys, a single primary link, and native modifier-click", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signIn(page, boardPath);
  const openDrawer = page.getByRole("button", { name: "Workspace navigation: Sessions" });
  await openDrawer.press("Enter");
  const drawer = page.getByRole("dialog", { name: "Workspace pages" });
  await expect(drawer.getByRole("link", { name: "Sessions", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.keyboard.press("Escape");
  await expect(openDrawer).toBeFocused();

  const stageTabs = page.getByRole("tablist", { name: "Pipeline stage" }).getByRole("tab");
  await stageTabs.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(stageTabs.nth(1)).toBeFocused();
  await expect(stageTabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(stageTabs.last()).toBeFocused();
  await expect(stageTabs.last()).toHaveAttribute("aria-selected", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  const primary = page.getByRole("link", {
    name: "Review session Keyboard shortcuts for session triage",
  });
  const card = page.getByRole("article").filter({ has: primary });
  const pr = card.getByRole("link", { name: "PR #12" });
  await expect(card.getByRole("link")).toHaveCount(2);
  await expect(card.getByText("Awaiting review", { exact: true })).toBeVisible();
  await pr.click({ trial: true });
  await primary.focus();
  await page.keyboard.press("Tab");
  await expect(pr).toBeFocused();

  const popup = context.waitForEvent("page");
  await primary.click({ modifiers: ["ControlOrMeta"] });
  const opened = await popup;
  await expect(opened).toHaveURL(`${listPath}/5`);
  await opened.close();
  await expect(page).toHaveURL(boardPath);
  await primary.press("Enter");
  await expect(page).toHaveURL(`${listPath}/5`);
  await page.goBack();
  await expect(stageTabs.last()).toHaveAttribute("aria-selected", "true");
});

test("Back keeps the saved Board stage even if another stage has the only match", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, boardPath);
  await status(page).click();
  await page.getByRole("option", { name: "Awaiting review", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "Search active board" });
  await applyBoardSearch(page, "Google Workspace");
  const plan = page.getByRole("tab", { name: "Plan, 1 matching session" });
  const build = page.getByRole("tab", { name: "Build, 0 matching sessions" });
  await expect(plan).toHaveAttribute("aria-selected", "true");
  await plan.press("ArrowRight");
  await expect(build).toBeFocused();
  await expect(build).toHaveAttribute("aria-selected", "true");

  await views(page).getByRole("link", { name: "List" }).click();
  await expect(currentView(page)).toHaveText("List");
  await page.goBack();
  await expect(search).toHaveValue("Google Workspace");
  await expect(build).toHaveAttribute("aria-selected", "true");
});

test("Back keeps the automatically selected Board stage after widening a search", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, boardPath);
  await status(page).click();
  await page.getByRole("option", { name: "Awaiting review", exact: true }).click();
  await applyBoardSearch(page, "Supabase Realtime");
  await expect(page.getByRole("tab", { name: "Build, 1 matching session" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.getByRole("button", { name: "Clear search" }).click();
  const plan = page.getByRole("tab", { name: /^Plan, [1-9]\d* matching sessions?$/ });
  const build = page.getByRole("tab", { name: /^Build, [1-9]\d* matching sessions?$/ });
  await expect(plan).toBeVisible();
  await expect(build).toHaveAttribute("aria-selected", "true");

  await views(page).getByRole("link", { name: "List" }).click();
  await expect(currentView(page)).toHaveText("List");
  await page.goBack();
  await expect(plan).toBeVisible();
  await expect(build).toHaveAttribute("aria-selected", "true");

  await applyBoardSearch(page, "Google Workspace");
  await expect(page.getByRole("tab", { name: "Plan, 1 matching session" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("a Board status edit keeps automatic stage selection responsive", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, boardPath);
  await status(page).click();
  await page.getByRole("option", { name: "Awaiting review", exact: true }).click();
  const build = page.getByRole("tab", { name: "Build, 1 matching session" });
  await applyBoardSearch(page, "Supabase Realtime");
  await expect(build).toHaveAttribute("aria-selected", "true");
  await applyBoardSearch(page, "Google Workspace");
  await expect(page.getByRole("tab", { name: "Plan, 1 matching session" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(
    page.getByRole("tab", { name: /^Plan, [2-9]\d* matching sessions$/ }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(build).toBeVisible();

  await status(page).click();
  await page.getByRole("option", { name: "Changes requested", exact: true }).click();
  await expect(page).toHaveURL(`${boardPath}?status=rejected`);
  await expect(page.getByRole("tab", { name: "Plan, 0 matching sessions" })).toBeVisible();
  await expect(build).toHaveAttribute("aria-selected", "true");
});

test("another account cannot recover the previous Board search in the same tab", async ({
  page,
  baseURL,
}) => {
  const previousSearch = "synthetic board search before switching accounts";
  await signIn(page, boardPath);
  await status(page).click();
  await page.getByRole("option", { name: "Awaiting review", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "Search active board" });
  await applyBoardSearch(page, previousSearch);
  await expect(page.getByText("0 matching sessions", { exact: true })).toBeVisible();
  const saved = await page.evaluate(() => ({
    length: history.length,
    state: JSON.stringify(history.state),
  }));

  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/login");
  await signInViaMagicLink(page, listPath, { baseURL, email: "wallie@example.com" });
  await expect(page.getByRole("button", { name: "Account: wallie@example.com" })).toBeVisible();
  const distance = (await page.evaluate(() => history.length)) - saved.length;
  expect(distance).toBeGreaterThan(0);

  const queries: (string | null)[] = [];
  page.on("request", (request) => {
    const { pathname, searchParams } = new URL(request.url());
    if (pathname.endsWith("/pipeline-dashboard")) queries.push(searchParams.get("q"));
  });
  const loadedFilter = page.waitForResponse((response) => {
    const { pathname, searchParams } = new URL(response.url());
    return (
      pathname.endsWith("/pipeline-dashboard") &&
      searchParams.get("status") === "awaiting_review" &&
      response.ok()
    );
  });
  await page.evaluate((steps) => history.go(-steps), distance);
  await expect(page).toHaveURL(`${boardPath}?status=awaiting_review`);
  await expect(page.getByRole("button", { name: "Account: wallie@example.com" })).toBeVisible();
  await loadedFilter;
  await expect(search).toHaveValue("");
  expect(queries.filter((query) => query !== null)).toEqual([]);
  expect(saved.state).not.toContain(previousSearch);
});

test("Inbox still opens the exact review and Runs remains a separate attempt route", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, boardPath);
  const rail = page.getByRole("navigation", { name: "Workspace navigation" });
  await rail.getByRole("link", { name: "Inbox", exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === `${boardPath}/inbox`);
  const review = page.getByRole("link", { name: firstReviewTitle, exact: true });
  const href = await review.getAttribute("href");
  expect(href).toBeTruthy();
  const exact = new URL(href!, page.url());
  expect(exact.pathname).toBe(`${listPath}/1`);
  expect(exact.searchParams.get("artifactStage")).toBe("plan");
  expect(exact.searchParams.get("artifactVersion")).toBe("1");
  for (const key of ["artifactId", "reviewStageId"]) {
    expect(exact.searchParams.get(key)).toMatch(/^[a-f\d-]{36}$/u);
  }
  expect(exact.searchParams.get("reviewRevision")).toMatch(/^\d+$/u);
  expect(exact.searchParams.get("returnTo")).toMatch(/^\/w\/acme-corp\/inbox/u);
  await review.click();
  await expect(page).toHaveURL(exact.href);
  await expect(
    page
      .getByRole("region", { name: "Artifact text" })
      .getByRole("heading", { name: firstReviewTitle }),
  ).toBeVisible();

  await rail.getByRole("link", { name: "Runs", exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === `${boardPath}/runs`);
  const runsFactory = await factory(page).getAttribute("data-value");
  const inspect = page
    .getByRole("list", { name: /^Runs/ })
    .getByRole("link", { name: /— .*attempt \d+/i })
    .first();
  const run = await inspect.getAttribute("href");
  const runUrl = new URL(run!, page.url());
  expect(runUrl.pathname).toMatch(/^\/w\/acme-corp\/runs\/[a-f\d-]{36}$/u);
  expect(new URLSearchParams(runUrl.searchParams.get("fromRuns") ?? "").get("factory")).toBe(
    runsFactory,
  );
  await inspect.click();
  await expect(page).toHaveURL(runUrl.href);
  await expect(rail.getByRole("link", { name: "Runs", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  runUrl.searchParams.set("attempt", "1");
  const attempt = await page.goto(runUrl.href);
  expect(attempt?.ok()).toBe(true);
  await expect(page).toHaveURL(runUrl.href);
  await expect(page.getByRole("link", { name: "Back to runs" })).toBeVisible();
});
