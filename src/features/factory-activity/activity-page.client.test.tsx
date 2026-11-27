// @vitest-environment jsdom

import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActivityRow, FactoryActivityData } from "@/features/factory-activity/activity-data";
import { FactoryActivityPage } from "@/features/factory-activity/activity-page";
import { ActivityRefresh } from "@/features/factory-activity/activity-refresh";

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

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
    expect(sessions.getByRole("status").textContent).toBe("18 sessions");
    expect(sessions.queryByText(/Most recently|Showing 1 latest|in this scope/)).toBeNull();
    expect(sessions.getByText(/Updated/)).toBeTruthy();
    expect(sessions.getByText("Complete")).toBeTruthy();
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

  it("keeps unavailable and zero counts distinct and clears filters once without changing factory", () => {
    render(
      <FactoryActivityPage
        actorLabel="Actor unavailable"
        data={{
          sessions: { kind: "unavailable" },
          runs: { kind: "available", count: 0, rows: [] },
          capturedAt,
        }}
        query={{ factory: factory.id, actor: actor.id, status: "error", runsBefore: "old" }}
        workspaceSlug="wallie"
      />,
    );

    expect(screen.getByText(/Sessions activity is unavailable. Use Refresh/)).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Sessions" })).queryByRole("status"),
    ).toBeNull();
    expect(screen.getByText("No older runs match this view.")).toBeTruthy();
    expect(screen.getByText("0 runs match")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Actor: Actor unavailable" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Clear filters" }).getAttribute("href")).toBe(
      `/w/wallie/activity?factory=${factory.id}`,
    );
  });

  it("applies run status immediately without dropping the actor or session position", async () => {
    const user = userEvent.setup();
    render(
      <FactoryActivityPage
        actorLabel={actor.label}
        data={{ sessions: { kind: "unavailable" }, runs: { kind: "unavailable" }, capturedAt }}
        query={{ factory: factory.id, actor: actor.id, sessionsBefore: "keep", runsBefore: "drop" }}
        workspaceSlug="wallie"
      />,
    );
    const status = screen.getByRole("combobox", { name: "Run status" });
    status.focus();
    await user.keyboard("{Enter}{End}{Enter}");
    expect(document.activeElement).toBe(status);
    const [href, options] = push.mock.calls[0] ?? [];
    expect(Object.fromEntries(new URL(href, "http://localhost").searchParams)).toEqual({
      factory: factory.id,
      actor: actor.id,
      status: "canceled",
      sessionsBefore: "keep",
    });
    expect(options).toEqual({ scroll: false });
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
