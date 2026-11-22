import { expect, test, type APIResponse, type Locator, type Page } from "@playwright/test";
import { z } from "zod";

import { diagnosisReceiptSchema } from "../src/lib/factory-diagnosis/contracts";
import { factoryImprovementAdoptionSchema } from "../src/lib/factory-proposals/adoption-contracts";
import { factoryImprovementPublicationSchema } from "../src/lib/factory-proposals/publication-contracts";
import {
  workspaceFactoryDefinitionPath,
  workspaceFailureGroupPath,
  workspaceImprovementPath,
  workspaceRunDetailPath,
} from "../src/lib/routes";
import {
  factoryImprovementLoopManifestSchema,
  improvementQualificationBase,
  improvementQualificationRepository,
  improvementQualificationRepositoryId,
  readFactoryImprovementLoopManifest,
  type FactoryImprovementLoopManifest,
} from "../test/release/factory-improvement-loop-contract";
import {
  admitQualificationSession,
  auditQualificationRollback,
  authenticateQualificationOwner,
  captureQualificationEvidence,
  prepareQualificationRollbackSmoke,
  qualificationAppOrigin,
} from "./helpers/factory-improvement-loop-qualification";

type Manifest = FactoryImprovementLoopManifest;
const adoptionRead = z.object({
  publication: factoryImprovementPublicationSchema.nullable(),
  adoption: factoryImprovementAdoptionSchema.nullable(),
});
const validationRead = z.object({
  validation: z.object({
    id: z.string().uuid(),
    proposalId: z.string().uuid(),
    proposalRevisionId: z.string().uuid(),
    base: factoryImprovementPublicationSchema.shape.base,
    candidate: factoryImprovementPublicationSchema.shape.candidate,
    status: z.literal("qualified"),
    targeted: z.object({ experimentId: z.string().uuid(), status: z.literal("qualified") }),
    holdout: z.object({ experimentId: z.string().uuid(), status: z.literal("qualified") }),
  }),
});

async function accepted(
  response: Pick<APIResponse, "status" | "json">,
  status: number,
): Promise<unknown> {
  expect(response.status()).toBe(status);
  return response.json() as Promise<unknown>;
}

async function expectEvidence(page: Page, app: string, factoryApi: string, manifest: Manifest) {
  const evidence = page.locator("#evidence:visible");
  const diagnosisRoute = `${factoryApi}/diagnoses/${manifest.diagnosisId}`;
  await expect(evidence.getByRole("link", { name: "Open failure group" })).toHaveAttribute(
    "href",
    workspaceFailureGroupPath(manifest.workspaceSlug, manifest.cohortId, {
      factory: manifest.factoryId,
    }),
  );
  await expect(evidence.getByRole("link", { name: "Open diagnosis receipt" })).toHaveAttribute(
    "href",
    diagnosisRoute,
  );
  const receipt = z
    .object({ diagnosis: z.unknown() })
    .parse(await accepted(await page.request.get(new URL(diagnosisRoute, app).href), 200));
  const diagnosis = diagnosisReceiptSchema.parse(receipt.diagnosis);
  expect(diagnosis).toMatchObject({
    diagnosis_id: manifest.diagnosisId,
    workspace_id: manifest.workspaceId,
    factory_id: manifest.factoryId,
    cohort_id: manifest.cohortId,
    definition_revision_id: manifest.baseline.revisionId,
    definition_digest: manifest.baseline.digest,
    status: "completed",
    evidence_state: "available",
  });
  expect(diagnosis.support_count).toBeGreaterThanOrEqual(diagnosis.minimum_support);
  const citations = new Set(diagnosis.result?.claims.flatMap((claim) => claim.member_ids));
  const runs = (diagnosis.evidence ?? []).filter((run) => citations.has(run.member_id));
  expect(new Set(runs.map((run) => run.run_id))).toEqual(new Set(manifest.sourceRunIds));
  expect(new Set(runs.map((run) => run.session_id)).size).toBeGreaterThanOrEqual(3);
  const citedRuns = evidence.getByRole("list", { name: "Cited run evidence" });
  for (const run of runs) {
    const href = workspaceRunDetailPath(manifest.workspaceSlug, run.run_id, {
      attempt: run.run_attempt_count,
    });
    await expect(citedRuns.locator(`a[href="${href}"]`)).toBeVisible();
  }
  return evidence;
}

