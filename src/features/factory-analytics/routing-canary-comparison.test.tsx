// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { RoutingCanaryAlert } from "@/lib/model-routing/canary-alert";
import type { RoutingCanaryReport } from "@/lib/model-routing/canary-report";

import { RoutingCanaryComparison } from "./routing-canary-comparison";
import { loadRoutingCanaryComparison } from "./routing-canary-data";

const id = (value: number) => `10000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const first = "2026-11-20T10:00:00Z";
const last = "2026-11-20T11:00:00Z";
const baseline = {
  assignedSessions: 12,
  startedSessions: 10,
  startedAttempts: 14,
  succeededAttempts: 9,
  failedAttempts: 3,
  canceledAttempts: 2,
  pendingAttempts: 0,
  overriddenSessions: 0,
  fallbackSessions: 0,
  exposureMismatchSessions: 0,
  measuredCostAttempts: 14,
  estimatedCostAttempts: 0,
  unavailableCostAttempts: 0,
  pendingCostAttempts: 0,
  knownSpendUsd: 2.5,
  completeSpendSessions: 5,
  meanSpendUsd: 0.3,
  knownLatencySessions: 6,
  meanLatencyMs: 25_000,
  scoredSessions: 6,
  scorePasses: 4,
  scoreFailures: 2,
  scoreInconclusiveSessions: 1,
  scorePendingSessions: 2,
  scoreNotSampledSessions: 3,
  unavailableScoreSessions: 6,
  meanNumericScore: null,
};
const report: RoutingCanaryReport = {
  canary: {
    id: id(1),
    activationNumber: 8,
    baselineActivationNumber: 7,
    candidateRevisionId: id(8),
    baselineRevisionId: id(7),
    taskClassId: id(2),
    taskClassSlug: "invoice-delivery",
    candidateBps: 1_275,
    minimumSupport: 5,
    createdAt: first,
    scorerRevisionId: id(3),
  },
  window: { from: first, to: last, asOf: last },
  status: "comparable",
  reasons: [],
  outsideClassSessions: 4,
  baseline,
  candidate: { ...baseline, scorePasses: 5, scoreFailures: 1, meanSpendUsd: 0.25 },
};

const alert: RoutingCanaryAlert = {
  id: id(10),
  canaryId: report.canary.id,
  activationNumber: report.canary.activationNumber,
  ruleId: id(4),
  evidenceDraftId: id(5),
  evidence: {
    version: 1,
    experimentId: id(11),
    candidateKey: "a".repeat(64),
    suite: { id: id(12), revisionId: id(13), purpose: "holdout", name: "Invoices" },
    scorerRevisionId: id(3),
    scorerName: "Invoice quality",
    taskClassName: "Invoice delivery",
    definitionDigest: "b".repeat(64),
    replayPolicyRevisionId: id(14),
    replayPolicyDigest: "c".repeat(64),
    ruleId: id(4),
    capturedAt: first,
    qualityPassRateBps: 8000,
    resolvedTrials: 5,
    measuredMeanCostUsd: "0.08",
    constraints: {
      qualityFloorBps: 8000,
      maxMeanCostUsd: null,
      maxLatencyMs: null,
      minResolvedTrials: 5,
      minConfidenceBps: null,
    },
    p95WallLatencyMs: 22000,
    isRecommended: true,
  },
  thresholdRevision: 1,
  metric: "spend",
  thresholdBps: 2500,
  baselineValue: 0.3,
  candidateValue: 0.4,
  baselineSupport: 5,
  candidateSupport: 5,
  observedAt: last,
  report: { ...report, candidate: { ...report.candidate, meanSpendUsd: 0.4 } },
};

afterEach(cleanup);

it("shows assigned arms, support, retry-inclusive usage and links to exact revisions", () => {
  render(
    <RoutingCanaryComparison
      canManageFactory
      factoryId={id(9)}
      state={{ kind: "ready", report }}
      workspaceSlug="acme"
    />,
  );
  const region = within(screen.getByRole("region", { name: "Routing canary" }));
  expect(region.getByText("invoice-delivery · 12.75% candidate share target")).toBeVisible();
  expect(
    region.getByText(
      "Minimum support of 5 sessions per group. 4 sessions outside this task class.",
    ),
  ).toBeVisible();
  expect(region.getByText("Comparable")).toBeVisible();
  expect(region.getByRole("link", { name: "Activation #7" })).toHaveAttribute(
    "href",
    `/w/acme/settings/factory-definition?factory=${id(9)}&revision=${report.canary.baselineRevisionId}&activation=7#revision-history`,
  );
  expect(region.getByRole("link", { name: "Activation #8" })).toHaveAttribute(
    "href",
    `/w/acme/settings/factory-definition?factory=${id(9)}&revision=${report.canary.candidateRevisionId}&activation=8#revision-history`,
  );
  const attempts = within(region.getByRole("row", { name: /Run attempts/ }));
  expect(attempts.getAllByText("14")).toHaveLength(2);
  expect(attempts.getAllByText(/3 failed/)).toHaveLength(2);
  const rate = within(region.getByRole("row", { name: /Scored pass rate/ }));
  expect(rate.getByText("66.67%")).toBeVisible();
  expect(rate.getByText("83.33%")).toBeVisible();
  const spend = within(region.getByRole("row", { name: /Known spend/ }));
  expect(spend.getAllByText(/14 measured attempts/)).toHaveLength(2);
});

