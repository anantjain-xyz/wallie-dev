import { expect, test, type Page } from "@playwright/test";

import { signIn } from "./helpers/auth";

const sessionPath = "/w/acme-corp/sessions/18";
const sha = "a".repeat(40);
const baseSha = "b".repeat(40);
const headMovedSha = "c".repeat(40);

const requirements = {
  version: 1,
  deliveryMode: "code",
  requiredChecks: ["CI"],
  minimumApprovals: 1,
  requireCodeOwnerReview: false,
  requireResolvedThreads: true,
  requiredEvidence: ["tests"],
  freshnessSeconds: 3600,
  requireArtifactApprovalForDelivery: true,
};

function readyDelivery() {
  return {
    requirements,
    policyRevisionId: "33333333-3333-4333-8333-333333333333",
    finalStage: true,
    approvalGated: true,
    evaluation: {
      state: "ready",
      blockers: [],
      dimensions: {
        githubAccess: "passed",
        identity: "passed",
        checks: "passed",
        reviews: "passed",
        threads: "passed",
        evidence: "passed",
        mergeability: "passed",
      },
      summary: {
        githubAccess: "available",
        checks: "passed",
        reviews: "passed",
        evidence: "passed",
        threads: "passed",
      },
    },
    pr: {
      repositoryFullName: "anantjain-xyz/wallie-dev",
      repositoryUrl: "https://github.com/anantjain-xyz/wallie-dev",
      number: 592,
      url: "https://github.com/anantjain-xyz/wallie-dev/pull/592",
      state: "open",
      draft: false,
      headSha: sha,
      baseSha,
      observedAt: new Date().toISOString(),
    },
    checks: [{ context: "CI", appId: null, sources: ["policy"], status: "passed" }],
    review: {
      decision: "APPROVED",
      currentHeadApprovals: 1,
      minimumApprovals: 1,
      codeOwnersRequired: false,
      requireResolvedThreads: true,
      unresolvedThreads: 0,
      mergeStateStatus: "CLEAN",
      protection: "verified",
    },
    evidence: {
      runId: "55555555-5555-4555-8555-555555555555",
      commitSha: sha,
      validationTreeSha: baseSha,
      createdAt: new Date().toISOString(),
      required: [{ key: "tests", status: "passed" }],
      records: [
        {
          key: "tests",
          command: "pnpm test",
          provenance: "harness",
          status: "passed",
          exitCode: 0,
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          completedAt: new Date().toISOString(),
          commitSha: sha,
          treeSha: baseSha,
          finalCommitSha: sha,
          finalTreeSha: baseSha,
          reportKeys: ["tests/report"],
          missingRequiredReports: [],
        },
      ],
      assets: [
        {
          id: "66666666-6666-4666-8666-666666666666",
          key: "tests/report",
          kind: "report",
          required: true,
          sizeBytes: 128,
          downloadUrl:
            "/api/sessions/11111111-1111-4111-8111-111111111111/validation-evidence/assets/66666666-6666-4666-8666-666666666666",
        },
      ],
    },
    artifactBlockingCount: 0,
    refresh: {
      status: "current",
      lastErrorCode: null,
      updatedAt: new Date().toISOString(),
      canRefresh: true,
    },
    sourceObservationId: "44444444-4444-4444-8444-444444444444",
  };
}

function blockedDelivery() {
  const ready = readyDelivery();
  return {
    ...ready,
    evaluation: {
      ...ready.evaluation,
      state: "blocked",
      blockers: [
        { code: "github_required_check_failed", requirement: "CI" },
        { code: "github_review_threads_unresolved" },
        { code: "evidence_missing", requirement: "tests" },
        { code: "artifact_blocking_feedback_open" },
      ],
      summary: null,
    },
    evidence: {
      ...ready.evidence,
      required: [{ key: "tests", status: "missing" }],
      records: [],
      assets: [],
    },
    artifactBlockingCount: 1,
    refresh: { ...ready.refresh, status: "error", lastErrorCode: "github_refresh_failed" },
  };
}

function largeDiff() {
  return {
    repositoryFullName: "anantjain-xyz/wallie-dev",
    prNumber: 592,
    url: "https://github.com/anantjain-xyz/wallie-dev/pull/592",
    headSha: headMovedSha,
    baseSha,
    state: "open",
    draft: false,
    files: [
      {
        filename: "src/features/sessions/detail/session-review-evidence.tsx",
        previousFilename: null,
        status: "modified",
        additions: 2,
        deletions: 1,
        changes: 3,
        patch: "@@ -1,3 +1,4 @@\n-removed line\n+added line\n+another line\n context",
        patchTruncated: true,
        patchUnavailable: false,
        blobUrl:
          "https://github.com/anantjain-xyz/wallie-dev/blob/head/src/features/sessions/detail/session-review-evidence.tsx",
      },
      {
        filename: "public/preview.png",
        previousFilename: null,
        status: "modified",
        additions: 0,
        deletions: 0,
        changes: 0,
        patch: null,
        patchTruncated: false,
        patchUnavailable: true,
        blobUrl: null,
      },
    ],
    additions: 2,
    deletions: 1,
    hasMore: true,
    truncated: true,
    limits: { maxFiles: 100, maxPatchLines: 400, maxPatchCharacters: 24000 },
  };
}

