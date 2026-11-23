import { expect, it } from "vitest";

import { createFactoryAutomationSchedule } from "./schedule";

function planner(cron: string, timeZone: string) {
  const schedule = createFactoryAutomationSchedule({ cron, timeZone });
  if (!schedule) throw new Error("The fixture schedule is invalid.");
  return schedule;
}

function times(values: number[]) {
  return values.map((value) => new Date(value).toISOString());
}

it("skips a nonexistent local clock time in the spring gap", () => {
  const schedule = planner("30 2 * * *", "America/New_York");
  expect(times(schedule.nextOccurrences(Date.parse("2026-03-07T07:30:00Z"), 2))).toEqual([
    "2026-03-09T06:30:00.000Z",
    "2026-03-10T06:30:00.000Z",
  ]);
});

it("chooses the first repeated wall time even when the cursor has passed it", () => {
  const schedule = planner("30 1 * * *", "America/New_York");
  expect(times(schedule.nextOccurrences(Date.parse("2026-11-01T00:00:00Z"), 2))).toEqual([
    "2026-11-01T05:30:00.000Z",
    "2026-11-02T06:30:00.000Z",
  ]);
  expect(times(schedule.nextOccurrences(Date.parse("2026-11-01T05:31:00Z"), 1))).toEqual([
    "2026-11-02T06:30:00.000Z",
  ]);
  expect(
    schedule.latestDueOccurrence(
      Date.parse("2026-11-01T05:31:00Z"),
      Date.parse("2026-11-01T07:00:00Z"),
    ),
  ).toBeNull();
});

it("handles the thirty-minute autumn fold in Lord Howe", () => {
  const schedule = planner("45 1 * * *", "Australia/Lord_Howe");
  expect(times(schedule.nextOccurrences(Date.parse("2026-04-04T10:00:00Z"), 2))).toEqual([
    "2026-04-04T14:45:00.000Z",
    "2026-04-05T15:15:00.000Z",
  ]);
});

it("has no occurrence on a civil date skipped by a timezone change", () => {
  const schedule = planner("0 10 * * *", "Pacific/Apia");
  expect(times(schedule.nextOccurrences(Date.parse("2011-12-29T21:00:00Z"), 1))).toEqual([
    "2011-12-30T20:00:00.000Z",
  ]);
});

it("matches either restricted day field and accepts Sunday as 7", () => {
  const schedule = planner("0 9 13 * 7", "UTC");
  expect(times(schedule.nextOccurrences(Date.parse("2026-11-12T00:00:00Z"), 2))).toEqual([
    "2026-11-13T09:00:00.000Z",
    "2026-11-15T09:00:00.000Z",
  ]);
});

it("bounds catch-up to the latest unscanned occurrence in the previous 24 hours", () => {
  const schedule = planner("0 9,11 * * *", "America/Los_Angeles");
  const pausedThrough = Date.parse("2026-11-19T00:00:00Z");
  const resumedAt = Date.parse("2026-11-23T20:15:00Z");
  expect(schedule.latestDueOccurrence(pausedThrough, resumedAt)).toBe(
    Date.parse("2026-11-23T19:00:00Z"),
  );
  expect(schedule.latestDueOccurrence(resumedAt, resumedAt)).toBeNull();
  expect(schedule.latestDueOccurrence(pausedThrough, Date.parse("2026-11-23T16:00:00Z"))).toBe(
    Date.parse("2026-11-22T19:00:00Z"),
  );
});

it("finds sparse leap years and distinguishes an unavailable timezone", () => {
  const schedule = planner("0 9 29 2 *", "UTC");
  expect(times(schedule.nextOccurrences(Date.parse("2096-02-29T09:00:00Z"), 1))).toEqual([
    "2104-02-29T09:00:00.000Z",
  ]);
  expect(
    createFactoryAutomationSchedule({ cron: "0 9 * * *", timeZone: "Unknown/Zone" }),
  ).toBeNull();
});
