// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RunMessageTimeline, WallieRunCard, type WallieRunCardProps } from "./run-activity";
import type { WallieRunMessage } from "./types";

afterEach(cleanup);

const now = "2026-09-06T12:00:00.000Z";
const tool = (id: string, name: string, input: string): WallieRunMessage => ({
  id,
  kind: "tool_use",
  createdAt: now,
  messageMd: `**Tool:** ${name}\n\n\`\`\`\n${input}\n\`\`\``,
});

function toggle(summaryText: string | RegExp) {
  const details = screen.getByText(summaryText).closest("details")!;
  details.open = !details.open;
  fireEvent(details, new Event("toggle"));
  return details;
}

function cardProps(): WallieRunCardProps {
  return {
    actionPending: false,
    branchName: null,
    cancelLocked: false,
    connectionState: "live",
    isExpanded: false,
    isPrimary: true,
    messagesLoaded: true,
    messagesLoadFailed: false,
    nowMs: Date.parse(now),
    onCancel: vi.fn(async () => {}),
    onRetry: vi.fn(async () => {}),
    onToggle: vi.fn(),
    renderNow: now,
    retryLocked: false,
    stallTimeoutMs: 900_000,
    run: {
      attemptCount: 1,
      canCancel: true,
      canRetry: false,
      createdAt: now,
      finishedAt: null,
      id: "run",
      isActive: true,
      isTerminal: false,
      lastActivityAt: now,
      messages: [tool("shell", "bash", '{"cmd":"pnpm check","id":9007199254740993}')],
      modelName: "gpt-5.5",
      modelProvider: "codex",
      requestedByMember: null,
      requestedByMemberId: null,
      runType: "code",
      sandboxId: null,
      sandboxProvider: null,
      stageId: "build",
      stageName: "Build",
      stageSlug: "build",
      startedAt: now,
      status: "running",
      updatedAt: now,
    },
  };
}

describe("concise run activity", () => {
  it("keeps status and cancellation visible while command details stay in the full log", () => {
    const props = cardProps();
    const view = render(<WallieRunCard {...props} />);
    expect(screen.getByText("Working").classList.contains("activity-shimmer")).toBe(true);
    expect(screen.getByText("Running a command")).toBeTruthy();
    expect(screen.queryByText("pnpm check")).toBeNull();
    expect(screen.getByText("View full log")).toBeTruthy();
    expect(screen.queryByLabelText("Tool payload")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(props.onCancel).toHaveBeenCalledWith("run");
    expect(props.onToggle).not.toHaveBeenCalled();
    for (const state of ["queued", "success", "error", "canceled"] as const) {
      view.rerender(
        <WallieRunCard
          {...props}
          run={{ ...props.run, status: state, isActive: state === "queued" }}
        />,
      );
      expect(view.container.querySelector(".activity-shimmer")).toBeNull();
    }
    view.rerender(<WallieRunCard {...props} connectionState="reconnecting" />);
    expect(view.container.querySelector(".activity-shimmer")).toBeNull();
    expect(screen.getByText("Reconnecting to live updates…")).toBeTruthy();
  });

  it("keeps failure diagnostics and retry available with activity collapsed", () => {
    const props = cardProps();
    render(
      <WallieRunCard
        {...props}
        run={{
          ...props.run,
          status: "error",
          isActive: false,
          canCancel: false,
          canRetry: true,
          messages: [
            {
              id: "error",
              createdAt: now,
              kind: "error",
              messageMd: "**Error:** Sandbox could not start.",
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("Sandbox could not start.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry Run" }));
    expect(props.onRetry).toHaveBeenCalledWith("run");
    expect(screen.queryByRole("list", { name: "Run activity" })).toBeNull();
  });

  it("lazily reveals complete payloads without rounding large numbers or rendering markup", async () => {
    render(
      <RunMessageTimeline
        messages={[
          tool(
            "shell",
            "bash",
            '{"cmd":"pnpm check","id":9007199254740993,"html":"<img src=x onerror=alert(1)>"}',
          ),
        ]}
        renderNow={now}
      />,
    );
    expect(screen.queryByLabelText("Tool payload")).toBeNull();
    toggle("Shell");
    const payload = await screen.findByLabelText("Tool payload");
    expect(payload.textContent).toContain("9007199254740993");
    expect(payload.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(payload.querySelector("img")).toBeNull();
    toggle("Shell");
    await waitFor(() => expect(screen.queryByLabelText("Tool payload")).toBeNull());
  });

  it("preserves an open exploration group and tool when new events append", async () => {
    const read = tool("read", "read_file", '{"path":"src/a.ts","offset":10}');
    const view = render(<RunMessageTimeline messages={[read]} renderNow={now} />);
    const group = toggle("Exploration");
    const row = toggle("Read");
    expect(await screen.findByLabelText("Tool payload")).toBeTruthy();
    view.rerender(
      <RunMessageTimeline
        messages={[
          read,
          tool("search", "grep", '{"pattern":"tool_use"}'),
          tool("shell", "bash", '{"cmd":"pnpm test"}'),
        ]}
        renderNow={now}
      />,
    );
    expect(group.open).toBe(true);
    expect(row.open).toBe(true);
    expect(screen.getByText("1 read, 1 search")).toBeTruthy();
    expect(screen.getByLabelText("Tool payload").textContent).toContain('"offset": 10');
    expect(screen.getByText("Shell").closest("details")?.open).toBe(false);
  });

  it("preserves malformed tools and long logs behind disclosure", async () => {
    const raw = "read src/a.ts\nnot a persisted wrapper";
    const log = "long/path/".repeat(100);
    render(
      <RunMessageTimeline
        messages={[
          { id: "bad", createdAt: now, kind: "tool_use", messageMd: raw },
          { id: "log", createdAt: now, kind: "log", messageMd: log },
        ]}
        renderNow={now}
      />,
    );
    toggle("Tool use");
    expect((await screen.findByLabelText("Tool payload")).textContent).toBe(raw);
    toggle("Log");
    expect((await screen.findByLabelText("Message details")).textContent).toBe(log);
  });
});
