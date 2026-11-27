// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";

import { MetricPanel } from "./analytics-view-shared";

it("renders one evidence link per value and uses the full percentage scale", () => {
  render(
    <MetricPanel
      compare
      definition="Test"
      summary={null}
      href={(point) => `/analytics?metric=${point?.metric}&period=${point?.period}`}
      id="revert-rate"
      metadata={null}
      title="Revert rate"
      groups={[
        {
          label: "Share of covered mature merges",
          scale: "percent",
          rows: [
            {
              key: "revert-rate",
              label: "Verified revert rate",
              primary: { value: 0.01, label: "1%", evidence: { metric: "revert" } },
              comparison: { value: 0, label: "0%", evidence: { metric: "revert" } },
            },
          ],
        },
      ]}
    />,
  );
  const table = screen.getByRole("table", { name: "Revert rate comparison table" });
  expect(table).toHaveTextContent("0–100% scale");
  expect(screen.getAllByRole("link")).toHaveLength(2);
  const [current, previous] = within(table).getAllByRole("cell");
  expect(within(current!).getByRole("link")).toHaveAttribute(
    "href",
    "/analytics?metric=revert&period=primary",
  );
  expect(current?.querySelector("[style]")).toHaveStyle({ width: "1%" });
  expect(previous?.querySelector("[style]")).toHaveStyle({ width: "0%" });
});
