// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import type { AnalyticsPeriodData } from "./analytics-data";
import { AnalyticsHighlights } from "./analytics-view-metrics";

const window = { from: "2026-11-01T00:00:00Z", to: "2026-11-08T00:00:00Z" };
const unavailable = { status: "unavailable" } as const;
const blank = {
  window,
  flow: unavailable,
  cost: unavailable,
  throughput: unavailable,
  revert: unavailable,
};

function throughput({ partial, evaluatedAt }: { partial: boolean; evaluatedAt?: string }) {
  return {
    status: "ready",
    data: {
      window,
      dimension: "source",
      observedMergeCount: 0,
      mixedMergeCount: 0,
      partialMergeCount: 0,
      bucketMembershipCount: 0,
      bucketCount: 0,
      bucketsTruncated: false,
      omittedBucketMembershipCount: 0,
      buckets: [],
      coverage: { captureStartedAt: window.from, unresolvedMergeCount: 0, partial },
      evaluatedAt: evaluatedAt ?? "2026-11-09T00:00:00Z",
      metricKey: "canonical_merge_throughput",
      metricRevision: 1,
    },
  } satisfies AnalyticsPeriodData["throughput"];
}

afterEach(cleanup);

it("reports an observed zero only when merge coverage is complete", () => {
  render(<AnalyticsHighlights period={{ ...blank, throughput: throughput({ partial: false }) }} />);
  expect(screen.getByText("0", { exact: true })).toBeVisible();
  expect(screen.getByText("Observed merges")).toBeVisible();
  expect(screen.getByRole("link", { name: "PR throughput" })).toHaveAttribute(
    "href",
    "#throughput",
  );
});

it.each([throughput({ partial: true }), throughput({ partial: false, evaluatedAt: window.from })])(
  "does not label missing coverage as zero (%j)",
  (result) => {
    render(<AnalyticsHighlights period={{ ...blank, throughput: result }} />);
    expect(screen.getByText("Incomplete")).toBeVisible();
    expect(screen.getByText("Partial merge coverage")).toBeVisible();
    expect(screen.queryByText("0", { exact: true })).not.toBeInTheDocument();
  },
);

it("has no numeric fallback when the metric reads are unavailable", () => {
  render(<AnalyticsHighlights period={blank} />);
  expect(screen.getAllByText("Unavailable", { exact: true })).toHaveLength(5);
  expect(screen.queryByText("0", { exact: true })).not.toBeInTheDocument();
});
