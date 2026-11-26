import { describe, expect, it } from "vitest";

import { parseScorerTrendQuery } from "@/lib/factory-evaluations/score-trend-query";

import {
  analyticsCoreFields,
  analyticsScorerFields,
  applyAnalyticsFields,
} from "./analytics-navigation";
import { recoverAnalyticsFilters } from "./analytics-query";
import { analyticsCohortHref } from "./analytics-view-shared";

const factoryId = "58200000-0000-4000-8000-000000000001";
const dates = { from: "2026-11-01", to: "2026-11-07" };
const evidence = { metric: "throughput", period: "primary", bucket: "member:a", cursor: "test" };
const scorer = {
  scorerRevision: "58200000-0000-4000-8000-000000000002",
  cohort: "58200000-0000-4000-8000-000000000003",
  scoreSnapshot: "1." + "a".repeat(64),
  evaluationDay: "2026-11-03",
  beforeScoreRun: "58200000-0000-4000-8000-000000000004",
  beforeRunFinishedAt: "2026-11-03T02:00:00Z",
};

describe("Analytics navigation", () => {
  it("keeps the factory and dates when a saved environment is invalid", () => {
    const {
      query,
      errors,
      dates: draft,
    } = recoverAnalyticsFilters({
      ...dates,
      environment: "Production",
      factory: factoryId,
      compare: "previous",
    });
    expect(query).toMatchObject({
      factoryId,
      from: dates.from + "T00:00:00.000Z",
      to: dates.to + "T00:00:00.000Z",
      comparison: { to: dates.from + "T00:00:00.000Z" },
    });
    expect(errors.environment).toMatch(/Choose a deployment environment/);
    expect(draft).toBeUndefined();
    expect(
      recoverAnalyticsFilters({ ...dates, from: "2026-11-08", factory: factoryId }).dates,
    ).toEqual({ ...dates, from: "2026-11-08" });
  });

  it("preserves reporting range and frozen scorer context across evidence links", () => {
    const { query } = recoverAnalyticsFilters({
      ...dates,
      factory: factoryId,
      compare: "previous",
    });
    const scorerQuery = parseScorerTrendQuery({ ...dates, ...scorer });
    expect(scorerQuery).not.toBeNull();
    const fields = analyticsScorerFields(scorerQuery);
    const open = analyticsCohortHref(
      "test",
      factoryId,
      query,
      { metric: "revert", period: "compare" },
      fields,
    );
    const close = analyticsCohortHref("test", factoryId, query, undefined, fields);
    expect(open).toMatch(/metric=revert.*#analytics-evidence$/);
    expect(close).not.toContain("metric=");
    for (const href of [open, close]) {
      const search = new URL(href, "http://localhost").searchParams;
      for (const [key, value] of Object.entries({ ...scorer, ...dates }))
        expect(search.get(key)).toBe(value);
      expect(search.get("compare")).toBe("previous");
    }
  });

  it("clears evidence and scorer selection state only when their scopes change", () => {
    const { query } = recoverAnalyticsFilters({ ...dates, dimension: "person" });
    const core = analyticsCoreFields(factoryId, query);
    const form = new FormData();
    for (const [name, value] of Object.entries({ ...dates, dimension: "person" }))
      form.set(name, value);
    expect(applyAnalyticsFields(form, core, evidence, scorer)).toMatchObject({
      ...scorer,
      ...evidence,
    });
    form.set("dimension", "definition");
    expect(applyAnalyticsFields(form, core, evidence, scorer)).toMatchObject(scorer);
    expect(applyAnalyticsFields(form, core, evidence, scorer)).not.toHaveProperty("bucket");
    form.set("from", "2026-11-02");
    const changed = applyAnalyticsFields(form, core, evidence, scorer);
    expect(changed).toMatchObject({ scorerRevision: scorer.scorerRevision, cohort: scorer.cohort });
    for (const key of ["cursor", "scoreSnapshot", "beforeScoreRun", "evaluationDay"]) {
      expect(changed).not.toHaveProperty(key);
    }
    expect(
      applyAnalyticsFields(form, core, { ...evidence, period: "compare" }, scorer),
    ).not.toHaveProperty("metric");
  });
});
