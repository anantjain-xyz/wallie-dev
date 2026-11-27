// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import type { AnalyticsPeriodData } from "./analytics-data";
import { recoverAnalyticsFilters } from "./analytics-query";
import { AnalyticsHighlights, AnalyticsMetrics } from "./analytics-view-metrics";

const window = { from: "2026-11-01T00:00:00Z", to: "2026-11-08T00:00:00Z" };
const unavailable = { status: "unavailable" } as const;
const blank = {
  window,
  flow: unavailable,
  cost: unavailable,
  throughput: unavailable,
  revert: unavailable,
};
const retryHref = "/w/example/analytics?factory=example";

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
  render(
    <AnalyticsHighlights
      period={{ ...blank, throughput: throughput({ partial: false }) }}
      retryHref={retryHref}
    />,
  );
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
    render(<AnalyticsHighlights period={{ ...blank, throughput: result }} retryHref={retryHref} />);
    expect(screen.getByText(/No data for: PR throughput/)).toBeVisible();
    expect(screen.getByText(/PR capture doesn’t cover the full date range/)).toBeVisible();
    expect(screen.queryByText("0", { exact: true })).not.toBeInTheDocument();
  },
);

it("shows one retry for failed reads rather than treating them as empty", () => {
  render(<AnalyticsHighlights period={blank} retryHref={retryHref} />);
  expect(screen.getByText(/Outcome reports couldn’t load/)).toBeVisible();
  expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute("href", retryHref);
  expect(screen.queryByText(/No outcome data/)).not.toBeInTheDocument();
  expect(screen.queryByText("0", { exact: true })).not.toBeInTheDocument();
});

it("keeps controls and evidence anchors without rendering empty comparison tables", () => {
  const href = (selection?: { metric: string }) => `?metric=${selection?.metric}`;
  const { query } = recoverAnalyticsFilters({});
  const { container } = render(
    <AnalyticsMetrics
      periods={{ primary: blank, comparison: null }}
      href={href}
      query={query}
      bucketLabels={new Map()}
      dimensionFilter={<button>Throughput breakdown</button>}
      environmentFilter={<button>Deployment environment</button>}
    />,
  );
  expect(screen.queryByRole("table", { hidden: true })).not.toBeInTheDocument();
  const details = container.querySelector("details")!;
  expect(details.open).toBe(false);
  details.open = true;
  expect(screen.getByRole("button", { name: "Throughput breakdown" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Deployment environment" })).toBeVisible();
  expect(screen.getByRole("link", { name: "Work flow evidence" })).toHaveAttribute(
    "href",
    "?metric=flow",
  );
});

it("keeps a covered comparison period visible without interpreting partial empty data as zero", () => {
  const { query } = recoverAnalyticsFilters({});
  render(
    <AnalyticsMetrics
      periods={{
        primary: { ...blank, throughput: throughput({ partial: true }) },
        comparison: { ...blank, throughput: throughput({ partial: false }) },
      }}
      href={() => "#evidence"}
      query={query}
      bucketLabels={new Map()}
      dimensionFilter={null}
      environmentFilter={null}
    />,
  );
  const table = within(
    screen.getByRole("table", { name: "Pull request throughput comparison table" }),
  );
  expect(table.getByText("Incomplete coverage")).toBeVisible();
  expect(table.getByText("0", { exact: true })).toBeVisible();
});
