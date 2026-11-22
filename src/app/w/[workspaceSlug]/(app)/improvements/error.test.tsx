// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import ImprovementsError from "./error";

const factory = "63700000-0000-4000-8000-000000000001";

vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceSlug: "example" }),
  useSearchParams: () => new URLSearchParams({ factory }),
  useRouter: () => ({ refresh: vi.fn() }),
}));

afterEach(cleanup);

it("returns to the selected factory after an Improvements page error", () => {
  render(<ImprovementsError reset={vi.fn()} />);

  expect(screen.getByRole("link", { name: "Back to improvements" }).getAttribute("href")).toBe(
    `/w/example/improvements?factory=${factory}`,
  );
});
