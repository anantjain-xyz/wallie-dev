// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { AnalyticsFilters } from "./analytics-filters";
import { recoverAnalyticsFilters } from "./analytics-query";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const factoryId = "58200000-0000-4000-8000-000000000001";
const action = "/w/demo/analytics";

afterEach(cleanup);

it("marks rejected comparison, dimension and environment controls with their errors", () => {
  const recovered = recoverAnalyticsFilters({
    from: "2026-11-01",
    to: "2026-11-08",
    compare: "last",
    dimension: "unsupported",
    environment: "Production",
  });
  render(
    <AnalyticsFilters
      {...recovered}
      action={action}
      environments={["production"]}
      factoryId={factoryId}
      scorerFields={{}}
    />,
  );
  for (const [control, message] of [
    [
      screen.getByRole("checkbox", { name: "Compare with previous period" }),
      /The previous period is invalid/,
    ],
    [
      screen.getByRole("combobox", { name: "Break down throughput by" }),
      /Select a supported throughput breakdown/,
    ],
    [
      screen.getByRole("combobox", { name: "Deployment environment" }),
      /Choose a deployment environment/,
    ],
  ] as const) {
    expect(control).toHaveAttribute("aria-invalid", "true");
    expect(control).toHaveAccessibleDescription(message);
  }
});

it.each([
  { from: "2026-11-08", to: "2026-11-07" },
  { from: "", to: "" },
])("keeps displayed date drafts when clearing a saved environment ($from, $to)", (dates) => {
  const recovered = recoverAnalyticsFilters({
    ...dates,
    factory: factoryId,
    environment: "retired",
  });
  render(
    <AnalyticsFilters
      {...recovered}
      action={action}
      environments={["production"]}
      factoryId={factoryId}
      scorerFields={{}}
    />,
  );
  const clear = screen.getByRole("link", { name: "Clear environment" });
  const query = new URL(clear.getAttribute("href") ?? "", "http://localhost").searchParams;
  expect(query.get("factory")).toBe(factoryId);
  expect(query.get("from")).toBe(dates.from);
  expect(query.get("to")).toBe(dates.to);
  expect(query.has("environment")).toBe(false);
});
