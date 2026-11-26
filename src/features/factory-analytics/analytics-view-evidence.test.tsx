// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import { recoverAnalyticsFilters } from "./analytics-query";
import { AnalyticsEvidence } from "./analytics-view-evidence";

it("pins a lifecycle evidence link to the recorded attempt and omits unscheduled attempts", () => {
  const { query } = recoverAnalyticsFilters({
    from: "2026-11-01",
    to: "2026-11-08",
    metric: "flow",
    facet: "active",
  });
  const from = "2026-11-03T11:00:00Z";
  const to = "2026-11-03T12:00:00Z";
  const observation = {
    id: "active",
    eventType: "run.started",
    occurredAt: from,
    observedAt: from,
    jobId: null,
    runId: "retained",
    attemptCount: 2,
    artifactId: null,
  };
  render(
    <AnalyticsEvidence
      bucketLabel={undefined}
      query={query}
      evidence={{
        status: "ready",
        data: {
          metric: "flow",
          metricRevision: 1,
          nextCursor: null,
          sessionNumbers: { session: 71 },
          items: [
            {
              sessionId: "session",
              phase: "active",
              status: "measured",
              startedAt: from,
              endedAt: to,
              sourceStartedAt: from,
              sourceEndedAt: to,
              seconds: 3600,
              observationIds: [observation.id],
              observations: [
                observation,
                { ...observation, id: "queued", runId: "unscheduled", attemptCount: 0 },
              ],
            },
          ],
        },
      }}
      href={() => "/w/demo/analytics"}
      labels={{ buckets: new Map(), runStages: new Map([["retained", "Delivery"]]) }}
      workspaceSlug="demo"
    />,
  );
  screen
    .getByText("Lifecycle observations", { exact: true })
    .closest("details")
    ?.setAttribute("open", "");
  expect(screen.getByRole("link", { name: /^Open run · attempt 2 · Delivery/ })).toHaveAttribute(
    "href",
    "/w/demo/runs/retained?attempt=2",
  );
  expect(screen.getByRole("link", { name: /^Open run · (?!attempt)/ })).toHaveAttribute(
    "href",
    "/w/demo/runs/unscheduled",
  );
});
