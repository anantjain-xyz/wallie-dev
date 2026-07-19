import { expect, test, type Page } from "@playwright/test";

const workspacePath = "/w/acme-corp";

async function signIn(page: Page, destination: string) {
  await page.goto(destination);
  await expect(page).toHaveURL(/\/login\?/);
  await page.getByText("Dev password").click();
  await page.getByPlaceholder("dev@localhost.com").fill("anant@example.com");
  await page.getByPlaceholder("Password (min 6)").fill("password123");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(new RegExp(workspacePath));
  if (new URL(page.url()).pathname !== destination) await page.goto(destination);
  await expect(page).toHaveURL(destination);
}

async function expectNoPageOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.documentElement;
        return root.scrollWidth - root.clientWidth;
      }),
    )
    .toBeLessThanOrEqual(1);
}

test("desktop uses the document scroller and keeps overlays above sticky chrome", async ({
  page,
}) => {
  await page.setViewportSize({ height: 720, width: 1280 });
  await signIn(page, workspacePath + "/sessions/1");

  const artifact = page.locator(".artifact-content").first();
  await expect(artifact).toBeVisible();
  await expect
    .poll(() =>
      artifact.evaluate((element) => {
        const style = getComputedStyle(element);
        return { maxHeight: style.maxHeight, overflowY: style.overflowY };
      }),
    )
    .toEqual({ maxHeight: "none", overflowY: "visible" });

  await page.locator("#main-content").evaluate((main) => {
    const spacer = document.createElement("div");
    spacer.dataset.scrollProof = "";
    spacer.style.height = "900px";
    spacer.setAttribute("aria-hidden", "true");
    main.append(spacer);
  });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

  const scrollContract = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>("#main-content");
    const shell = document.querySelector<HTMLElement>("[data-app-shell]");
    return {
      documentIsScroller: document.scrollingElement === document.documentElement,
      mainOverflow: main ? getComputedStyle(main).overflowY : null,
      mainScrollTop: main?.scrollTop ?? -1,
      shellPosition: shell ? getComputedStyle(shell).position : null,
      windowScrollY: window.scrollY,
    };
  });
  expect(scrollContract).toMatchObject({
    documentIsScroller: true,
    mainOverflow: "visible",
    mainScrollTop: 0,
    shellPosition: "static",
  });
  expect(scrollContract.windowScrollY).toBeGreaterThan(0);

  const shellHeader = page.locator("[data-shell-header]");
  await expect
    .poll(() => shellHeader.evaluate((element) => Math.round(element.getBoundingClientRect().top)))
    .toBe(0);

  await page.getByRole("button", { name: /^Account:/ }).click();
  const menu = await page.getByRole("menu", { name: "Account" });
  const overlayRoot = page.locator("[data-wallie-overlay-root]");
  await expect(overlayRoot).toHaveCount(1);
  expect(await menu.evaluate((element) => element.closest("[data-wallie-overlay-root]")?.id)).toBe(
    "wallie-overlay-root",
  );
  const menuPosition = await Promise.all([
    menu.evaluate((element) => element.getBoundingClientRect().top),
    shellHeader.evaluate((element) => element.getBoundingClientRect().bottom),
    menu.evaluate((element) => Number(getComputedStyle(element).zIndex)),
    shellHeader.evaluate((element) => Number(getComputedStyle(element).zIndex)),
  ]);
  expect(menuPosition[0]).toBeGreaterThanOrEqual(menuPosition[1] - 1);
  expect(menuPosition[2]).toBeGreaterThan(menuPosition[3]);

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "New session" }).click();
  const dialog = await page.getByRole("dialog", { name: "Start a new session" });
  expect(
    await dialog.evaluate((element) => element.closest("[data-wallie-overlay-root]")?.id),
  ).toBe("wallie-overlay-root");
  const dialogBounds = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { bottom: rect.bottom, top: rect.top, zIndex: Number(getComputedStyle(element).zIndex) };
  });
  expect(dialogBounds.top).toBeGreaterThanOrEqual(0);
  expect(dialogBounds.bottom).toBeLessThanOrEqual(720);
  expect(dialogBounds.zIndex).toBeGreaterThan(menuPosition[3]);
});

test("back-forward restoration and settings anchors use document positions", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1024 });
  const settingsPath = workspacePath + "/settings";
  await signIn(page, settingsPath);
  await page.evaluate(() => window.scrollTo(0, 900));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(700);
  const savedPosition = await page.evaluate(() => window.scrollY);

  await page.getByRole("link", { name: "Sessions" }).click();
  await expect(page).toHaveURL(workspacePath + "/sessions");
  await page.goBack();
  await expect(page).toHaveURL(settingsPath);
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThanOrEqual(savedPosition - 80);

  await page.goto(settingsPath + "#pipeline");
  const pipelineSection = page.locator("#pipeline");
  await expect(pipelineSection).toBeVisible();
  await expect
    .poll(async () => {
      const [sectionTop, headerBottom] = await Promise.all([
        pipelineSection.evaluate((element) => element.getBoundingClientRect().top),
        page
          .locator("[data-shell-header]")
          .evaluate((element) => element.getBoundingClientRect().bottom),
      ]);
      return sectionTop - headerBottom;
    })
    .toBeGreaterThanOrEqual(0);
  const anchorOffset = await Promise.all([
    pipelineSection.evaluate((element) => element.getBoundingClientRect().top),
    page
      .locator("[data-shell-header]")
      .evaluate((element) => element.getBoundingClientRect().bottom),
  ]);
  expect(anchorOffset[0] - anchorOffset[1]).toBeLessThan(100);
});

test("390px keyboard viewport keeps a focused field and its validation visible", async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await signIn(page, workspacePath + "/sessions/1");
  await page.getByRole("button", { name: "New session" }).click();
  await page.getByLabel("Prompt").fill("Keyboard visibility proof");
  const linearField = page.getByLabel("Linear issue URL");
  await linearField.fill("https://example.com/not-linear");
  await linearField.blur();
  const validation = page.locator("#session-linear-error");
  await expect(validation).toBeVisible();

  await linearField.focus();
  await page.setViewportSize({ height: 380, width: 390 });
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--wallie-visual-viewport-height"),
      ),
    )
    .toBe("380px");
  await expect
    .poll(async () => {
      const fieldBox = await linearField.boundingBox();
      const validationBox = await validation.boundingBox();
      if (!fieldBox || !validationBox) return false;
      return (
        fieldBox.y >= 0 &&
        validationBox.y >= 0 &&
        fieldBox.y + fieldBox.height <= 380 &&
        validationBox.y + validationBox.height <= 380
      );
    })
    .toBe(true);
});

test("200% reflow and 320px mobile widths do not create horizontal page overflow", async ({
  page,
}) => {
  // A 640 CSS-pixel viewport exercises the same reflow width as a 1280px
  // desktop viewport at 200% browser zoom.
  await page.setViewportSize({ height: 450, width: 640 });
  await signIn(page, workspacePath + "/sessions/1");
  await expectNoPageOverflow(page);
  await page.getByRole("button", { name: /^Account:/ }).click();
  await expect(page.getByRole("menu", { name: "Account" })).toBeInViewport();

  await page.setViewportSize({ height: 640, width: 320 });
  await page.goto(workspacePath);
  await expect(page.getByRole("heading", { name: "Pipeline" })).toBeVisible();
  await expectNoPageOverflow(page);
  await page.goto(workspacePath + "/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expectNoPageOverflow(page);
});
