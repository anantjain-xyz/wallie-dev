"use client";

import { useState } from "react";

import { WallieRunCard } from "@/features/wallie/run-activity";
import type { WallieRun, WallieRunMessage } from "@/features/wallie/types";

const tool = (id: string, name: string, input: Record<string, string>): WallieRunMessage => ({
  id,
  createdAt: "2026-09-06T12:00:00.000Z",
  kind: "tool_use",
  messageMd: `**Tool:** ${name}\n\n\`\`\`\n${JSON.stringify(input)}\n\`\`\``,
});
const messages: WallieRunMessage[] = [
  tool("read-1", "read_file", { path: "src/features/wallie/session-wallie-panel.tsx" }),
  tool("read-2", "read_file", { path: "src/features/wallie/activity-summary.ts" }),
  tool("search-1", "grep", { pattern: "tool_use", path: "src/features/wallie" }),
  {
    id: "text-1",
    createdAt: "2026-09-06T12:00:00.000Z",
    kind: "text",
    messageMd: "I’ve updated the activity layout and am checking the changes.",
  },
  tool("shell-1", "bash", { cmd: "pnpm check" }),
];
const states = [
  "Working",
  "Queued",
  "Completed",
  "Failed",
  "Canceled",
  "Disconnected",
  "Stalled",
  "Loading",
  "Empty",
] as const;
type PreviewState = (typeof states)[number];

export function AgentActivityPreview({ initialNow }: { initialNow: string }) {
  const [state, setState] = useState<PreviewState>("Working");
  const [expanded, setExpanded] = useState(false);
  const now = initialNow;
  const [extraMessages, setExtraMessages] = useState<WallieRunMessage[]>([]);
  const active = ["Working", "Queued", "Disconnected", "Stalled"].includes(state);
  const status =
    state === "Failed"
      ? "error"
      : state === "Queued"
        ? "queued"
        : state === "Canceled"
          ? "canceled"
          : active
            ? "running"
            : "success";
  const run: WallieRun = {
    attemptCount: 1,
    canCancel: active,
    canRetry: status === "error" || status === "canceled",
    createdAt: now,
    finishedAt: active ? null : now,
    id: "preview-run",
    isActive: active,
    isTerminal: !active,
    lastActivityAt: now,
    messages: ["Empty", "Loading", "Queued"].includes(state)
      ? []
      : [
          ...messages,
          ...extraMessages,
          ...(state === "Failed"
            ? [
                {
                  id: "error",
                  createdAt: now,
                  kind: "error",
                  messageMd: "**Error:** The sandbox disconnected before the build finished.",
                },
              ]
            : []),
        ],
    modelName: "gpt-5.5",
    modelProvider: "codex",
    requestedByMember: null,
    requestedByMemberId: null,
    runType: "code",
    sandboxId: "preview-sandbox",
    sandboxProvider: "vercel",
    stageId: "build",
    stageName: "Build",
    stageSlug: "build",
    startedAt: state === "Queued" ? null : new Date(Date.parse(now) - 134_000).toISOString(),
    status,
    updatedAt: now,
  };

  return (
    <main id="main-content" className="mx-auto max-w-3xl space-y-8 px-5 py-12">
      <div className="space-y-3">
        <h1 className="text-lg font-semibold">Agent activity preview</h1>
        <p className="text-sm text-muted">
          Development fixtures for the production activity component.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            State
            <select
              className="ui-select"
              value={state}
              onChange={(event) => setState(event.target.value as PreviewState)}
            >
              {states.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <button
            className="ui-button"
            onClick={() =>
              setExtraMessages((current) => [
                ...current,
                tool(`live-${current.length}`, "read_file", {
                  path: `src/features/wallie/live-update-${current.length + 1}.ts`,
                }),
              ])
            }
            type="button"
          >
            Append event
          </button>
        </div>
      </div>
      <section className="rounded-[6px] border border-border/40 bg-sheet p-5">
        <h2 className="mb-3 text-sm font-semibold">Agent activity</h2>
        <WallieRunCard
          actionPending={false}
          branchName="wallie/preview/build"
          cancelLocked={false}
          connectionState={state === "Disconnected" ? "disconnected" : "live"}
          isExpanded={expanded}
          isPrimary
          messagesLoaded={state !== "Loading"}
          messagesLoadFailed={false}
          nowMs={Date.parse(now) + (state === "Stalled" ? 900_000 : 0)}
          onCancel={async () => setState("Canceled")}
          onRetry={async () => setState("Queued")}
          onToggle={() => setExpanded((open) => !open)}
          renderNow={now}
          retryLocked={false}
          run={run}
          stallTimeoutMs={900_000}
        />
      </section>
    </main>
  );
}
