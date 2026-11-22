import { once } from "node:events";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";

import {
  expect,
  test,
  type APIResponse,
  type Locator,
  type Page,
  type Response,
} from "@playwright/test";
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
  claimImprovementQualificationStateFile,
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
  inspectQualificationProgress,
  observeQualificationPost,
  prepareQualificationRollbackSmoke,
  qualificationAppOrigin,
  qualificationCheckpoint,
  QualificationPostResponseLost,
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

test("refuses an altered publication or a different app origin before authentication", async () => {
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
  const directory = await mkdtemp(join(tmpdir(), "wallie-improvement-progress-"));
  try {
    const path = join(directory, "manifest.json");
    const store = qualificationCheckpoint(path, accepted);
    expect(await store.read()).toBeNull();
    const baseline = { ...accepted.baseline, sessionId: id(18), pinHash: "e".repeat(64) };
    await expect(
      store.save({
        baseline,
        rollbackRequest: {
          action: "rollback",
          expectedActivationNumber: 4,
          revisionId: accepted.baseline.revisionId,
          targetActivationNumber: 3,
        },
      }),
    ).rejects.toThrow("preceding operation");
    const adoptionRequest = {
      publicationId: accepted.publication.id,
      expectedActivationNumber: 3,
      candidateDigest: accepted.candidate.digest,
      headCommitSha: accepted.publication.headCommitSha,
    };
    await store.save({ baseline, adoptionRequest });
    expect(await qualificationCheckpoint(path, accepted).read()).toMatchObject({
      baseline,
      adoptionRequest,
    });
    await expect(
      qualificationCheckpoint(path, { ...accepted, validationId: id(19) }).read(),
    ).rejects.toThrow("different qualification manifest");
    await chmod(`${path}.browser-progress.json`, 0o644);
    await expect(store.read()).rejects.toThrow("private regular file");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("aborts the browser POST and drains its checkpoint after observation ends", async ({
  page,
}) => {
  let receivedPosts = 0;
  const server = createServer((request, response) => {
    if (request.method === "POST") receivedPosts += 1;
    response.end("qualification");
  });
  const persistenceStarted = Promise.withResolvers<void>();
  const completePersistence = Promise.withResolvers<void>();
  const unregistering = Promise.withResolvers<void>();
  const sent = Promise.withResolvers<boolean>();
  const cancellation = new Error("Simulated browser observation failure.");
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback address.");
    const origin = `http://127.0.0.1:${address.port}`;
    await page.goto(origin);
    const expected = { test: "qualification" };
    let finished = false;
    const operation = observeQualificationPost(
      {
        route: page.route.bind(page),
        unrouteAll: (...args) => {
          unregistering.resolve();
          return page.unrouteAll(...args);
        },
        waitForResponse: page.waitForResponse.bind(page),
      },
      `${origin}/submit`,
      expected,
      async () => {
        persistenceStarted.resolve();
        await completePersistence.promise;
      },
      async () => {
        sent.resolve(
          page.evaluate(
            (body) =>
              fetch("/submit", { method: "POST", body }).then(
                () => true,
                () => false,
              ),
            JSON.stringify(expected),
          ),
        );
        await persistenceStarted.promise;
        throw cancellation;
      },
    ).finally(() => {
      finished = true;
    });
    const rejected = expect(operation).rejects.toBe(cancellation);
    await unregistering.promise;
    await setImmediate();
    expect(finished).toBe(false);
    completePersistence.resolve();
    await rejected;
    expect(await sent.promise).toBe(false);
    expect(receivedPosts).toBe(0);
  } finally {
    completePersistence.resolve();
    await server[Symbol.asyncDispose]();
  }
});

const liveTest = test.extend<{ manifestPath: string }>({
  manifestPath: async ({}, providePath) => {
    const path = process.env.WALLIE_FACTORY_IMPROVEMENT_MANIFEST;
    if (!path) throw new Error("The live qualification manifest is required.");
    const lock = await claimImprovementQualificationStateFile(path);
    try {
      await providePath(path);
    } finally {
      await lock.close();
    }
  },
});

liveTest.describe("Live reviewed qualification", () => {
  liveTest.skip(
    !process.env.WALLIE_FACTORY_IMPROVEMENT_MANIFEST,
    "Requires the scoped OP642 manifest and a genuinely approved, merged draft.",
  );
  liveTest("qualifies reviewed adoption and rollback", async ({ page, manifestPath }, info) => {
    liveTest.setTimeout(240_000);
    const manifest = await readFactoryImprovementLoopManifest(manifestPath);
    const app = qualificationAppOrigin(manifest, process.env.PLAYWRIGHT_BASE_URL);
    const store = qualificationCheckpoint(manifestPath, manifest);
    const checkpoint = await store.read();
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
    const initial = await inspectQualificationProgress(manifest);
    expect(before.adoption).toEqual(initial.adoption);
    if (before.adoption && !checkpoint?.adoptionRequest) {
      throw new Error("The existing adoption has no recorded browser submission for this run.");
    }
    if (checkpoint?.adoption) expect(before.adoption).toEqual(checkpoint.adoption);
    if (initial.rollback && !checkpoint?.rollbackRequest) {
      throw new Error("The existing rollback has no recorded Settings submission for this run.");
    }
    if (checkpoint?.rollback) expect(initial.rollback).toEqual(checkpoint.rollback);
    const expectedRestore = {
      ...manifest.baseline,
      activationNumber: manifest.baseline.activationNumber + 2,
    };
    expect(initial.head).toEqual(
      initial.rollback ? expectedRestore : (before.adoption?.adopted ?? manifest.baseline),
    );
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
    });
    if (!before.adoption) {
      expect(before.publication?.current).toBe(true);
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
    }
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

    let progress =
      checkpoint ??
      (await store.save({
        baseline: await admitQualificationSession(manifest, "baseline", manifest.baseline),
      }));
    expect(progress.baseline).toMatchObject(manifest.baseline);
    const adoptionRequest = {
      publicationId: manifest.publication.id,
      expectedActivationNumber: manifest.baseline.activationNumber,
      candidateDigest: manifest.candidate.digest,
      headCommitSha: manifest.publication.headCommitSha,
    };
    if (progress.adoptionRequest) expect(progress.adoptionRequest).toEqual(adoptionRequest);
    let adoption = before.adoption;
    if (!adoption) {
      const retry = Boolean(progress.adoptionRequest);
      await adoptionPanel.getByRole("button", { name: "Adopt configuration" }).press("Enter");
      const confirm = page.getByRole("alertdialog", {
        name: "Adopt the reviewed configuration?",
      });
      await expect(confirm).toBeVisible();
      let response: Response | undefined;
      try {
        response = await observeQualificationPost(
          page,
          adoptionApi,
          adoptionRequest,
          async () => {
            progress = await store.save({ ...progress, adoptionRequest });
          },
          () => confirm.getByRole("button", { name: "Verify GitHub and adopt" }).press("Enter"),
        );
      } catch (error) {
        if (!(error instanceof QualificationPostResponseLost) || !progress.adoptionRequest)
          throw error;
        const durable = await inspectQualificationProgress(manifest);
        if (!durable.adoption) throw error;
        adoption = durable.adoption;
        await page.reload({ waitUntil: "domcontentloaded" });
      }
      if (response) {
        const status = retry && response.status() === 200 ? 200 : 201;
        adoption = z
          .object({
            adoption: factoryImprovementAdoptionSchema,
            replay: z.literal(status === 200),
          })
          .parse(await accepted(response, status)).adoption;
      }
    }
    if (!adoption) throw new Error("The exact adoption receipt is unavailable.");
    const adoptedProgress = await inspectQualificationProgress(manifest);
    expect(adoptedProgress.adoption).toEqual(adoption);
    expect(adoptedProgress.head).toEqual(
      adoptedProgress.rollback ? expectedRestore : adoption.adopted,
    );
    expect(adoption).toMatchObject({
      proposalId,
      proposalRevisionId,
      publicationId: manifest.publication.id,
      validationId: manifest.validationId,
      actorMemberId: adoptedProgress.actorMemberId,
      baseline: manifest.baseline,
      adopted: {
        ...manifest.candidate,
        activationNumber: manifest.baseline.activationNumber + 1,
      },
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
    progress = await store.save({ ...progress, adoption });
    await expect(adoptionPanel.getByText("Adopted", { exact: true })).toBeVisible();
    await expect(
      adoptionPanel.getByText(adoption.review.mergeCommitSha, { exact: true }),
    ).toBeVisible();
    await expect(
      adoptionPanel.getByText(`Approved on GitHub by ${adoption.review.reviewerLogin}`),
    ).toBeVisible();
    await captureQualificationEvidence(page, info, "02-exact-hosted-adoption-light", adoptionPanel);

    const adoptedPin =
      progress.adopted ?? (await admitQualificationSession(manifest, "adopted", adoption.adopted));
    expect(adoptedPin).toMatchObject(adoption.adopted);
    progress = await store.save({ ...progress, adopted: adoptedPin });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const outcomes = page.locator("#outcomes:visible");
    const rollbackRequest = {
      action: "rollback" as const,
      expectedActivationNumber: adoption.adopted.activationNumber,
      revisionId: manifest.baseline.revisionId,
      targetActivationNumber: manifest.baseline.activationNumber,
    };
    if (progress.rollbackRequest) expect(progress.rollbackRequest).toEqual(rollbackRequest);
    if (adoptedProgress.rollback && !progress.rollbackRequest) {
      throw new Error("The restored head has no recorded Settings submission for this run.");
    }
    if (!adoptedProgress.rollback) {
      await prepareQualificationRollbackSmoke(manifest, adoption.adopted);
      const rollbackTarget = `${workspaceFactoryDefinitionPath(workspaceSlug, {
        factory: factoryId,
        revision: manifest.baseline.revisionId,
        activation: manifest.baseline.activationNumber,
        restoreFrom: adoption.adopted.activationNumber,
      })}#candidate-tests`;
      const rollback = outcomes.getByRole("link", { name: "Review rollback" });
      await expect(rollback).toHaveAttribute("href", rollbackTarget);
      await rollback.press("Enter");
      await expect(page).toHaveURL(new URL(rollbackTarget, app).href);
      const restore = page.getByRole("button", { name: "Roll back to this revision" });
      await expect(restore).toBeEnabled({ timeout: 35_000 });
      await restore.press("Enter");
      const restoreDialog = page.getByRole("alertdialog", { name: "Activate this revision?" });
      await expect(
        restoreDialog.getByText(manifest.baseline.digest, { exact: true }),
      ).toBeVisible();
      await captureQualificationEvidence(
        page,
        info,
        "03-shared-settings-rollback-dark-mobile",
        restoreDialog,
      );
      let response: Response | undefined;
      try {
        response = await observeQualificationPost(
          page,
          definitionApi,
          rollbackRequest,
          async () => {
            progress = await store.save({ ...progress, rollbackRequest });
          },
          () => restoreDialog.getByRole("button", { name: "Activate revision" }).press("Enter"),
        );
      } catch (error) {
        if (
          !(error instanceof QualificationPostResponseLost) ||
          !progress.rollbackRequest ||
          !(await inspectQualificationProgress(manifest)).rollback
        ) {
          throw error;
        }
      }
      if (response) {
        expect(await accepted(response, 201)).toMatchObject({
          activation: {
            revisionId: expectedRestore.revisionId,
            activationNumber: expectedRestore.activationNumber,
            previousActivationNumber: adoption.adopted.activationNumber,
          },
        });
      }
    }
    const restored = await inspectQualificationProgress(manifest);
    expect(restored.adoption).toEqual(adoption);
    expect(restored.head).toEqual(expectedRestore);
    expect(restored.rollback).toMatchObject({
      activationNumber: expectedRestore.activationNumber,
      previousActivationNumber: adoption.adopted.activationNumber,
      targetActivationNumber: manifest.baseline.activationNumber,
      targetRevisionId: manifest.baseline.revisionId,
    });
    if (!restored.rollback) throw new Error("The exact rollback receipt is unavailable.");
    progress = await store.save({ ...progress, rollback: restored.rollback });
    const restoredPin = await admitQualificationSession(manifest, "restored", expectedRestore);
    const audit = await auditQualificationRollback(manifest, {
      baseline: progress.baseline,
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