async function expectComparisonLinks(adoptionPanel: Locator, app: string, manifest: Manifest) {
  for (const [label, experimentId] of [
    ["Targeted comparison", manifest.targetedExperimentId],
    ["Held-out comparison", manifest.holdoutExperimentId],
  ] as const) {
    const link = adoptionPanel.getByRole("link", { name: label, exact: true });
    await expect(link).toBeVisible();
    const url = new URL(z.string().parse(await link.getAttribute("href")), app);
    expect(url.origin).toBe(app);
    expect(url.pathname).toMatch(new RegExp(`/benchmarks/[^/]+/comparisons/${experimentId}$`));
    expect(url.searchParams.get("factory")).toBe(manifest.factoryId);
  }
}

test.describe.configure({ retries: 0 });
test.use({ trace: "off", video: "off", screenshot: "off" });

test("refuses an altered publication or a different app origin before authentication", () => {
  const id = (slot: number) => `62300000-0000-4000-9000-${String(slot).padStart(12, "0")}`;
  const runId = id(1);
  const factoryId = id(3);
  const revisionId = id(7);
  const expected = {
    runId,
    appOrigin: "http://127.0.0.1:3200",
    workspaceId: id(2),
    workspaceSlug: "improvement-qualification",
    factoryId,
    actorUserId: id(4),
    ownerEmail: "qualification-owner@example.test",
    cohortId: id(5),
    diagnosisId: id(6),
    proposalId: id(8),
    proposalRevisionId: revisionId,
    sourceRunIds: [id(9), id(10), id(11)],
    baseline: { activationNumber: 3, revisionId: id(12), digest: "a".repeat(64) },
    candidate: { revisionId: id(13), digest: "b".repeat(64) },
    validationId: id(14),
    targetedExperimentId: id(15),
    holdoutExperimentId: id(16),
    publication: {
      id: id(17),
      number: 642,
      url: `https://github.com/${improvementQualificationRepository}/pull/642`,
      baseBranch: improvementQualificationBase(runId),
      headBranch: `wallie/improvements/${factoryId}/${revisionId}`,
      baseCommitSha: "c".repeat(40),
      headCommitSha: "d".repeat(40),
      repositoryNumericId: improvementQualificationRepositoryId,
      configPath: `.wallie/factory-definitions/${factoryId}.json`,
    },
  };
  const accepted = factoryImprovementLoopManifestSchema.parse(expected);
  expect(qualificationAppOrigin(accepted, expected.appOrigin)).toBe(expected.appOrigin);
  expect(() => qualificationAppOrigin(accepted, "http://127.0.0.1:9999")).toThrow();
  expect(() => qualificationAppOrigin(accepted, `${expected.appOrigin}/other`)).toThrow();
  for (const changed of [
    { ...expected, appOrigin: "https://wallie.dev" },
    { ...expected, publication: { ...expected.publication, baseBranch: "main" } },
    { ...expected, publication: { ...expected.publication, configPath: "unrelated.json" } },
    {
      ...expected,
      publication: { ...expected.publication, url: "https://github.com/other/repo/pull/642" },
    },
    { ...expected, key: "fixture-secret" },
  ]) {
    expect(factoryImprovementLoopManifestSchema.safeParse(changed).success).toBe(false);
  }
});

