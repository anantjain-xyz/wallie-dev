import { describe, expect, it, vi } from "vitest";

import {
  establishedMaximumBytes,
  evaluateRouteBudgets,
  parseBudgetConfig,
  parseRouteBundleStats,
  runRouteBudgetCheck,
} from "../../../scripts/check-route-budgets";

const routeStats = [
  ["/w/[workspaceSlug]", 700_000],
  ["/w/[workspaceSlug]/sessions", 700_000],
  ["/w/[workspaceSlug]/settings", 800_000],
  ["/w/[workspaceSlug]/sessions/[sessionNumber]", 900_000],
  ["/w/[workspaceSlug]/onboarding", 680_000],
].map(([route, bytes]) => ({
  firstLoadChunkPaths: [`.next/${route}.js`],
  firstLoadUncompressedJsBytes: bytes,
  route,
}));

describe("route bundle budgets", () => {
  it("parses diagnostics and reports every total when one route is over budget", () => {
    const stats = parseRouteBundleStats(JSON.stringify(routeStats));
    const results = evaluateRouteBudgets({
      budgets: establishedMaximumBytes,
      sharedRootBytes: 450_000,
      stats: stats.map((stat) =>
        stat.route.endsWith("/settings")
          ? {
              ...stat,
              firstLoadUncompressedJsBytes: 450_000 + establishedMaximumBytes.settings + 1,
            }
          : stat,
      ),
    });

    expect(results).toHaveLength(6);
    expect(results.map((result) => result.name)).toEqual([
      "shared/root",
      "pipeline",
      "sessions",
      "settings",
      "detail",
      "onboarding",
    ]);
    expect(results.find((result) => result.name === "settings")?.overBudgetBytes).toBe(1);
  });

  it("rejects malformed diagnostics and budget increases", () => {
    expect(() => parseRouteBundleStats('{"route":"/"}')).toThrow("must be an array");
    expect(() =>
      parseBudgetConfig(
        JSON.stringify({
          ...establishedMaximumBytes,
          sessions: establishedMaximumBytes.sessions + 1,
        }),
      ),
    ).toThrow("increased above its established ceiling");
  });

  it("fails the intentional fixture after printing all route totals", () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((message) => logs.push(message));
    const error = vi.spyOn(console, "error").mockImplementation((message) => errors.push(message));

    try {
      expect(
        runRouteBudgetCheck([
          "--stats",
          "test/fixtures/route-bundle-stats.over-budget.json",
          "--root-bytes",
          "450000",
        ]),
      ).toBe(1);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }

    expect(logs).toHaveLength(6);
    for (const name of Object.keys(establishedMaximumBytes)) {
      expect(logs.some((line) => line.includes(` ${name}:`))).toBe(true);
    }
    expect(errors.join("\n")).toContain("settings +1");
  });
});
