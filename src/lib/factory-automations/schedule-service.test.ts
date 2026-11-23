import { createClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import {
  previewFactoryAutomationSchedule,
  reconcileFactoryAutomationSchedules,
} from "./schedule-service";

function id(value: number) {
  return `66100000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const rule = { workspaceId: id(1), factoryId: id(2), automationId: id(3), revisionId: id(4) };
const cadence = { cron: "30 1 * * *", timeZone: "America/New_York" };
const cutoff = "2026-11-01T06:35:00.000123+00:00";
const snapshot = {
  ...rule,
  ...cadence,
  cursorVersion: 3,
  admissionGeneration: 4,
  scannedThrough: "2026-10-31T07:00:00+00:00",
  through: cutoff,
};
const previewState = {
  asOf: cutoff,
  current: true,
  archived: false,
  paused: true,
  scannedThrough: snapshot.scannedThrough,
  resumeThrough: null,
  lastResumeThrough: null,
  lastResumeOccurrenceAt: null,
};

function fixture(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    const next = responses.shift();
    if (!next) throw new Error("Unexpected schedule request.");
    return next;
  });
  const client = createClient<Database>("https://schedule-fixture.invalid", "fixture", {
    auth: { persistSession: false },
    global: { fetch },
  });
  return { client, fetch };
}

it("passes the same exact plan to the atomic handoff after a worker restart", async () => {
  const { client, fetch } = fixture(
    Response.json([snapshot]),
    Response.json(true),
    Response.json([snapshot]),
    Response.json(false),
  );
  await reconcileFactoryAutomationSchedules(client);
  await reconcileFactoryAutomationSchedules(client);

  expect(fetch.mock.calls.map(([url]) => String(url).split("/").at(-1))).toEqual([
    "list_due_factory_automation_schedules",
    "commit_factory_automation_schedule",
    "list_due_factory_automation_schedules",
    "commit_factory_automation_schedule",
  ]);
  const commit = {
    p_workspace_id: rule.workspaceId,
    p_factory_id: rule.factoryId,
    p_automation_id: rule.automationId,
    p_revision_id: rule.revisionId,
    p_expected_cursor_version: 3,
    p_expected_admission_generation: 4,
    p_plan: {
      through: cutoff,
      occurrenceAt: "2026-11-01T05:30:00.000Z",
      nextDueAt: "2026-11-02T06:30:00.000Z",
    },
  };
  expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual(commit);
  expect(JSON.parse(String(fetch.mock.calls[3][1]?.body))).toEqual(commit);
});

it("uses the same missed occurrence while paused and after the resume cutoff is frozen", async () => {
  const { client } = fixture(
    Response.json(previewState),
    Response.json({
      ...previewState,
      paused: false,
      asOf: "2026-11-01T08:00:00+00:00",
      resumeThrough: cutoff,
    }),
    Response.json({
      ...previewState,
      paused: false,
      asOf: "2026-11-01T09:00:00+00:00",
      lastResumeThrough: cutoff,
      lastResumeOccurrenceAt: "2026-11-01T05:30:00+00:00",
    }),
  );
  const expected = { through: cutoff, occurrenceAt: "2026-11-01T05:30:00.000Z" };
  await expect(
    previewFactoryAutomationSchedule(client, { ...rule, ...cadence }),
  ).resolves.toMatchObject({
    paused: true,
    catchUp: expected,
    next: expect.arrayContaining(["2026-11-02T06:30:00.000Z"]),
  });
  await expect(
    previewFactoryAutomationSchedule(client, { ...rule, ...cadence }),
  ).resolves.toMatchObject({ paused: false, catchUp: expected });
  await expect(
    previewFactoryAutomationSchedule(client, { ...rule, ...cadence }),
  ).resolves.toMatchObject({
    catchUp: null,
    lastResume: { through: cutoff, occurrenceAt: "2026-11-01T05:30:00+00:00" },
  });
});

it("lets other due rules commit when a schedule handoff fails", async () => {
  const { client, fetch } = fixture(
    Response.json([snapshot, { ...snapshot, automationId: id(5) }]),
    Response.json({ code: "XX000", message: "Database unavailable" }, { status: 500 }),
    Response.json(true),
  );
  await expect(reconcileFactoryAutomationSchedules(client)).rejects.toThrow(
    "Could not reconcile a factory automation schedule.",
  );
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(
    fetch.mock.calls
      .slice(1)
      .map(([, request]) => JSON.parse(String(request?.body)).p_automation_id)
      .sort(),
  ).toEqual([id(3), id(5)]);
});

it("defers an unresolved cursor without a plan and commits the next due rule", async () => {
  const unresolved = { ...snapshot, automationId: id(5), timeZone: "Unknown/Zone" };
  const { client, fetch } = fixture(
    Response.json([unresolved, snapshot]),
    Response.json(true),
    Response.json(true),
  );

  await expect(reconcileFactoryAutomationSchedules(client)).rejects.toMatchObject({
    message: "Could not reconcile a factory automation schedule.",
    cause: {
      message: `The schedule for automation ${unresolved.automationId} could not be resolved.`,
    },
  });

  expect(fetch).toHaveBeenCalledTimes(3);
  const requests = Object.fromEntries(
    fetch.mock.calls
      .slice(1)
      .map(([url, request]) => [String(url).split("/").at(-1), JSON.parse(String(request?.body))]),
  );
  expect(requests).toEqual({
    defer_factory_automation_schedule: {
      p_workspace_id: unresolved.workspaceId,
      p_factory_id: unresolved.factoryId,
      p_automation_id: unresolved.automationId,
      p_revision_id: unresolved.revisionId,
      p_expected_cursor_version: unresolved.cursorVersion,
      p_expected_admission_generation: unresolved.admissionGeneration,
    },
    commit_factory_automation_schedule: expect.objectContaining({
      p_automation_id: snapshot.automationId,
      p_plan: {
        through: cutoff,
        occurrenceAt: "2026-11-01T05:30:00.000Z",
        nextDueAt: "2026-11-02T06:30:00.000Z",
      },
    }),
  });
});

it("retains the unresolved schedule error when deferral fails", async () => {
  const unresolved = { ...snapshot, timeZone: "Unknown/Zone" };
  const { client } = fixture(
    Response.json([unresolved]),
    Response.json({ code: "XX000", message: "Database unavailable" }, { status: 500 }),
  );

  await expect(reconcileFactoryAutomationSchedules(client)).rejects.toMatchObject({
    cause: {
      message: `The schedule for automation ${unresolved.automationId} could not be resolved.`,
      cause: { code: "XX000", message: "Database unavailable" },
    },
  });
});
