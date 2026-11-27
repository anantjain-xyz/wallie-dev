import { expect, test } from "@playwright/test";
import { signIn } from "./helpers/auth";

const sessionPath = "/w/acme-corp/sessions/1";

test.beforeEach(({ baseURL }) => {
  const loopback = ["localhost", "127.0.0.1", "0.0.0.0"];
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
  if (
    !baseURL ||
    ![baseURL, supabaseUrl].every((url) => loopback.includes(new URL(url).hostname))
  ) {
    throw new Error("Session review layout tests require local seed services.");
  }
});

for (const width of [390, 1440]) {
  test(`keeps review decisions within reach at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 });
    await signIn(page, sessionPath);

    const tools = page.getByRole("group", { name: "Artifact tools" });
    const decision = page.getByRole("region", { name: "Stage decision" });
    const approve = decision.getByRole("button", { name: "Approve Plan" });
    const requestChanges = decision.getByRole("button", { name: "Request changes" });
    await expect(approve).toBeEnabled();
    await expect(approve).toHaveAccessibleDescription("Approval queues Build.");
    await expect(tools).toBeInViewport({ ratio: 1 });
    const toolRows = await tools
      .locator("button")
      .evaluateAll((buttons) => [
        ...new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top))),
      ]);
    expect(toolRows).toHaveLength(1);

    await tools.getByRole("tab", { name: /^(Rendered|Full artifact)$/ }).click();
    const reader = page.getByRole("region", { name: "Artifact text" });
    const lastHeading = reader.getByRole("heading").last();
    await lastHeading.evaluate((node) => node.scrollIntoView({ block: "center" }));
    await expect(lastHeading).toBeInViewport({ ratio: 1 });
    await expect(decision).toBeInViewport({ ratio: 1 });
    const [end, bar] = await Promise.all([lastHeading.boundingBox(), decision.boundingBox()]);
    expect(end!.y + end!.height).toBeLessThan(bar!.y);

    await requestChanges.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Request changes" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleDescription(
      "Queues another Plan attempt with your feedback.",
    );
    await expect(decision).toBeHidden();
    const note = dialog.getByRole("textbox", { name: "Feedback for Wallie" });
    await note.fill("Keep this note when reopening.");
    await page.keyboard.press("Escape");
    await expect(requestChanges).toBeFocused();
    await requestChanges.press("Enter");
    await expect(note).toHaveValue("Keep this note when reopening.");
  });
}

test("waits for the exact approval and keeps review available after a stale response", async ({
  page,
}) => {
  const sent = Promise.withResolvers<Record<string, unknown>>();
  const release = Promise.withResolvers<void>();
  await page.route("**/phase-action", async (route) => {
    sent.resolve(route.request().postDataJSON());
    await release.promise;
    await route.fulfill({
      status: 409,
      json: { code: "stale_version", error: "This review changed. Refresh before approving." },
    });
  });
  await signIn(page, sessionPath);
  const decision = page.getByRole("region", { name: "Stage decision" });
  const review = page.getByRole("heading", { name: /^Review Plan v\d+$/ });
  const version = Number((await review.innerText()).split(" v")[1]);
  const approve = decision.getByRole("button", { name: "Approve Plan" });
  await expect(approve).toBeEnabled();
  await approve.press("Enter");
  try {
    await expect(decision.getByRole("button", { name: "Approving…" })).toBeDisabled();
    await expect(decision.getByRole("button", { name: "Request changes" })).toBeDisabled();
    expect(await sent.promise).toEqual({
      action: "approve",
      artifactId: expect.any(String),
      stageId: expect.any(String),
      version,
      expectedReviewRevision: expect.any(Number),
    });
    await expect(page.getByText("Plan approved", { exact: true })).toHaveCount(0);
  } finally {
    release.resolve();
  }
  await expect(page.getByText("This review changed. Refresh before approving.")).toBeVisible();
  await expect(review).toBeVisible();
  await expect(approve).toBeEnabled();
});
