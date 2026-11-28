import { describe, expect, it } from "vitest";

import { resolveAnalyticsFactory } from "@/features/factories/factory-selection";

import { parseAnalyticsQuery } from "./analytics-query";
import { analyticsCohortHref } from "./analytics-view-shared";

describe("analytics query", () => {
  it("defaults to 30 complete UTC days and compares equal elapsed periods", () => {
    const result = parseAnalyticsQuery(
      { compare: "previous" },
      new Date("2026-11-19T20:01:30-08:00"),
    );

    expect(result).toEqual({
      success: true,
      data: {
        from: "2026-10-21T00:00:00.000Z",
        to: "2026-11-20T00:00:00.000Z",
        comparison: { from: "2026-09-21T00:00:00.000Z", to: "2026-10-21T00:00:00.000Z" },
        factoryId: null,
        dimension: "source",
        environment: null,
        evidence: null,
      },
    });
    expect(
      parseAnalyticsQuery({ from: "2026-10-31", to: "2026-11-02", compare: "previous" }),
    ).toMatchObject({
      success: true,
      data: { comparison: { from: "2026-10-29T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z" } },
    });
  });

  it.each([
    { factory: "all" },
    { routingCanary: "latest" },
    { routingAlert: "54200000-0001-4000-8000-000000000003" },
    { routingCanary: "54200000-0001-4000-8000-000000000002", routingAlert: "latest" },
    { from: "2026-02-29", to: "2026-03-02" },
    { from: "2026-02-01" },
    { from: "2026-02-02", to: "2026-02-02" },
    { from: "2025-01-01", to: "2026-01-03" },
    { environment: "Production" },
    { dimension: ["model", "person"] },
    { metric: "revert", period: "compare" },
    { metric: "merge", facet: "active" },
    { metric: "flow", bucket: "unknown" },
    { metric: "throughput", facet: "unknown" },
    { metric: "throughput", bucket: "model:\ninvalid" },
    { facet: "covered" },
  ])("rejects an invalid date, scope, or evidence combination %j", (filters) => {
    expect(parseAnalyticsQuery(filters)).toEqual({ success: false });
  });

  it("keeps exact named comparison evidence, and accepts the SQL date bound", () => {
    const canaryId = "54200000-0001-4000-8000-000000000002";
    expect(
      parseAnalyticsQuery({
        from: "2024-01-01",
        to: "2025-01-01",
        compare: "previous",
        environment: "",
        metric: "throughput",
        bucket: "model:A named model",
        period: "compare",
        dimension: "model",
        routingCanary: canaryId,
      }),
    ).toMatchObject({
      success: true,
      data: {
        environment: null,
        dimension: "model",
        routingCanaryId: canaryId,
        evidence: { metric: "throughput", bucket: "model:A named model", period: "compare" },
      },
    });
  });

  it("retains exact canary and alert IDs through analytics evidence links", () => {
    const factoryId = "54200000-0001-4000-8000-000000000001";
    const canaryId = "54200000-0001-4000-8000-000000000002";
    const alertId = "54200000-0001-4000-8000-000000000003";
    const result = parseAnalyticsQuery({
      factory: factoryId,
      routingCanary: canaryId,
      routingAlert: alertId,
    });
    expect(result).toMatchObject({
      success: true,
      data: { factoryId, routingCanaryId: canaryId, routingAlertId: alertId },
    });
    if (!result.success) throw new Error("Expected the scoped alert query to parse.");
    const link = new URL(
      analyticsCohortHref("acme", factoryId, result.data, { metric: "merge", period: "primary" }),
      "http://localhost",
    );
    expect(link.searchParams.get("factory")).toBe(factoryId);
    expect(link.searchParams.get("routingCanary")).toBe(canaryId);
    expect(link.searchParams.get("routingAlert")).toBe(alertId);
    expect(link.hash).toBe("#analytics-evidence");
  });

  it("selects a visible default or first visible factory and keeps explicit denials", () => {
    const first = {
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      name: "Visible",
      isDefault: false,
      status: "active" as const,
    };
    const preferred = { ...first, id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", isDefault: true };
    expect(resolveAnalyticsFactory([first, preferred], null)).toBe(preferred);
    expect(resolveAnalyticsFactory([first], undefined)).toBe(first);
    expect(resolveAnalyticsFactory([first, preferred], first.id.toUpperCase())).toBe(first);
    expect(resolveAnalyticsFactory([first], preferred.id)).toBeNull();
    expect(resolveAnalyticsFactory([first], [first.id])).toBeNull();
  });
});
