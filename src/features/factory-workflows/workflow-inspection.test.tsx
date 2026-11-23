// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import type {
  WorkflowInspection,
  WorkflowInspectionEvent,
  WorkflowInspectionHeader,
} from "@/lib/factory-workflows/inspection-contracts";

import { WorkflowInspectionDisclosure } from "./workflow-inspection-disclosure";

function id(value: number) {
  return `65690000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const initialNow = "2026-11-23T12:00:00.000Z";
const root = {
  sessionId: id(1),
  sessionNumber: 41,
  workspaceId: id(2),
  factoryId: id(3),
  graphRevisionId: id(4),
  workflowDigest: "a".repeat(64),
  lifecycleStatus: "running",
  generation: 1,
  canManage: true,
} satisfies WorkflowInspectionHeader["root"];
const subject = { sessionId: id(6), sessionNumber: 43, runId: id(8) };
const eventFields = { recordedAt: initialNow, occurrenceId: id(9), nodeId: "delegate" };

function response(
  header: WorkflowInspectionHeader,
  events: WorkflowInspectionEvent[] = [],
  nextCursor: string | null = null,
) {
  return Response.json({
    ...header,
    events,
    budget: null,
    nextCursor,
  } satisfies WorkflowInspection);
}

function mount(header: WorkflowInspectionHeader) {
  const user = userEvent.setup();
  render(
    <WorkflowInspectionDisclosure header={header} initialNow={initialNow} workspaceSlug="demo" />,
  );
  return user;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("opens on keyboard with focus intact and shows the exact run under its nested child", async () => {
  const header = { root: { ...root, canManage: false }, subject };
  const current = {
    ...eventFields,
    id: id(8),
    kind: "attempt",
    state: "running",
    detail: {
      sessionId: subject.sessionId,
      sessionNumber: 43,
      parentSessionId: id(5),
      jobId: id(10),
      runId: id(8),
      attemptCount: 2,
      current: true,
      retired: false,
      source: "child",
    },
  } satisfies WorkflowInspectionEvent;
  const retired = {
    ...current,
    id: id(7),
    state: "canceled",
    detail: { ...current.detail, runId: id(7), current: false, retired: true, attemptCount: 1 },
  } satisfies WorkflowInspectionEvent;
  const outer = {
    ...eventFields,
    id: id(5),
    kind: "child",
    state: "in_progress",
    detail: {
      parentSessionId: root.sessionId,
      parentSessionNumber: 41,
      childSessionId: id(5),
      sessionNumber: 42,
    },
  } satisfies WorkflowInspectionEvent;
  const inner = {
    ...outer,
    id: subject.sessionId,
    detail: {
      parentSessionId: id(5),
      parentSessionNumber: 42,
      childSessionId: subject.sessionId,
      sessionNumber: 43,
    },
  } satisfies WorkflowInspectionEvent;
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(response(header, [current, inner, outer], "before-1"))
    .mockResolvedValueOnce(response(header, [retired]));
  vi.stubGlobal("fetch", fetch);
  const user = mount(header);
  const trigger = screen.getByRole("button", { name: "Workflow" });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(fetch).not.toHaveBeenCalled();

  await user.tab();
  expect(trigger).toHaveFocus();
  await user.keyboard("{Enter}");
  const rootLink = await screen.findByRole("link", { name: "Workflow root · Session #41" });
  expect(rootLink).toHaveAttribute("href", "/w/demo/sessions/41");
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(screen.queryByRole("button", { name: "Pause workflow" })).toBeNull();
  expect(fetch.mock.calls[0]?.[0]).toBe(
    `/api/sessions/${subject.sessionId}/workflow-inspection?runId=${subject.runId}`,
  );

  const parent = screen.getByRole("heading", { name: "Child session #42" }).closest("li");
  expect(parent).toBeTruthy();
  if (!parent) throw new Error("Parent child-session row is missing.");
  const child = within(parent).getByRole("heading", { name: "Child session #43" }).closest("li");
  if (!child) throw new Error("Nested child-session row is missing.");
  const selected = within(child).getByText("Selected run").closest("article");
  if (!selected) throw new Error("Selected run is missing.");
  expect(within(selected).getByRole("link", { name: "Open exact run" })).toHaveAttribute(
    "href",
    `/w/demo/runs/${subject.runId}`,
  );
  expect(within(child).getByRole("link", { name: "Parent session #42" })).toHaveAttribute(
    "href",
    "/w/demo/sessions/42",
  );

  await user.click(screen.getByRole("button", { name: "Load older events" }));
  await within(child).findByText("Retired attempt");
  expect(within(child).getByRole("heading", { name: "Attempt 1" })).toBeVisible();
  expect(fetch.mock.calls[1]?.[0]).toBe(
    `/api/sessions/${subject.sessionId}/workflow-inspection?runId=${subject.runId}&cursor=before-1`,
  );
});

it("keeps partial repository delivery, exact review, and pending human approval separate", async () => {
  const header = {
    root: { ...root, canManage: false },
    subject: { sessionId: id(1), sessionNumber: 41, runId: null },
  };
  const artifact = {
    sessionId: id(1),
    sessionNumber: 41,
    runId: id(11),
    stageSlug: "inspect-output",
    artifactId: id(12),
    artifactVersion: 3,
  };
  const events: WorkflowInspectionEvent[] = [
    {
      ...eventFields,
      kind: "join",
      id: id(13),
      state: "adopted",
      nodeId: "integrate",
      detail: {
        ...artifact,
        wholeJoinComplete: false,
        deliveryStatus: "partial",
        omittedBranchEdgeIds: ["optional-docs"],
      },
    },
    {
      ...eventFields,
      kind: "repository",
      id: `${id(13)}:${id(14)}`,
      state: "blocked",
      detail: {
        repositoryName: "wallie/docs",
        remoteReconciliationRequired: true,
        blocker: "deadline_expired",
      },
    },
    {
      ...eventFields,
      kind: "review",
      id: id(15),
      state: "pass",
      nodeId: "inspect",
      detail: {
        ...artifact,
        verdict: "pass",
        commitSha: "b".repeat(40),
        validationTreeSha: "c".repeat(40),
      },
    },
    {
      ...eventFields,
      kind: "artifact",
      id: artifact.artifactId,
      state: "adopted",
      detail: {
        ...artifact,
        approvalState: "awaiting_review",
      },
    },
  ];
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(header, events)));
  const user = mount(header);
  await user.click(screen.getByRole("button", { name: "Workflow" }));
  await screen.findByText("Partial delivery");
  expect(screen.getByText("Omitted optional outputs optional-docs")).toBeVisible();
  expect(screen.getByRole("heading", { name: "wallie/docs" })).toBeVisible();
  expect(screen.getByText("deadline expired")).toBeVisible();
  expect(screen.getByText("Remote reconciliation required")).toBeVisible();
  expect(screen.getByText("Review passed")).toBeVisible();
  expect(screen.getByText("Awaiting human approval")).toBeVisible();
  expect(screen.getByRole("link", { name: "Review artifact v3" })).toHaveAttribute(
    "href",
    `/w/demo/sessions/41?artifactStage=inspect-output&artifactId=${artifact.artifactId}&artifactVersion=3`,
  );
});

it("refreshes stale lifecycle state and sends a new exact request only after new intent", async () => {
  const header = { root, subject };
  const paused = { root: { ...root, generation: 2, lifecycleStatus: "paused" } as const, subject };
  const resumed = { root: { ...root, generation: 3 }, subject };
  const commands: { action: string; expectedGeneration: number; requestId: string }[] = [];
  const fetch = vi.fn(async (url: string, request?: RequestInit) => {
    if (request?.method === "POST") {
      expect(url).toBe(`/api/sessions/${root.sessionId}/workflow-lifecycle`);
      const command = JSON.parse(String(request.body));
      commands.push(command);
      if (commands.length === 1) return Response.json({}, { status: 409 });
      return Response.json({
        action: "resume",
        requestId: command.requestId,
        generation: 3,
        lifecycleStatus: "running",
      });
    }
    return response(commands.length === 0 ? header : commands.length === 1 ? paused : resumed);
  });
  vi.stubGlobal("fetch", fetch);
  const user = mount(header);
  await user.click(screen.getByRole("button", { name: "Workflow" }));
  await user.click(await screen.findByRole("button", { name: "Pause workflow" }));
  expect((await screen.findByRole("alert")).textContent).toContain("The workflow changed.");
  await screen.findByText("Generation 2");
  expect(commands).toEqual([
    { action: "pause", expectedGeneration: 1, requestId: expect.any(String) },
  ]);

  await user.click(screen.getByRole("button", { name: "Resume workflow" }));
  await screen.findByText("Workflow resumed.");
  expect(commands[1]).toMatchObject({ action: "resume", expectedGeneration: 2 });
  expect(commands[1]?.requestId).not.toBe(commands[0]?.requestId);
  await screen.findByText("Generation 3");
});

it("retries a lost lifecycle response with the same request identity", async () => {
  const header = { root, subject };
  const commands: unknown[] = [];
  const fetch = vi.fn(async (_url: string, request?: RequestInit) => {
    if (request?.method !== "POST") return response(header);
    commands.push(JSON.parse(String(request.body)));
    throw new TypeError("Connection interrupted.");
  });
  vi.stubGlobal("fetch", fetch);
  const user = mount(header);
  await user.click(screen.getByRole("button", { name: "Workflow" }));
  const pause = await screen.findByRole("button", { name: "Pause workflow" });
  await user.click(pause);
  await screen.findByRole("alert");
  await user.click(pause);
  await waitFor(() => expect(commands).toHaveLength(2));
  expect(commands[0]).toEqual(commands[1]);
});
