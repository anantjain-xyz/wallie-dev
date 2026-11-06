// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OPEN_REVIEW_COMMENTS_EVENT } from "@/features/sessions/review/open-comments";
import { reviewEvidenceDeliverySchema } from "./review-evidence-contracts";
import { SessionReviewEvidence } from "./session-review-evidence";

const sessionId = "11111111-1111-4111-8111-111111111111";
const policyId = "33333333-3333-4333-8333-333333333333";
const observationId = "44444444-4444-4444-8444-444444444444";
const runId = "55555555-5555-4555-8555-555555555555";
const assetId = "66666666-6666-4666-8666-666666666666";
const sha = "a".repeat(40);
const baseSha = "b".repeat(40);

function delivery(overrides: Record<string, unknown> = {}) {
  return reviewEvidenceDeliverySchema.parse({
    requirements: {
      version: 1,
      deliveryMode: "code",
      requiredChecks: ["CI"],
      minimumApprovals: 1,
      requireCodeOwnerReview: false,
      requireResolvedThreads: true,
      requiredEvidence: ["tests"],
      freshnessSeconds: 3600,
      requireArtifactApprovalForDelivery: true,
    },
    policyRevisionId: policyId,
    finalStage: true,
    approvalGated: true,
    observationStale: false,
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
      repositoryFullName: "acme/app",
      repositoryUrl: "https://github.com/acme/app",
      number: 42,
      url: "https://github.com/acme/app/pull/42",
      state: "open",
      draft: false,
      headSha: sha,
      baseSha,
      observedAt: "2026-11-06T00:00:00Z",
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
      runId,
      commitSha: sha,
      validationTreeSha: baseSha,
      createdAt: "2026-11-06T00:00:00Z",
      required: [{ key: "tests", status: "passed" }],
      records: [
        {
          key: "tests",
          command: "pnpm test",
          provenance: "harness",
          status: "passed",
          exitCode: 0,
          startedAt: "2026-11-06T00:00:00Z",
          completedAt: "2026-11-06T00:01:00Z",
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
          id: assetId,
          key: "tests/report",
          kind: "report",
          required: true,
          sizeBytes: 128,
          downloadUrl: `/api/sessions/${sessionId}/validation-evidence/assets/${assetId}`,
        },
      ],
    },
    artifactBlockingCount: 0,
    refresh: {
      status: "current",
      lastErrorCode: null,
      updatedAt: "2026-11-06T00:01:00Z",
      canRefresh: true,
    },
    sourceObservationId: observationId,
    ...overrides,
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderPanel(overrides: { historical?: boolean } = {}) {
  return render(
    <SessionReviewEvidence
      historical={overrides.historical ?? false}
      initialNow="2026-11-06T00:02:00Z"
      sessionId={sessionId}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("SessionReviewEvidence", () => {
  it("shows server-owned readiness, identity, checks, reviews, and recorded evidence", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ delivery: delivery() })));
    renderPanel();
    expect(await screen.findByRole("heading", { name: "Delivery readiness" })).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByRole("link", { name: /acme\/app#42/ })).toHaveAttribute(
      "href",
      "https://github.com/acme/app/pull/42",
    );
    expect(screen.getByText(/Current-head approvals:/)).toHaveTextContent("1 of 1 required");
    expect(screen.getAllByText("tests", { selector: "code" }).length).toBeGreaterThan(0);
    expect(screen.getByText("Harness receipts")).toBeTruthy();
    expect(screen.getByRole("link", { name: /tests\/report/ })).toHaveAttribute(
      "href",
      `/api/sessions/${sessionId}/validation-evidence/assets/${assetId}`,
    );
    expect(screen.getByRole("link", { name: /Open GitHub checks/ })).toHaveAttribute(
      "href",
      "https://github.com/acme/app/pull/42/checks",
    );
    expect(screen.getByRole("button", { name: "Refresh verification" })).toBeEnabled();
  });

  it("lists each blocker with a source and labels a historical review", async () => {
    const blocked = delivery({
      evaluation: {
        state: "blocked",
        blockers: [
          { code: "github_required_check_failed", requirement: "CI" },
          { code: "artifact_blocking_feedback_open" },
          { code: "evidence_missing", requirement: "tests" },
        ],
        dimensions: {
          githubAccess: "passed",
          identity: "passed",
          checks: "blocked",
          reviews: "blocked",
          threads: "blocked",
          evidence: "blocked",
          mergeability: "passed",
        },
        summary: null,
      },
      artifactBlockingCount: 1,
      evidence: {
        ...(delivery().evidence ?? {}),
        required: [{ key: "tests", status: "missing" }],
        records: [],
        assets: [],
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ delivery: blocked })));
    const opened = vi.fn();
    window.addEventListener(OPEN_REVIEW_COMMENTS_EVENT, opened);
    renderPanel({ historical: true });

    expect(await screen.findByText(/Required check “CI” failed/)).toBeTruthy();
    expect(
      screen
        .getAllByRole("link", { name: /Open GitHub checks/ })
        .every(
          (link) => link.getAttribute("href") === "https://github.com/acme/app/pull/42/checks",
        ),
    ).toBe(true);
    expect(screen.getByRole("link", { name: "Review evidence" })).toHaveAttribute(
      "href",
      "#review-evidence-evidence",
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Open Comments" })[0]!);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("note")).toHaveTextContent("Historical view");
    window.removeEventListener(OPEN_REVIEW_COMMENTS_EVENT, opened);
  });

  it("flags a predecessor epoch without presenting its observation as current", async () => {
    const current = delivery();
    const stale = delivery({
      observationStale: true,
      pr: {
        ...current.pr!,
        headSha: null,
        baseSha: null,
        observedAt: null,
      },
      review: null,
      checks: [],
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ delivery: stale })));
    renderPanel();
    expect(await screen.findByText(/belongs to an earlier or unconfirmed PR epoch/)).toBeTruthy();
    expect(screen.getByText("Not yet observed")).toBeTruthy();
    expect(screen.getByText(/No GitHub review detail is recorded/)).toBeTruthy();
  });

  it("keeps a failed API read recoverable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ delivery: delivery() }));
    vi.stubGlobal("fetch", fetchMock);
    renderPanel();
    expect(await screen.findByRole("alert")).toHaveTextContent("Delivery evidence is unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Delivery readiness" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shows refresh failure recovery and pending state after requesting a refresh", async () => {
    let current = delivery({
      refresh: {
        status: "error",
        lastErrorCode: "github_refresh_failed",
        updatedAt: "2026-11-06T00:01:00Z",
        canRefresh: true,
      },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/pr-verification/refresh"))
        return jsonResponse({ queued: true }, 202);
      return jsonResponse({ delivery: current });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPanel();
    expect(await screen.findByText(/The last GitHub verification refresh failed/)).toBeTruthy();
    current = delivery({
      refresh: {
        status: "pending",
        lastErrorCode: null,
        updatedAt: "2026-11-06T00:02:00Z",
        canRefresh: true,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh verification" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(`/api/sessions/${sessionId}/pr-verification/refresh`, {
        method: "POST",
      }),
    );
    expect(await screen.findByText(/GitHub verification refresh is queued/)).toBeTruthy();
  });
});