async function mockReadiness(
  page: Page,
  delivery: ReturnType<typeof readyDelivery> | ReturnType<typeof blockedDelivery>,
  approvalState = delivery.evaluation.state,
) {
  await page.route(/\/api\/sessions\/[^/]+\/review-evidence$/, (route) =>
    route.fulfill({ json: { delivery } }),
  );
  await page.route(/\/api\/sessions\/[^/]+\/approval-review$/, (route) =>
    route.fulfill({
      json: {
        reviewRevision: 7,
        blockingCount: delivery.artifactBlockingCount,
        delivery: {
          required: true,
          state: approvalState === "ready" ? "ready" : approvalState,
          blockers: delivery.evaluation.blockers,
        },
      },
    }),
  );
}

test("ready state renders identity, checks, evidence, and an enabled approval", async ({
  page,
}, testInfo) => {
  await mockReadiness(page, readyDelivery());
  await signIn(page, sessionPath);
  await expect(page.getByRole("heading", { name: "Delivery readiness" })).toBeVisible();
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /wallie-dev#592/ })).toBeVisible();
  await expect(page.getByText(/Current-head approvals:/)).toContainText("1 of 1 required");
  await expect(page.getByRole("link", { name: /tests\/report/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve stage" })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("op509-ready-desktop.png"), fullPage: true });
});

test("historical blocked view lists sources and bounded large/binary diffs", async ({
  page,
}, testInfo) => {
  await mockReadiness(page, blockedDelivery());
  await page.route(/\/api\/sessions\/[^/]+\/review-evidence\/diff$/, (route) =>
    route.fulfill({ json: { diff: largeDiff() } }),
  );
  await signIn(page, sessionPath);
  await expect(page.getByText(/Required check “CI” failed/)).toBeVisible();
  await expect(page.getByRole("link", { name: /Open GitHub checks/ }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve stage" })).toBeDisabled();
  await page.getByRole("button", { name: /^Plan:/ }).click();
  await expect(page.getByRole("note")).toContainText("Historical view");
  await page.getByRole("button", { name: "Show code changes" }).click();
  await expect(page.getByText(/Current canonical PR diff/)).toBeVisible();
  await expect(page.getByText(/Only the first 100 changed files/)).toBeVisible();
  await expect(page.getByText(/binary or too large/)).toBeVisible();
  await expect(page.getByText(/This file's diff is truncated/)).toBeVisible();
  await expect(page.getByText(/Refresh delivery readiness before approving/)).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("op509-blocked-desktop.png"),
    fullPage: true,
  });
});

test("readiness API failure is recoverable and refresh pending is visible", async ({ page }) => {
  await page.route(/\/api\/sessions\/[^/]+\/review-evidence$/, (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
  await signIn(page, sessionPath);
  await expect(
    page.getByRole("alert").filter({ hasText: "Delivery evidence is unavailable" }),
  ).toBeVisible();
  await page.unroute(/\/api\/sessions\/[^/]+\/review-evidence$/);
  await mockReadiness(page, readyDelivery());
  await page
    .getByRole("alert")
    .filter({ hasText: "Delivery evidence is unavailable" })
    .getByRole("button", { name: "Retry" })
    .click();
  await expect(page.getByRole("heading", { name: "Delivery readiness" })).toBeVisible();

  await page.route(/\/api\/sessions\/[^/]+\/pr-verification\/refresh$/, (route) =>
    route.fulfill({ status: 202, json: { queued: true } }),
  );
  await page.unroute(/\/api\/sessions\/[^/]+\/review-evidence$/);
  await page.route(/\/api\/sessions\/[^/]+\/review-evidence$/, (route) =>
    route.fulfill({
      json: {
        delivery: {
          ...readyDelivery(),
          refresh: { ...readyDelivery().refresh, status: "pending" },
        },
      },
    }),
  );
  await page.getByRole("button", { name: "Refresh verification" }).click();
  await expect(page.getByText(/GitHub verification refresh is queued/)).toBeVisible();
});

test("390px layout keeps the readiness panel and diff controls usable", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockReadiness(page, readyDelivery());
  await page.route(/\/api\/sessions\/[^/]+\/review-evidence\/diff$/, (route) =>
    route.fulfill({ json: { diff: largeDiff() } }),
  );
  await signIn(page, sessionPath);
  await expect(page.getByRole("heading", { name: "Delivery readiness" })).toBeVisible();
  await page.getByRole("button", { name: "Show code changes" }).click();
  await expect(page.getByText(/Only the first 100 changed files/)).toBeVisible();
  const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(documentWidth).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("op509-ready-mobile.png"), fullPage: true });
});
