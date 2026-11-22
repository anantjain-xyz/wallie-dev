import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { z } from "zod";

import { compileFactoryDefinition } from "../src/lib/factory-definitions/compiler";
import type { FactoryDefinitionCatalog } from "../src/lib/factory-definitions/references";
import { factoryImprovementAdoptionSchema } from "../src/lib/factory-proposals/adoption-contracts";
import { signInViaMagicLink } from "./helpers/auth";
import {
  improvementBrowserFixtureSchema,
  runImprovementBrowserFixture,
} from "./helpers/factory-improvement-fixture";

const id = (slot: number) => `62300000-0000-4000-9000-${String(slot).padStart(12, "0")}`;
const pinSchema = z.object({
  activationNumber: z.number().int(),
  revisionId: z.string().uuid(),
  digest: z.string(),
  pinHash: z.string(),
});

function defineFixtureBundles() {
  const workspaceId = id(11);
  const catalog = {
    workspaceId,
    pipelines: [{ id: id(40), workspaceId }],
    repositories: [{ id: id(42), workspaceId }],
    approvers: [{ id: id(21), workspaceId }],
    executionPolicyRevisions: [],
    deliveryPolicyRevisions: [],
    skills: [],
    tools: [],
    sandboxProviders: ["vercel"],
    agentPromptRevisions: [
      {
        id: id(48),
        workspaceId,
        agentId: id(47),
        promptRevisionId: id(48),
        promptMd: "",
        promptSha256: createHash("sha256").update("").digest("hex"),
      },
    ],
  } satisfies FactoryDefinitionCatalog;
  const definitions = [
    [161, "Review the task."],
    [162, "Review the task against the acceptance criteria."],
  ] as const;
  return Object.fromEntries(
    definitions.map(([slot, promptTemplateMd]) => {
      const compiled = compileFactoryDefinition(
        {
          kind: "structured",
          value: {
            schemaVersion: 1,
            kind: "serial",
            sandboxProvider: "vercel",
            pipeline: id(40),
            repository: id(42),
            implementationAgent: id(48),
            agent: {
              provider: "codex",
              model: "gpt-4.1-2025-04-14",
              concurrencyLimit: 2,
              stallTimeoutMs: 120_000,
              maxRetries: 0,
              maxTurns: 10,
            },
            stages: [
              {
                id: id(41),
                slug: "review",
                name: "Review",
                promptTemplateMd,
                anyoneCanApprove: true,
                approverMemberIds: [],
              },
            ],
          },
        },
        catalog,
      );
      if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
      return [id(slot), compiled.definitionJson];
    }),
  );
}

async function capture(page: Page, info: TestInfo, name: string, region: Locator) {
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  const directory = process.env.WALLIE_OUTCOMES_PROOF_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `${name}.png`);
  await region.screenshot({
    path,
    animations: "disabled",
    caret: "hide",
    style: '[data-shell-header], a[href="#main-content"] { visibility: hidden !important; }',
  });
  await info.attach(name, { path, contentType: "image/png" });
}

