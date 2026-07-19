// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SessionActivityArchivedAtProvider,
  SessionActivityPanel,
} from "@/features/sessions/detail/session-activity-client";
import type { WallieSessionData } from "@/features/wallie/types";

vi.mock("@/features/wallie/session-wallie-panel", () => ({
  SessionWalliePanel: ({ session }: { session: { archivedAt: string | null } }) => (
    <div>{session.archivedAt ?? "active"}</div>
  ),
}));

const initialData: WallieSessionData = {
  blockingReasons: [],
  canEnqueue: true,
  loadedMessageRunIds: [],
  missingSecretKeys: [],
  mode: "project",
  nextRunCursor: null,
  repository: null,
  requiredSecretKeys: [],
  requiresVercelSandbox: false,
  runs: [],
  stallTimeoutMs: 900_000,
  vercelSandboxConnection: {
    connected: true,
    lastValidationError: null,
    projectId: "project-1",
    projectName: "Wallie",
    status: "connected",
    teamId: "team-1",
  },
  workspaceMembers: [],
};

function activityPanel() {
  return (
    <SessionActivityPanel
      initialArchivedAt={null}
      initialData={initialData}
      sessionId="session-18"
      workspaceId="workspace-1"
      workspaceSlug="acme-corp"
    />
  );
}

describe("SessionActivityPanel", () => {
  afterEach(() => cleanup());

  it("tracks the review client's archive state after streamed activity resolves", () => {
    const { rerender } = render(
      <SessionActivityArchivedAtProvider archivedAt={null}>
        {activityPanel()}
      </SessionActivityArchivedAtProvider>,
    );

    expect(screen.getByText("active")).toBeTruthy();

    rerender(
      <SessionActivityArchivedAtProvider archivedAt="2026-07-18T15:00:00.000Z">
        {activityPanel()}
      </SessionActivityArchivedAtProvider>,
    );

    expect(screen.getByText("2026-07-18T15:00:00.000Z")).toBeTruthy();
  });

  it("falls back to the server archive state when rendered outside the review surface", () => {
    render(
      <SessionActivityPanel
        initialArchivedAt="2026-07-18T14:00:00.000Z"
        initialData={initialData}
        sessionId="session-18"
        workspaceId="workspace-1"
        workspaceSlug="acme-corp"
      />,
    );

    expect(screen.getByText("2026-07-18T14:00:00.000Z")).toBeTruthy();
  });
});