it("distinguishes unavailable measurements from zero and explains an inconclusive comparison", () => {
  const inconclusive: RoutingCanaryReport = {
    ...report,
    reasons: ["insufficient_quality", "incomplete_usage", "exposure_deviations"],
    status: "inconclusive",
    candidate: {
      ...report.candidate,
      scoredSessions: 0,
      scorePasses: 0,
      scoreFailures: 0,
      unavailableScoreSessions: 12,
      knownSpendUsd: null,
      meanSpendUsd: null,
      completeSpendSessions: 0,
      overriddenSessions: 2,
      fallbackSessions: 2,
      exposureMismatchSessions: 0,
      measuredCostAttempts: 0,
      unavailableCostAttempts: 13,
      pendingCostAttempts: 1,
    },
  };
  render(
    <RoutingCanaryComparison
      factoryId={id(9)}
      state={{ kind: "ready", report: inconclusive }}
      workspaceSlug="acme"
    />,
  );
  const region = within(screen.getByRole("region", { name: "Routing canary" }));
  expect(region.getByText("Inconclusive", { exact: true })).toBeVisible();
  expect(
    within(region.getByRole("list", { name: "Comparison limits" })).getAllByRole("listitem"),
  ).toHaveLength(3);
  expect(
    region.getByText(
      "Some sessions have a routing override, a fallback, or missing or mismatched execution evidence.",
    ),
  ).toBeVisible();
  const routingEvidence = within(region.getByRole("row", { name: /Routing evidence/ }));
  expect(routingEvidence.getAllByText("0 unverified or mismatched")).toHaveLength(2);
  expect(routingEvidence.getByText("2 overrides · 2 fallbacks")).toBeVisible();
  expect(
    within(region.getByRole("row", { name: /Scored pass rate/ })).getByText("Unavailable"),
  ).toBeVisible();
  const spend = within(region.getByRole("row", { name: /Known spend/ }));
  expect(spend.getByText("Unavailable")).toBeVisible();
  expect(spend.getByText(/13 unavailable · 1 pending/)).toBeVisible();
  expect(region.queryByRole("link")).toBeNull();
  expect(region.getByText(report.canary.candidateRevisionId)).toBeVisible();
});

it("keeps a missing exact comparison unavailable", () => {
  render(
    <RoutingCanaryComparison
      factoryId={id(9)}
      state={{ kind: "unavailable" }}
      workspaceSlug="acme"
    />,
  );
  expect(screen.getByText("This canary comparison is unavailable.")).toBeVisible();
  expect(screen.queryByRole("table")).toBeNull();
});

it("links the live report to the exact retained alert while keeping live metrics", () => {
  const href = `/w/acme/analytics?factory=${id(9)}&routingCanary=${alert.canaryId}&routingAlert=${alert.id}#routing-canary`;
  render(
    <RoutingCanaryComparison
      factoryId={id(9)}
      latestAlertHref={href}
      state={{ kind: "ready", report, latestAlert: alert }}
      workspaceSlug="acme"
    />,
  );
  expect(screen.getByRole("link", { name: "View retained alert evidence" })).toHaveAttribute(
    "href",
    href,
  );
  expect(screen.getByText("$0.25")).toBeVisible();
  expect(screen.queryByRole("region", { name: "Retained routing alert evidence" })).toBeNull();
});

it.each([true, false])(
  "renders retained spending, scorer and benchmark evidence with rollback access %s",
  (canManageFactory) => {
    render(
      <RoutingCanaryComparison
        canManageFactory={canManageFactory}
        factoryId={id(9)}
        state={{ kind: "retained", alert }}
        workspaceSlug="acme"
      />,
    );
    const evidence = within(
      screen.getByRole("region", { name: "Retained routing alert evidence" }),
    );
    expect(evidence.getByText("At least 25% higher")).toBeVisible();
    expect(evidence.getByText("$0.40 · 5 supporting sessions")).toBeVisible();
    expect(evidence.getByText(alert.ruleId)).toBeVisible();
    expect(evidence.getByText(alert.evidence.scorerRevisionId)).toBeVisible();
    expect(
      evidence.getByRole("link", { name: "Open exact benchmark configuration" }),
    ).toHaveAttribute(
      "href",
      expect.stringContaining(`#frontier-configuration-${alert.evidence.candidateKey}`),
    );
    expect(evidence.getByRole("link", { name: "Open frozen suite revision" })).toHaveAttribute(
      "href",
      expect.stringContaining(`revision=${alert.evidence.suite.revisionId}`),
    );
    const rollback = evidence.queryByRole("link", { name: "Review rollback" });
    if (canManageFactory) {
      expect(rollback).toHaveAttribute(
        "href",
        `/w/acme/settings/factory-definition?factory=${id(9)}&revision=${report.canary.baselineRevisionId}&activation=7#revision-history`,
      );
    } else {
      expect(rollback).toBeNull();
    }
  },
);

it("loads only the exact retained alert and refuses a mismatched receipt", async () => {
  const rpc = vi.fn().mockResolvedValue({ data: alert, error: null });
  const scope = {
    workspaceId: id(20),
    factoryId: id(9),
    canaryId: alert.canaryId,
    alertId: alert.id,
  };
  await expect(loadRoutingCanaryComparison({ rpc }, scope)).resolves.toEqual({
    kind: "retained",
    alert,
  });
  expect(rpc).toHaveBeenCalledExactlyOnceWith("get_factory_routing_canary_alert", {
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    p_canary_id: scope.canaryId,
    p_alert_id: scope.alertId,
  });
  await expect(
    loadRoutingCanaryComparison({ rpc }, { ...scope, canaryId: id(22) }),
  ).resolves.toEqual({ kind: "unavailable", alertRequested: true });
});