test("compares exact admitted revisions and restores the baseline through Settings", async ({
  baseURL,
  browser,
  page,
}, info) => {
  test.skip(
    process.env.WALLIE_FACTORY_OUTCOMES_E2E !== "1",
    "Requires the isolated local Auth, PostgREST and PostgreSQL fixture.",
  );
  if (!baseURL || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)) {
    throw new Error("Run this fixture against a loopback Wallie server.");
  }
  test.setTimeout(240_000);
  const runId = randomUUID();
  const adoptionFixture = "factory-improvement-adoption-seed.psql";
  const outcomesFixture = "factory-improvement-outcomes-seed.psql";
  let workflowError: unknown;

  try {
    const fixture = improvementBrowserFixtureSchema.parse(
      await runImprovementBrowserFixture(adoptionFixture, "seed", runId, {
        definition_bundles: JSON.stringify(defineFixtureBundles()),
      }),
    );
    const baselinePin = pinSchema.parse(
      await runImprovementBrowserFixture(outcomesFixture, "baseline", runId),
    );
    const { adoption } = z
      .object({ adoption: factoryImprovementAdoptionSchema })
      .parse(await runImprovementBrowserFixture(adoptionFixture, "adopt", runId));
    const candidatePin = pinSchema.parse(
      await runImprovementBrowserFixture(outcomesFixture, "candidate", runId),
    );
    expect(baselinePin).toMatchObject(adoption.baseline);
    expect(candidatePin).toMatchObject(adoption.adopted);
    const { workspaceId, workspaceSlug, factoryId } = fixture;
    const { proposalId, proposalRevisionId } = adoption;
    const workbench = `/w/${workspaceSlug}/improvements/${proposalId}?factory=${factoryId}&revision=${proposalRevisionId}`;
    const definitionRoute = `/api/workspaces/${workspaceId}/factories/${factoryId}/definition`;
    const adoptionRoute = `/api/workspaces/${workspaceId}/factories/${factoryId}/improvement-proposals/${proposalId}/revisions/${proposalRevisionId}/adoption`;
    const rollbackTarget = `/w/${workspaceSlug}/settings/factory-definition?factory=${factoryId}&revision=${baselinePin.revisionId}&activation=${baselinePin.activationNumber}&restoreFrom=${candidatePin.activationNumber}#candidate-tests`;
    const command = {
      action: "rollback",
      expectedActivationNumber: candidatePin.activationNumber,
      revisionId: baselinePin.revisionId,
      targetActivationNumber: baselinePin.activationNumber,
    };
    const headers = { origin: baseURL };
    const outcome = page.locator("#outcomes:visible");
    const admitted = outcome.getByRole("row", { name: /Admitted sessions/ });
    const spend = outcome.getByRole("row", { name: /Known run spend/ });

    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await signInViaMagicLink(page, workbench, { baseURL, email: fixture.ownerEmail });
    const adoptionBefore = await page.request.get(adoptionRoute);
    expect(adoptionBefore.status()).toBe(200);
    expect((await adoptionBefore.json()).adoption).toEqual(adoption);
    await expect(outcome.getByText("Inconclusive", { exact: true })).toBeVisible();
    await expect(admitted.getByRole("cell")).toHaveText(["1", "2"]);
    await expect(spend).toContainText("$0.20");
    await expect(spend).toContainText("Partial");
    await expect(spend).toContainText("1 measured");
    await expect(spend).toContainText("1 pending");
    await expect(outcome.getByRole("row", { name: /Approval limits/ })).toContainText("0%–50%");
    const rollback = outcome.getByRole("link", { name: "Review rollback" });
    await expect(rollback).toHaveAttribute("href", rollbackTarget);
    await capture(page, info, "01-production-outcomes-light", outcome);

    const manager = await browser.newPage();
    try {
      await signInViaMagicLink(manager, workbench, { baseURL, email: fixture.managerEmail });
      await expect(
        manager.locator("#outcomes:visible").getByText("Inconclusive", { exact: true }),
      ).toBeVisible();
      await expect(manager.getByRole("link", { name: "Review rollback" })).toHaveCount(0);
      const denied = await manager.request.post(definitionRoute, { headers, data: command });
      expect(denied.status()).toBe(403);
    } finally {
      await manager.close();
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await rollback.press("Enter");
    await expect(page).toHaveURL(new URL(rollbackTarget, baseURL).href);
    const activate = page.getByRole("button", { name: "Roll back to this revision" });
    await expect(activate).toBeEnabled({ timeout: 35_000 });
    await activate.press("Enter");
    const dialog = page.getByRole("alertdialog", { name: "Activate this revision?" });
    await expect(dialog.getByText(baselinePin.digest, { exact: true })).toBeVisible();
    await capture(page, info, "02-shared-rollback-confirmation-dark-mobile", dialog);
    const [response] = await Promise.all([
      page.waitForResponse(
        (entry) =>
          new URL(entry.url()).pathname === definitionRoute && entry.request().method() === "POST",
      ),
      dialog.getByRole("button", { name: "Activate revision" }).press("Enter"),
    ]);
    expect(response.request().postDataJSON()).toEqual(command);
    const rollbackBody = await response.json();
    expect(response.status(), JSON.stringify(rollbackBody)).toBe(201);
    expect(rollbackBody).toMatchObject({
      activation: {
        activationNumber: candidatePin.activationNumber + 1,
        revisionId: baselinePin.revisionId,
      },
    });

    const after = z
      .object({ restored: pinSchema, preserved: pinSchema })
      .parse(await runImprovementBrowserFixture(outcomesFixture, "restored", runId));
    expect(after.preserved).toEqual(candidatePin);
    expect(after.restored).toMatchObject({
      activationNumber: candidatePin.activationNumber + 1,
      revisionId: baselinePin.revisionId,
      digest: baselinePin.digest,
    });
    await page.goto(workbench, { waitUntil: "domcontentloaded" });
    await expect(outcome.getByText("Baseline restored", { exact: true })).toBeVisible();
    await expect(admitted.getByRole("cell")).toHaveText(["1", "2"]);
    await expect(rollback).toHaveCount(0);
    await expect(
      page.locator("#adoption:visible").getByRole("link", { name: /GitHub pull request/ }),
    ).toHaveAttribute("href", adoption.review.pullUrl);
    const adoptionAfter = await page.request.get(adoptionRoute);
    expect(adoptionAfter.status()).toBe(200);
    expect((await adoptionAfter.json()).adoption).toEqual(adoption);
    await capture(page, info, "03-production-outcomes-restored-dark-mobile", outcome);

    await page.goto(rollbackTarget, { waitUntil: "domcontentloaded" });
    await expect(page.getByText(/rollback link is stale.*return to the proposal/i)).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: new RegExp(`^Activation #${baselinePin.activationNumber},`),
      }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page
        .getByRole("button", {
          name: /^(Roll back to this revision|Run configuration test|Retest configuration)$/,
        })
        .and(page.locator("button:enabled")),
    ).toHaveCount(0);
    await expect(page.getByRole("alertdialog", { name: "Activate this revision?" })).toHaveCount(0);
    await capture(
      page,
      info,
      "04-stale-rollback-link-dark-mobile",
      page.locator("#candidate-tests:visible"),
    );
  } catch (error) {
    workflowError = error;
    throw error;
  } finally {
    try {
      expect(await runImprovementBrowserFixture(adoptionFixture, "cleanup", runId)).toEqual({
        cleaned: true,
      });
    } catch (error) {
      if (workflowError)
        throw new AggregateError([workflowError, error], "Outcome flow and cleanup failed.");
      throw error;
    }
  }
});
