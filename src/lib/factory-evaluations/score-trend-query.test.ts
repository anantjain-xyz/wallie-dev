import { describe, expect, it } from "vitest";

import { parseScorerTrendQuery } from "./score-trend-query";

const cohort = "608a0000-0000-4000-8000-000000000001";
const run = "608a0000-0000-4000-8000-000000000002";
const scoreSnapshot = `17.${"f".repeat(64)}`;
const date = { from: "2026-11-01", to: "2026-12-01" };

describe("scorer trend filters", () => {
  it("uses a UTC date window containing today's finished runs on scorer detail", () => {
    expect(parseScorerTrendQuery({}, undefined, new Date("2026-11-19T18:00:00Z"))).toEqual({
      from: "2026-10-21",
      to: "2026-11-20",
    });
  });

  it("keeps the exact signed snapshot and PostgreSQL cursor precision", () => {
    const beforeRunFinishedAt = "2026-11-18T12:30:04.123456+00:00";
    expect(
      parseScorerTrendQuery({
        ...date,
        cohort: cohort.toUpperCase(),
        scoreSnapshot,
        evaluationDay: "2026-11-18",
        evaluationStatus: "",
        beforeRunFinishedAt,
        beforeScoreRun: run,
      }),
    ).toMatchObject({
      cohort,
      scoreSnapshot,
      evaluationDay: "2026-11-18",
      beforeRunFinishedAt,
      beforeScoreRun: run,
    });
  });

  it.each([
    { scoreSnapshot },
    { cohort, beforeScoreRun: run },
    { cohort, scoreSnapshot, beforeScoreRun: run },
    { cohort, scoreSnapshot, evaluationDay: date.to },
    { cohort: [cohort, cohort] },
    { from: "2024-01-01" },
    { beforeRevisionAt: "2026-11-18T12:30:04.123456+00:00" },
    { beforeCohortPolicy: cohort },
  ])("rejects invalid or unbound drilldown filters %j", (filters) => {
    expect(parseScorerTrendQuery({ ...date, ...filters })).toBeNull();
  });

  it("keeps independent option cursor pairs with full timestamp precision", () => {
    const beforeRevisionAt = "2026-11-18T12:30:04.123456+00:00";
    const beforeCohortAt = "2026-11-18T11:30:04.876543+00:00";
    expect(
      parseScorerTrendQuery({
        ...date,
        beforeRevisionAt,
        beforeRevisionPolicy: cohort,
        beforeCohortAt,
        beforeCohortPolicy: run,
      }),
    ).toEqual({
      ...date,
      beforeRevisionAt,
      beforeRevisionPolicy: cohort,
      beforeCohortAt,
      beforeCohortPolicy: run,
    });
  });
});
