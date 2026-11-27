import { expect, test } from "@playwright/test";

test("the shared skip link bypasses the mast and the tour links reach hosted sign-in", async ({
  page,
}) => {
  await page.goto("/");
  const skip = page.getByRole("link", { name: "Skip to main content" });
  const main = page.getByRole("main");
  const startTour = main.getByRole("link", { name: "Start the tour" });
  const hosted = main.getByRole("link", { name: "Try hosted Wallie" });

  await page.keyboard.press("Tab");
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/#main-content$/);
  await expect(main).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(startTour).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/#configure$/);
  await expect(page.locator("#configure")).toBeFocused();

  for (const [name, target] of [
    ["Configure", "configure"],
    ["Run", "run"],
    ["Improve", "improve"],
    ["Back to the gate", "top"],
    ["Try Wallie", "start"],
  ]) {
    await page.getByRole("link", { name, exact: true }).press("Enter");
    await expect(page).toHaveURL(new RegExp(`/#${target}$`));
    await expect(page.locator(`#${target}`)).toBeFocused();
  }

  await expect(
    main.getByRole("heading", { name: "Make your own software factory", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(hosted).toBeFocused();
  await expect(hosted).toHaveAccessibleDescription(
    "For a hosted workspace, connect your GitHub repository, a sandbox, and your coding agent credentials. Linear is optional. You can also run Wallie yourself.",
  );
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in to Wallie" })).toBeVisible();
  await expect(page.getByLabel("Work email")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send sign-in email" })).toBeVisible();
});

test("legacy tour fragments still land inside the corresponding chapters", async ({ page }) => {
  for (const [fragment, chapter] of [
    ["studio", "Configure"],
    ["line", "Run"],
  ]) {
    await page.goto(`/#${fragment}`);
    const target = page.locator(`#${fragment}`);
    await expect(target).toHaveText(new RegExp(chapter));
    await expect(target).toBeInViewport();
  }
});

test("the setup, exact-version run proof and adoption receipt are entirely local", async ({
  page,
}) => {
  await page.goto("/");
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));

  await page.getByRole("link", { name: "Start the tour" }).click();
  const configure = page.locator("#configure");
  await expect(configure.getByText("Published", { exact: true })).toBeVisible();
  await configure.getByText("Read the setup receipt").press("Enter");
  await expect(
    configure.getByText(/a current passing test for the exact saved draft/),
  ).toBeVisible();

  const line = page.getByRole("region", { name: "Add a dry-run mode to the deploy CLI." });
  await line.getByRole("button", { name: "Build", exact: true }).click();
  await expect(line.getByRole("heading", { name: "Build takes an approved plan." })).toBeVisible();
  await line.getByRole("button", { name: "Go to Plan" }).press("Enter");
  await line.getByRole("button", { name: "Approve plan & continue" }).click();
  const evidence = line.getByText("Read the check evidence");
  await evidence.press("Space");
  await expect(line.getByText(/CLI output check: passed/)).toBeVisible();
  await line.getByRole("button", { name: "Request changes" }).click();
  await expect(
    line.getByRole("heading", { name: "A dry run skips the deploy call." }),
  ).toBeFocused();
  await line.getByRole("button", { name: "Build v1" }).click();
  await expect(line.getByRole("button", { name: "Approve Build v2" })).toHaveCount(0);
  await line.getByRole("button", { name: "Build v2" }).click();
  await evidence.click();
  await expect(line.getByText(/the observed count was 0/)).toBeVisible();
  await line.getByRole("button", { name: "Approve Build v2" }).click();
  const delivery = line.getByRole("button", { name: "See delivery" });
  await expect(delivery).toBeFocused();
  await delivery.press("Enter");
  await expect(line.getByRole("heading", { name: "Code can leave in a GitHub PR." })).toBeFocused();
  await expect(line.getByText(/approval doesn’t merge it/)).toBeVisible();
  await line.getByRole("button", { name: "Replay the work order" }).click();
  await expect(line.getByRole("heading", { name: "A task becomes a session." })).toBeFocused();

  await page.getByRole("link", { name: "Follow the evidence" }).press("Enter");
  const improve = page.locator("#improve");
  await expect(improve).toBeFocused();
  await improve.getByText("Read the WO–023 receipt").click();
  await expect(improve.getByText(/expected 0 calls in a dry run, observed 1/)).toBeVisible();
  const bench = improve.getByRole("table", {
    name: "Targeted and independent holdout comparisons",
  });
  await expect(bench.getByRole("row", { name: /Targeted task/ }).getByRole("cell")).toHaveText([
    /Fails\s*1 mock call/,
    /Passes\s*0 mock calls/,
  ]);
  await expect(
    bench.getByRole("row", { name: /Independent holdout/ }).getByRole("cell"),
  ).toHaveText([/Passes\s*Error shown/, /Passes\s*Error shown/]);
  const receipt = improve.getByRole("group", { name: "Admission receipt" });
  const after = receipt.getByRole("button", { name: "After adoption", pressed: true });
  const current = receipt.getByText("Already started").locator("..");
  const next = receipt.getByText("Next start").locator("..");
  await expect(current).toHaveText(/WO–024\s*R07/);
  await expect(next).toHaveText(/WO–025\s*R08/);
  await after.press("Home");
  const before = receipt.getByRole("button", { name: "Before adoption", pressed: true });
  await expect(before).toBeFocused();
  await expect(before).toHaveCSS("outline-style", "solid");
  await expect(current).toHaveText(/WO–024\s*R07/);
  await expect(next).toHaveText(/WO–025\s*R07/);
  await before.press("End");
  await expect(after).toBeFocused();
  await expect(next).toHaveText(/WO–025\s*R08/);
  expect(requests).toEqual([]);
});

test("the narrow dark tour keeps the cutaway and the work order usable with reduced motion", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.clock.install();
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Self-improving software factory",
  );
  await expect(
    page.getByRole("img", { name: "Cutaway drawing of the Wallie software factory" }),
  ).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("main").locator("..")).toHaveCSS(
    "background-color",
    "rgb(25, 25, 25)",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);

  const line = page.getByRole("region", { name: "Add a dry-run mode to the deploy CLI." });
  const carrier = line.getByText("WO–024", { exact: true }).locator("..");
  const intake = line.getByRole("button", { name: "Intake", exact: true });
  const plan = line.getByRole("button", { name: "Plan", exact: true });
  const position = await carrier.evaluate((element) => getComputedStyle(element).transform);
  await page.clock.fastForward(20_000);
  await expect(carrier).toHaveCSS("transform", position);

  await intake.press("ArrowRight");
  await expect(plan).toBeFocused();
  await expect(plan).toHaveAttribute("aria-pressed", "true");
  await expect(line.getByRole("heading", { name: "A plan for the flag." })).toBeVisible();
  await expect(carrier).not.toHaveCSS("transform", position);
  await expect(carrier).toHaveCSS("transition-property", "none");
  expect(await carrier.evaluate((element) => element.getAnimations().length)).toBe(0);

  await page.emulateMedia({ forcedColors: "active" });
  await expect(plan).toBeVisible();
  await expect(plan).toBeFocused();

  const receipt = page.getByRole("group", { name: "Admission receipt" });
  const before = receipt.getByRole("button", { name: "Before adoption" });
  await before.press("Space");
  await expect(before).toBeFocused();
  await expect(before).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
});

test("an explicit app theme overrides the system on the signed-out route", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => {
    window.localStorage.setItem("wallie-theme", "light");
  });
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("main").locator("..")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  const ticket = page.getByRole("region", { name: "Add a dry-run mode to the deploy CLI." });
  await expect(ticket.getByText("Work order 024 / R07")).toHaveCSS("color", "rgb(79, 70, 229)");
});
