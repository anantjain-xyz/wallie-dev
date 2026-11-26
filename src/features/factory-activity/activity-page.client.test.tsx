// @vitest-environment jsdom

import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  time: capturedAt,
  factory,
  actor,
  status: "complete",
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("factory activity", () => {
  it("pairs an exact count with canonical session, factory, and recorded actor links", () => {
    const data: FactoryActivityData = {
      sessions: {
        kind: "available",
        count: 18,
        rows: [session],
        olderQuery: { factory: "all", sessionsBefore: "example" },
      },
      runs: { kind: "available", count: 0, rows: [] },
      capturedAt,
    };
    render(
      <FactoryActivityPage
        actorLabel="All actors"
        data={data}
        query={{ factory: "all" }}
        workspaceSlug="wallie"
      />,
    );

    const sessions = within(screen.getByRole("region", { name: "Sessions" }));
    expect(sessions.getByText("18 sessions in this scope · Showing 1 latest")).toBeTruthy();
    expect(sessions.getByText("Most recently updated first")).toBeTruthy();
    expect(sessions.getByText(/Last updated/)).toBeTruthy();
    expect(sessions.getByText("Current status:")).toBeTruthy();
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
    expect(sessions.getByRole("link", { name: "Older sessions" }).getAttribute("href")).toBe(
      "/w/wallie/activity?factory=all&sessionsBefore=example#activity-sessions",
    );
    expect(screen.getByText("No runs yet.")).toBeTruthy();
  });

  it("keeps unavailable and zero counts distinct and can clear only the actor filter", () => {
    render(
      <FactoryActivityPage
        actorLabel="Actor unavailable"
        data={{
          sessions: { kind: "unavailable" },
          runs: { kind: "available", count: 0, rows: [] },
          capturedAt,
        }}
        query={{ factory: factory.id, actor: actor.id, status: "error" }}
        workspaceSlug="wallie"
      />,
    );

    expect(screen.getByText(/Sessions activity is unavailable. Use Refresh/)).toBeTruthy();
    expect(screen.queryByText("0 sessions in this scope")).toBeNull();
    expect(screen.getByText("No runs match these filters.")).toBeTruthy();
    expect(screen.getByText("0 runs match")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Actor: Actor unavailable" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Clear actor filter" }).getAttribute("href")).toBe(
      `/w/wallie/activity?factory=${factory.id}&status=error`,
    );
  });

  it("searches named actors without losing status and restores trigger focus on Escape", async () => {
    const request = vi.fn(async () =>
      Response.json({ actors: [{ ...actor, label: "Sam Roberts (@sam)" }], hasMore: false }),
    );
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(
      <PortalRootProvider>
        <FactoryActivityPage
          actorLabel="All actors"
          data={{ sessions: { kind: "unavailable" }, runs: { kind: "unavailable" }, capturedAt }}
          query={{ factory: factory.id, status: "error", runsBefore: "example" }}
          workspaceSlug="wallie"
        />
      </PortalRootProvider>,
    );
    const trigger = screen.getByRole("button", { name: "Actor: All actors" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const dialog = within(await screen.findByRole("dialog", { name: "Filter by actor" }));
    const input = dialog.getByRole("searchbox", { name: "Search actors" });
    expect(document.activeElement).toBe(input);
    await user.type(input, "@sam");
    const choice = await dialog.findByRole("link", { name: "Sam Roberts (@sam)" });
    expect(request).toHaveBeenLastCalledWith(
      `/w/wallie/activity/actors?factory=${factory.id}&q=sam`,
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(choice.getAttribute("href")).toBe(
      `/w/wallie/activity?factory=${factory.id}&status=error&actor=${actor.id}`,
    );
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(trigger);
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
import { PortalRootProvider } from "@/components/ui/portal-root";
