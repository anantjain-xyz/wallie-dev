// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import RunError from "@/app/w/[workspaceSlug]/(app)/runs/[runId]/error";
import RunNotFound from "@/app/w/[workspaceSlug]/(app)/runs/[runId]/not-found";

const { navigation } = vi.hoisted(() => ({
  navigation: { searchParams: new URLSearchParams(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceSlug: "wallie" }),
  useRouter: () => ({ refresh: navigation.refresh }),
  useSearchParams: () => navigation.searchParams,
}));

afterEach(cleanup);

describe.each([
  ["error", RunError],
  ["not found", RunNotFound],
] as const)("run %s boundary", (_label, Boundary) => {
  it("returns to the same filtered Runs page without trusting an external URL", () => {
    navigation.searchParams = new URLSearchParams({
      fromRuns: "factory=all&status=error&cursor=opaque",
    });
    render(<Boundary />);
    const link = screen.getByRole("link", { name: "Back to filtered runs" });
    const href = new URL(link.getAttribute("href")!, "https://wallie.test");
    expect(href.origin).toBe("https://wallie.test");
    expect(href.pathname).toBe("/w/wallie/runs");
    expect(Object.fromEntries(href.searchParams)).toEqual({
      factory: "all",
      status: "error",
      cursor: "opaque",
    });
  });

  it.each([
    { case: "missing", values: [] },
    { case: "invalid", values: ["next=https://example.test"] },
    { case: "repeated", values: ["factory=all", "status=error"] },
  ])("falls back to Runs for $case return context", ({ values }) => {
    navigation.searchParams = new URLSearchParams();
    for (const value of values) navigation.searchParams.append("fromRuns", value);
    render(<Boundary />);
    expect(screen.getByRole("link", { name: "Back to runs" }).getAttribute("href")).toBe(
      "/w/wallie/runs",
    );
  });
});
