// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { recoverAnalyticsFilters } from "./analytics-query";
import { AnalyticsReportingFilters } from "./analytics-reporting-filters";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const factoryId = "58200000-0000-4000-8000-000000000001";
const action = "/w/demo/analytics";

afterEach(cleanup);

it("keeps the applied factory and other dimensions in the native date form", () => {
  const { query } = recoverAnalyticsFilters({
    from: "2026-11-01",
    to: "2026-11-08",
    dimension: "model",
    environment: "production",
  });
  render(
    <AnalyticsReportingFilters
      action={action}
      environments={["production"]}
      factoryId={factoryId}
      mode="period"
      query={query}
      scorerFields={{}}
    />,
  );
  const from = screen.getByLabelText("From date (UTC)", { exact: true });
  const form = from.closest("form")!;
  expect(form).toHaveAttribute("action", action);
  expect(form).toHaveAttribute("method", "get");
  expect(Object.fromEntries(new FormData(form))).toEqual({
    factory: factoryId,
    from: "2026-11-01",
    to: "2026-11-08",
    dimension: "model",
    environment: "production",
  });
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
});

it("offers loaded deployment environments in the Analytics form", () => {
  const { query } = recoverAnalyticsFilters({});
  render(
    <AnalyticsReportingFilters
      action={action}
      environments={["production"]}
      factoryId={factoryId}
      mode="environment"
      query={query}
      scorerFields={{}}
    />,
  );
  const environment = screen.getByRole("combobox", { name: "Deployment environment" });
  expect(environment.closest("form")).toHaveAttribute("action", action + "#time-to-delivery");
  expect(
    screen.queryByRole("combobox", { name: "Break down throughput by" }),
  ).not.toBeInTheDocument();
  fireEvent.click(environment);
  expect(screen.getByRole("option", { name: "production" })).toBeVisible();
  expect(screen.queryByText(/Could not load deployment environments/)).not.toBeInTheDocument();
});

it("reports a failed environment read in the Analytics form without calling it stale", () => {
  const { query } = recoverAnalyticsFilters({ environment: "production" });
  render(
    <AnalyticsReportingFilters
      action={action}
      environments={null}
      factoryId={factoryId}
      query={query}
      scorerFields={{}}
    />,
  );
  expect(screen.getByRole("combobox", { name: "Deployment environment" })).toHaveTextContent(
    "production",
  );
  expect(screen.getByText(/Could not load deployment environments/)).toBeVisible();
  expect(screen.queryByText("Saved environment (not listed)")).not.toBeInTheDocument();
});

it("marks rejected comparison, dimension and environment controls with their errors", () => {
  const recovered = recoverAnalyticsFilters({
    from: "2026-11-01",
    to: "2026-11-08",
    compare: "last",
    dimension: "unsupported",
    environment: "Production",
  });
  render(
    <AnalyticsReportingFilters
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
    <AnalyticsReportingFilters
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
