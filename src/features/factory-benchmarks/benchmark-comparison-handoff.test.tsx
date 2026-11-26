// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import {
  BenchmarkComparisonSchedule,
  comparisonScheduleHandoff,
} from "./benchmark-comparison-schedule";
import { BenchmarkComparisonTrialFocus } from "./benchmark-comparison-trial-focus";

const trialId = "61900000-0000-4000-8000-000000000032";
const otherTrialId = "61900000-0000-4000-8000-000000000033";
const endpoint = "/api/example/schedule";
const pin = {
  qualification_id: "receipt",
  live_inference_connection_revision: "connection-at-freeze",
  sandbox_connection_revision: "sandbox-at-freeze",
  worker_runtime: "workerd",
};
const comparison = {
  scheduleState: "unconfigured" as const,
  counts: { eligible: 2 },
  candidateCount: 2,
};

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

it("offers no browser mutations and only hands off the exact authorized schedule pins", () => {
  const input = {
    comparison,
    endpoint,
    policyProfile: "blocked",
    pins: [pin, pin],
  };
  const allowed = comparisonScheduleHandoff({ ...input, canConfigure: true });
  const denied = comparisonScheduleHandoff({ ...input, canConfigure: false });
  const { rerender } = render(
    <BenchmarkComparisonSchedule state="unconfigured" handoff={denied} />,
  );
  expect(screen.getByRole("heading", { name: "Trials haven’t started" })).toBeVisible();
  expect(screen.queryByText(endpoint)).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /runbook/ })).not.toBeInTheDocument();

  rerender(<BenchmarkComparisonSchedule state="unconfigured" handoff={allowed} />);
  expect(screen.getByRole("link", { name: /runbook/ })).toBeVisible();
  expect(screen.getByText(/not a hard cap on provider charges/)).toBeVisible();
  expect(screen.getByText(pin.live_inference_connection_revision)).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it("does not offer a setup handoff for mixed, missing, or ineligible pins", () => {
  for (const pins of [
    [pin],
    [pin, { ...pin, live_inference_connection_revision: "another-revision" }],
    [pin, { ...pin, worker_runtime: "node" }],
  ]) {
    expect(
      comparisonScheduleHandoff({
        comparison,
        endpoint,
        policyProfile: "blocked",
        pins,
        canConfigure: true,
      }),
    ).toMatchObject({ kind: "blocked" });
  }
  expect(
    comparisonScheduleHandoff({
      comparison: { ...comparison, counts: { eligible: 0 } },
      endpoint,
      policyProfile: "blocked",
      pins: [pin, pin],
      canConfigure: true,
    }),
  ).toMatchObject({ kind: "blocked" });
});

it.each([true, false])(
  "focuses only a visible trial on the authorized cursor page (visible: %s)",
  (visible) => {
    const hash = `#trial-${visible ? trialId : otherTrialId}`;
    window.history.replaceState(null, "", `/comparison?afterTrialId=${trialId}${hash}`);
    render(
      <>
        <a id={`trial-${otherTrialId}`} href="/outside">
          Unrelated link
        </a>
        <section id="comparison-trials" aria-label="Trials">
          <BenchmarkComparisonTrialFocus pageKey={trialId} />
          <a id={`trial-${trialId}`} href="/evidence">
            Invoice task · Baseline
          </a>
        </section>
      </>,
    );
    expect(
      visible
        ? screen.getByRole("link", { name: /Invoice task/ })
        : screen.getByRole("region", { name: "Trials" }),
    ).toHaveFocus();
    expect(window.location.search).toBe(`?afterTrialId=${trialId}`);
  },
);
