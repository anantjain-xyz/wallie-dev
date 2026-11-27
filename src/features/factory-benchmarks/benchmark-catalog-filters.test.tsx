// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { BenchmarkCatalogFilters } from "./benchmark-catalog-filters";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

afterEach(() => {
  cleanup();
  push.mockClear();
  vi.useRealTimers();
});

it("debounces name edits and navigates with the current purpose and factory", () => {
  vi.useFakeTimers();
  const path = "/w/example/benchmarks";
  render(
    <BenchmarkCatalogFilters
      path={path}
      clearHref={path + "?factory=test"}
      factoryId="test"
      name=""
      purpose="regression"
    />,
  );
  const input = screen.getByRole("searchbox", { name: "Suite name" });
  fireEvent.change(input, { target: { value: "Inv" } });
  act(() => vi.advanceTimersByTime(200));
  fireEvent.change(input, { target: { value: " Invoice " } });
  act(() => vi.advanceTimersByTime(200));
  expect(push).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(150));
  expect(push).toHaveBeenCalledExactlyOnceWith(
    path + "?factory=test&q=Invoice&purpose=regression",
    { scroll: false },
  );
});

it("commits the pending draft with a new purpose and does not submit it twice", () => {
  vi.useFakeTimers();
  const path = "/w/example/benchmarks";
  render(
    <BenchmarkCatalogFilters
      path={path}
      clearHref={path + "?factory=test"}
      factoryId="test"
      name=""
      purpose=""
    />,
  );
  fireEvent.change(screen.getByRole("searchbox", { name: "Suite name" }), {
    target: { value: "Invoice" },
  });
  fireEvent.click(screen.getByRole("combobox", { name: "Purpose" }));
  fireEvent.click(screen.getByRole("option", { name: "Holdout" }));
  act(() => vi.runAllTimers());
  expect(push).toHaveBeenCalledExactlyOnceWith(path + "?factory=test&q=Invoice&purpose=holdout", {
    scroll: false,
  });
});

it("discards an uncommitted search on browser back or forward", () => {
  vi.useFakeTimers();
  const path = "/w/example/benchmarks";
  render(
    <BenchmarkCatalogFilters
      path={path}
      clearHref={path + "?factory=test"}
      factoryId="test"
      name="Invoice"
      purpose="regression"
    />,
  );
  const input = screen.getByRole<HTMLInputElement>("searchbox", { name: "Suite name" });
  fireEvent.change(input, { target: { value: "New draft" } });
  act(() => window.dispatchEvent(new PopStateEvent("popstate")));
  act(() => vi.runAllTimers());
  expect(input.value).toBe("Invoice");
  expect(push).not.toHaveBeenCalled();
});