test.describe("Live reviewed qualification", () => {
  const manifestPath = process.env.WALLIE_FACTORY_IMPROVEMENT_MANIFEST;
  test.skip(
    !manifestPath,
    "Requires the scoped OP642 manifest and a genuinely approved, merged draft.",
  );
  test("qualifies a real reviewed improvement through adoption and exact rollback", async ({
    page,
  }, info) => {
    if (!manifestPath) throw new Error("The live qualification manifest is required.");
    test.setTimeout(240_000);
    const manifest = await readFactoryImprovementLoopManifest(manifestPath);
    const app = qualificationAppOrigin(manifest, process.env.PLAYWRIGHT_BASE_URL);
    const { workspaceId, factoryId, workspaceSlug, proposalId, proposalRevisionId } = manifest;
    const factoryApi = `/api/workspaces/${workspaceId}/factories/${factoryId}`;
    const proposalApi = `${factoryApi}/improvement-proposals/${proposalId}/revisions/${proposalRevisionId}`;
    const adoptionApi = new URL(`${proposalApi}/adoption`, app).href;
    const definitionApi = new URL(`${factoryApi}/definition`, app).href;
    const workbench = new URL(
      workspaceImprovementPath(workspaceSlug, proposalId, {
        factory: factoryId,
        revision: proposalRevisionId,
      }),
      app,
    ).href;
    const adoptionPanel = page.locator("#adoption:visible");

    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await authenticateQualificationOwner(page, manifest);
    await page.goto(workbench, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Improvement proposal", exact: true }),
    ).toBeVisible();

    const before = adoptionRead.parse(await accepted(await page.request.get(adoptionApi), 200));
    expect(
      before.adoption,
      "The live fixture requires its first adoption through the real UI.",
    ).toBeNull();
    expect(before.publication).toMatchObject({
      id: manifest.publication.id,
      proposalId,
      proposalRevisionId,
      validationId: manifest.validationId,
      base: manifest.baseline,
      candidate: manifest.candidate,
      baseCommitSha: manifest.publication.baseCommitSha,
      headCommitSha: manifest.publication.headCommitSha,
      cohort: { id: manifest.cohortId, diagnosisId: manifest.diagnosisId },
      target: {
        repositoryFullName: improvementQualificationRepository,
        repositoryNumericId: manifest.publication.repositoryNumericId,
        baseBranch: manifest.publication.baseBranch,
        headBranch: manifest.publication.headBranch,
        configPath: manifest.publication.configPath,
      },
      pullRequest: {
        number: manifest.publication.number,
        url: manifest.publication.url,
        state: "draft",
      },
      current: true,
    });
    const { validation } = validationRead.parse(
      await accepted(await page.request.get(new URL(`${proposalApi}/validation`, app).href), 200),
    );
    expect(validation).toMatchObject({
      id: manifest.validationId,
      proposalId,
      proposalRevisionId,
      base: manifest.baseline,
      candidate: manifest.candidate,
      targeted: { experimentId: manifest.targetedExperimentId },
      holdout: { experimentId: manifest.holdoutExperimentId },
    });
    const evidence = await expectEvidence(page, app, factoryApi, manifest);
    await captureQualificationEvidence(
      page,
      info,
      "01-retained-production-evidence-light",
      evidence,
    );
    await expect(page.locator("#candidate-diff:visible")).toContainText(manifest.candidate.digest);
    await expectComparisonLinks(adoptionPanel, app, manifest);
    const prLink = adoptionPanel.getByRole("link", {
      name: `GitHub pull request #${manifest.publication.number}`,
    });
    await expect(prLink).toHaveAttribute("href", manifest.publication.url);

    const baselinePin = await admitQualificationSession(manifest, "baseline", manifest.baseline);
    const adopt = adoptionPanel.getByRole("button", { name: "Adopt configuration" });
    await adopt.press("Enter");
    const confirm = page.getByRole("alertdialog", { name: "Adopt the reviewed configuration?" });
    await expect(confirm).toBeVisible();
    const [adoptionResponse] = await Promise.all([
      page.waitForResponse(
        (entry) => entry.url() === adoptionApi && entry.request().method() === "POST",
        { timeout: 110_000 },
      ),
      confirm.getByRole("button", { name: "Verify GitHub and adopt" }).press("Enter"),
    ]);
    expect(adoptionResponse.request().postDataJSON()).toEqual({
      publicationId: manifest.publication.id,
      expectedActivationNumber: manifest.baseline.activationNumber,
      candidateDigest: manifest.candidate.digest,
      headCommitSha: manifest.publication.headCommitSha,
    });
    const { adoption } = z
      .object({
        adoption: factoryImprovementAdoptionSchema,
        replay: z.literal(false),
      })
      .parse(await accepted(adoptionResponse, 201));
    expect(adoption).toMatchObject({
      proposalId,
      proposalRevisionId,
      publicationId: manifest.publication.id,
      validationId: manifest.validationId,
      baseline: manifest.baseline,
      adopted: { ...manifest.candidate, activationNumber: manifest.baseline.activationNumber + 1 },
      review: {
        repositoryNumericId: manifest.publication.repositoryNumericId,
        pullNumber: manifest.publication.number,
        pullUrl: manifest.publication.url,
        baseCommitSha: manifest.publication.baseCommitSha,
        headCommitSha: manifest.publication.headCommitSha,
      },
      comparisons: {
        targeted: { experimentId: manifest.targetedExperimentId },
        holdout: { experimentId: manifest.holdoutExperimentId },
      },
    });
    expect(Date.parse(adoption.review.reviewedAt)).toBeLessThanOrEqual(
      Date.parse(adoption.review.mergedAt),
    );
    await expect(adoptionPanel.getByText("Adopted", { exact: true })).toBeVisible();
    await expect(
      adoptionPanel.getByText(adoption.review.mergeCommitSha, { exact: true }),
    ).toBeVisible();
    await expect(
      adoptionPanel.getByText(`Approved on GitHub by ${adoption.review.reviewerLogin}`),
    ).toBeVisible();
    await captureQualificationEvidence(page, info, "02-exact-hosted-adoption-light", adoptionPanel);

    const adoptedPin = await admitQualificationSession(manifest, "adopted", adoption.adopted);
    await prepareQualificationRollbackSmoke(manifest, adoption.adopted);
    const rollbackTarget = `${workspaceFactoryDefinitionPath(workspaceSlug, {
      factory: factoryId,
      revision: manifest.baseline.revisionId,
      activation: manifest.baseline.activationNumber,
      restoreFrom: adoption.adopted.activationNumber,
    })}#candidate-tests`;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const outcomes = page.locator("#outcomes:visible");
    const rollback = outcomes.getByRole("link", { name: "Review rollback" });
    await expect(rollback).toHaveAttribute("href", rollbackTarget);
    await rollback.press("Enter");
    await expect(page).toHaveURL(new URL(rollbackTarget, app).href);
    const restore = page.getByRole("button", { name: "Roll back to this revision" });
    await expect(restore).toBeEnabled({ timeout: 35_000 });
    await restore.press("Enter");
    const restoreDialog = page.getByRole("alertdialog", { name: "Activate this revision?" });
    await expect(restoreDialog.getByText(manifest.baseline.digest, { exact: true })).toBeVisible();
    await captureQualificationEvidence(
      page,
      info,
      "03-shared-settings-rollback-dark-mobile",
      restoreDialog,
    );
    const [rollbackResponse] = await Promise.all([
      page.waitForResponse(
        (entry) => entry.url() === definitionApi && entry.request().method() === "POST",
      ),
      restoreDialog.getByRole("button", { name: "Activate revision" }).press("Enter"),
    ]);
    expect(rollbackResponse.request().postDataJSON()).toEqual({
      action: "rollback",
      expectedActivationNumber: adoption.adopted.activationNumber,
      revisionId: manifest.baseline.revisionId,
      targetActivationNumber: manifest.baseline.activationNumber,
    });
    const expectedRestore = {
      revisionId: manifest.baseline.revisionId,
      activationNumber: adoption.adopted.activationNumber + 1,
    };
    expect(await accepted(rollbackResponse, 201)).toMatchObject({
      activation: {
        ...expectedRestore,
        previousActivationNumber: adoption.adopted.activationNumber,
      },
    });
    const restoredPin = await admitQualificationSession(manifest, "restored", {
      ...expectedRestore,
      digest: manifest.baseline.digest,
    });
    const audit = await auditQualificationRollback(manifest, {
      baseline: baselinePin,
      adopted: adoptedPin,
      restored: restoredPin,
    });
    expect(audit).toMatchObject({
      adoptionId: adoption.id,
      baseline: adoption.baseline,
      candidate: adoption.adopted,
      restore: {
        eligible: false,
        receipt: {
          activationNumber: expectedRestore.activationNumber,
          previousActivationNumber: adoption.adopted.activationNumber,
          targetActivationNumber: manifest.baseline.activationNumber,
          targetRevisionId: manifest.baseline.revisionId,
        },
      },
    });
    await page.goto(workbench, { waitUntil: "domcontentloaded" });
    await expect(outcomes.getByText("Baseline restored", { exact: true })).toBeVisible();
    await expect(prLink).toHaveAttribute("href", manifest.publication.url);
    const retained = adoptionRead.parse(await accepted(await page.request.get(adoptionApi), 200));
    expect(retained.adoption).toEqual(adoption);
    await captureQualificationEvidence(page, info, "04-restored-outcomes-dark-mobile", outcomes);
  });
});
