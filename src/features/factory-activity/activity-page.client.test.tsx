// @vitest-environment jsdom

import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActivityRow, FactoryActivityData } from "@/features/factory-activity/activity-data";
import { FactoryActivityPage } from "@/features/factory-activity/activity-page";
import { ActivityRefresh } from "@/features/factory-activity/activity-refresh";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const capturedAt = "2026-11-18T15:45:00Z";
const factory = { id: "d18b4467-122d-4367-8628-f76856b8615e", name: "Research" };
const actor = { id: "17575802-5051-4835-a916-9f6419560ab6", label: "Sam Roberts" };
const session: ActivityRow = {
  id: "session",
  href: "/w/wallie/sessions/42",
  title: "Qualify research",
  description: "#42",
  occurredAt: capturedAt,
  factory,
  actor,
  status: "complete",
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("factory activity", () => {
  it("pairs an exact count with canonical session, factory, and recorded actor links", () => {
    const data: FactoryActivityData = {
      sessions: { kind: "available", count: 18, rows: [session] },
      runs: { kind: "available", count: 0, rows: [] },
      capturedAt,
    };
    render(
      <FactoryActivityPage
        data={data}
        factory={{ id: "all", label: "All factories" }}
        workspaceSlug="wallie"
      />,
    );

    const sessions = within(screen.getByRole("region", { name: "Sessions" }));
    expect(sessions.getByText("18 sessions in this scope · Showing 1 most recent")).toBeTruthy();
    expect(sessions.getByRole("link", { name: "Qualify research" }).getAttribute("href")).toBe(
      "/w/wallie/sessions/42",
    );
    expect(sessions.getByRole("link", { name: "Research" }).getAttribute("href")).toBe(
      "/w/wallie/activity?factory=" + factory.id,
    );
    expect(sessions.getByRole("link", { name: "Sam Roberts" }).getAttribute("href")).toBe(
      "/w/wallie/activity?factory=all&actor=" + actor.id,
    );
    expect(sessions.getByRole("link", { name: "View sessions" }).getAttribute("href")).toBe(
      "/w/wallie/sessions?factory=all&scope=all",
    );
    expect(screen.getByText("No runs in this scope.")).toBeTruthy();
  });

  it("keeps unavailable and zero counts distinct and can clear only the actor filter", () => {
    render(
      <FactoryActivityPage
        actorId={actor.id}
        data={{
          sessions: { kind: "unavailable" },
          runs: { kind: "available", count: 0, rows: [] },
          capturedAt,
        }}
        factory={{ id: factory.id, label: factory.name }}
        workspaceSlug="wallie"
      />,
    );

    expect(screen.getByText("Sessions activity is unavailable.")).toBeTruthy();
    expect(screen.queryByText("0 sessions in this scope")).toBeNull();
    expect(screen.getByText("0 runs in this scope")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Clear actor filter" }).getAttribute("href")).toBe(
      "/w/wallie/activity?factory=" + factory.id,
    );
  });

  it("marks the displayed snapshot stale as it ages and resets freshness on refresh", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(capturedAt));
    const { rerender } = render(<ActivityRefresh capturedAt={capturedAt} />);
    expect(screen.queryByText(/snapshot is stale/)).toBeNull();

    act(() => vi.advanceTimersByTime(5 * 60 * 1000));
    expect(screen.getByText(/snapshot is stale/)).toBeTruthy();

    act(() => screen.getByRole("button", { name: "Refresh" }).click());
    expect(refresh).toHaveBeenCalledOnce();
    rerender(<ActivityRefresh capturedAt={new Date().toISOString()} />);
    expect(screen.queryByText(/snapshot is stale/)).toBeNull();
  });
});
