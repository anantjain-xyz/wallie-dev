import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { z } from "zod";

import { factoryImprovementAdoptionSchema } from "../src/lib/factory-proposals/adoption-contracts";
import { signInViaMagicLink } from "./helpers/auth";
import {
  improvementBrowserFixtureSchema,
  runImprovementBrowserFixture,
} from "./helpers/factory-improvement-fixture";

const adoptionResultSchema = z.object({
  adoption: factoryImprovementAdoptionSchema,
  replay: z.boolean(),
});
function runFixture(action: "seed" | "adopt" | "cleanup", runId: string) {
  return runImprovementBrowserFixture("factory-improvement-adoption-seed.psql", action, runId);
}

async function capture(page: Page, info: TestInfo, name: string, region: Locator) {
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  const directory = process.env.WALLIE_ADOPTION_PROOF_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `${name}.png`);
  await region.screenshot({ path, animations: "disabled", caret: "hide" });
  await info.attach(name, { path, contentType: "image/png" });
}

test("adopts the exact reviewed revision and retains a read-only receipt", async ({
  baseURL,
  browser,
  page,
}, info) => {
  test.skip(
    process.env.WALLIE_FACTORY_ADOPTION_E2E !== "1",
    "Requires an isolated local Auth, PostgREST and Postgres fixture.",
  );
  if (!baseURL || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)) {
    throw new Error("Run this fixture against a loopback Wallie server.");
  }
  test.setTimeout(240_000);
  const runId = randomUUID();
  let workflowError: unknown;

  try {
    const fixture = improvementBrowserFixtureSchema.parse(await runFixture("seed", runId));
    const { workspaceId, workspaceSlug, factoryId, publication } = fixture;
    const { proposalId, proposalRevisionId, pullRequest, headCommitSha } = publication;
    if (!pullRequest || !headCommitSha) throw new Error("Fixture publication is incomplete.");
    const route = `/api/workspaces/${workspaceId}/factories/${factoryId}/improvement-proposals/${proposalId}/revisions/${proposalRevisionId}/adoption`;
    const path = `/w/${workspaceSlug}/improvements/${proposalId}?factory=${factoryId}&revision=${proposalRevisionId}`;
    const headers = { origin: baseURL };
    const command = {
      publicationId: publication.id,
      expectedActivationNumber: publication.base.activationNumber,
      candidateDigest: publication.candidate.digest,
      headCommitSha,
    };
    const section = page.locator("#adoption:visible");

    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await signInViaMagicLink(page, path, { baseURL, email: fixture.ownerEmail });
    const receipt = await page.request.get(route);
    expect(receipt.status()).toBe(200);
    expect(await receipt.json()).toEqual({ publication, adoption: null });
    await expect(section.getByRole("link", { name: /GitHub pull request/ })).toHaveAttribute(
      "href",
      pullRequest.url,
    );
    for (const [label, comparison] of [
      ["Targeted comparison", publication.comparisons.targeted],
      ["Held-out comparison", publication.comparisons.holdout],
    ] as const) {
      await expect(section.getByRole("link", { name: label, exact: true })).toHaveAttribute(
        "href",
        new RegExp(`/comparisons/${comparison.experimentId}\\?factory=${factoryId}$`),
      );
    }
    await expect(section.getByText("Active base · Activation 2")).toBeVisible();
    await expect(section.getByText(publication.base.digest, { exact: true })).toBeVisible();
    await expect(section.getByText(publication.candidate.digest, { exact: true })).toBeVisible();

    const manager = await browser.newPage();
    try {
      await signInViaMagicLink(manager, path, { baseURL, email: fixture.managerEmail });
      await expect(
        manager.locator("#adoption:visible").getByRole("link", { name: /GitHub pull/ }),
      ).toBeVisible();
      await expect(manager.getByRole("button", { name: "Adopt configuration" })).toHaveCount(0);
      const denied = await manager.request.post(route, { headers, data: command });
      expect(denied.status()).toBe(403);
    } finally {
      await manager.close();
    }

    const stale = await page.request.post(route, {
      headers,
      data: { ...command, expectedActivationNumber: command.expectedActivationNumber + 1 },
    });
    expect(stale.status()).toBe(409);

    await capture(page, info, "01-adoption-checklist-light", section);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    const action = section.getByRole("button", { name: "Adopt configuration", exact: true });
    await action.press("Enter");
    const confirm = page.getByRole("alertdialog", { name: "Adopt the reviewed configuration?" });
    await expect(confirm).toBeVisible();
    await capture(page, info, "02-adoption-confirmation-dark-mobile", confirm);
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    await expect(action).toBeFocused();
    await action.press("Enter");

    // Commit a synthetic review proof through the real activation RPC for the initial submit.
    // Subsequent page reads and the retry use the real API.
    await page.route(
      `${baseURL}${route}`,
      async (request) => {
        if (request.request().method() !== "POST") return request.continue();
        expect(request.request().postDataJSON()).toEqual(command);
        const result = adoptionResultSchema.parse(await runFixture("adopt", runId));
        await request.fulfill({ status: 201, json: result });
      },
      { times: 1 },
    );
    const [adopted] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url() === `${baseURL}${route}` && response.request().method() === "POST",
      ),
      confirm.getByRole("button", { name: "Verify GitHub and adopt" }).press("Enter"),
    ]);
    expect(adopted.status()).toBe(201);
    const saved = adoptionResultSchema.parse(await adopted.json()).adoption;
    await expect(section.getByText("Adopted", { exact: true })).toBeVisible();
    await expect(section.getByText("Adopted configuration · Activation 3")).toBeVisible();
    await expect(section.getByRole("button", { name: "Adopt configuration" })).toHaveCount(0);
    await capture(page, info, "03-adoption-receipt-dark-mobile", section);

    const replay = await page.request.post(route, { headers, data: command });
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toEqual({ adoption: saved, replay: true });
    await page.getByRole("link", { name: "Revision 1", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`revision=${fixture.previousRevisionId}`));
    await expect(section.getByText("This revision has no GitHub publication.")).toBeVisible();
    await page.getByRole("link", { name: "Revision 2", exact: true }).click();
    await expect(section.getByText("Adopted", { exact: true })).toBeVisible();
  } catch (error) {
    workflowError = error;
    throw error;
  } finally {
    try {
      expect(await runFixture("cleanup", runId)).toEqual({ cleaned: true });
    } catch (error) {
      if (workflowError)
        throw new AggregateError([workflowError, error], "Adoption flow and cleanup failed.");
      throw error;
    }
  }
});
