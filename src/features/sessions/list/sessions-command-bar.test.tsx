// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import { SessionsCommandBar } from "@/features/sessions/list/sessions-command-bar";
import {
  readSessionListPreferences,
  sessionListPreferencesStorageKey,
  sessionListPreferencesCookieName,
  writeSessionListPreferences,
} from "@/features/sessions/list/sessions-list-preferences";
import type { SessionListQueryState } from "@/features/sessions/types";

const mocked = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mocked.push,
    refresh: mocked.refresh,
    replace: mocked.replace,
  }),
}));

const defaultQueryState: SessionListQueryState = {
  cursor: null,
  query: "",
  scope: "active",
  sort: "updated",
  stageSlug: null,
};

const scopeFacets = { active: 3, all: 5, archived: 2 };

const stageFacets = [
  { count: 2, name: "Plan", position: 0, slug: "plan" },
  { count: 1, name: "Build", position: 1, slug: "build" },
];

function setListUrl(search = "") {
  window.history.replaceState(null, "", search ? `/w/acme/sessions?${search}` : "/w/acme/sessions");
}

function renderCommandBar(queryState: SessionListQueryState = defaultQueryState) {
  return render(
    <OverlayProvider>
      <SessionsCommandBar
        queryState={queryState}
        scopeFacets={scopeFacets}
        stageFacets={stageFacets}
        workspaceSlug="acme"
      />
    </OverlayProvider>,
  );
}

describe("SessionsCommandBar sticky filters", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setListUrl();
    document.cookie = `${sessionListPreferencesCookieName("acme")}=; Path=/w/acme; Max-Age=0`;
    mocked.push.mockReset();
    mocked.refresh.mockReset();
    mocked.replace.mockReset();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    setListUrl();
  });

  it("persists All to a cookie before navigation and pushes scope=all", async () => {
    const user = userEvent.setup();
    renderCommandBar();

    await user.click(screen.getByRole("radio", { name: "All 5" }));

    expect(mocked.push).toHaveBeenLastCalledWith("/w/acme/sessions?scope=all", { scroll: false });
    expect(readSessionListPreferences("acme")).toEqual({
      scope: "all",
      sort: "updated",
      stageSlug: null,
    });
  });

  it("shows scope counts on the visible scope radios", () => {
    renderCommandBar();

    const scope = screen.getByRole("radiogroup", { name: "Session scope" });
    expect(scope).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Active 3" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Active 3" })).toHaveAttribute("tabIndex", "0");
    expect(screen.getByRole("radio", { name: "Archived 2" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("radio", { name: "Archived 2" })).toHaveAttribute("tabIndex", "-1");
    expect(screen.getByRole("radio", { name: "All 5" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("radio", { name: "All 5" })).toHaveAttribute("tabIndex", "-1");
  });

  it("moves and selects scope radios with arrow keys", async () => {
    const user = userEvent.setup();
    renderCommandBar();

    const active = screen.getByRole("radio", { name: "Active 3" });
    active.focus();
    expect(active).toHaveFocus();

    await user.keyboard("{ArrowRight}");

    expect(mocked.push).toHaveBeenLastCalledWith("/w/acme/sessions?scope=archived", {
      scroll: false,
    });
    expect(screen.getByRole("radio", { name: "Archived 2" })).toHaveFocus();

    await user.keyboard("{ArrowDown}");

    expect(mocked.push).toHaveBeenLastCalledWith("/w/acme/sessions?scope=all", { scroll: false });
    expect(screen.getByRole("radio", { name: "All 5" })).toHaveFocus();

    await user.keyboard("{ArrowUp}");

    expect(mocked.push).toHaveBeenLastCalledWith("/w/acme/sessions?scope=archived", {
      scroll: false,
    });
    expect(screen.getByRole("radio", { name: "Archived 2" })).toHaveFocus();

    await user.keyboard("{End}");

    expect(mocked.push).toHaveBeenLastCalledWith("/w/acme/sessions?scope=all", { scroll: false });
    expect(screen.getByRole("radio", { name: "All 5" })).toHaveFocus();
  });

  it("exposes server-resolved filters in the URL without a second navigation", async () => {
    writeSessionListPreferences("acme", {
      scope: "all",
      sort: "oldest",
      stageSlug: "build",
    });
    renderCommandBar({ ...defaultQueryState, scope: "all", sort: "oldest", stageSlug: "build" });

    await waitFor(() => expect(window.location.search).toBe("?stage=build&scope=all&sort=oldest"));
    expect(screen.getByRole("radio", { name: "All 5" })).toHaveAttribute("aria-checked", "true");
    expect(mocked.replace).not.toHaveBeenCalled();
    expect(mocked.push).not.toHaveBeenCalled();
  });

  it("migrates legacy preferences for the next request without reloading the current list", () => {
    window.localStorage.setItem(
      sessionListPreferencesStorageKey("acme"),
      JSON.stringify({
        scope: "all",
        sort: "updated",
        stageSlug: null,
      }),
    );
    renderCommandBar();

    expect(document.cookie).toContain(sessionListPreferencesCookieName("acme"));
    expect(mocked.replace).not.toHaveBeenCalled();
    expect(mocked.push).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "Active 3" })).toHaveAttribute("aria-checked", "true");
  });

  it("does not restore when the URL already has a sticky key", async () => {
    writeSessionListPreferences("acme", {
      scope: "all",
      sort: "updated",
      stageSlug: null,
    });
    setListUrl("scope=archived");
    renderCommandBar({ ...defaultQueryState, scope: "archived" });

    expect(await screen.findByRole("radio", { name: "Archived 2" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(mocked.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "All 5" })).toHaveAttribute("aria-checked", "false");
  });

  it("writes defaults on Clear and pushes the bare sessions path", async () => {
    const user = userEvent.setup();
    writeSessionListPreferences("acme", {
      scope: "all",
      sort: "updated",
      stageSlug: null,
    });
    renderCommandBar({ ...defaultQueryState, scope: "all" });

    await user.click(screen.getByRole("button", { name: "Clear" }));

    expect(mocked.push).toHaveBeenLastCalledWith("/w/acme/sessions", { scroll: false });
    expect(readSessionListPreferences("acme")).toEqual({
      scope: "active",
      sort: "updated",
      stageSlug: null,
    });
    expect(document.cookie).toContain(sessionListPreferencesCookieName("acme"));
  });

  it("does not write search text into storage", async () => {
    const user = userEvent.setup();
    renderCommandBar({ ...defaultQueryState, scope: "all" });

    await user.type(
      screen.getByRole("searchbox", { name: "Search prompts, titles, or Linear IDs" }),
      "auth{Enter}",
    );

    expect(mocked.push).toHaveBeenLastCalledWith("/w/acme/sessions?q=auth&scope=all", {
      scroll: false,
    });
    expect(readSessionListPreferences("acme")).toEqual({
      scope: "all",
      sort: "updated",
      stageSlug: null,
    });
    expect(readSessionListPreferences("acme")).not.toHaveProperty("query");
  });

  it("keeps create=1 when restoring sticky filters", async () => {
    writeSessionListPreferences("acme", {
      scope: "all",
      sort: "updated",
      stageSlug: null,
    });
    setListUrl("create=1");
    renderCommandBar({ ...defaultQueryState, scope: "all" });

    await waitFor(() => expect(window.location.search).toBe("?create=1&scope=all"));
    expect(mocked.replace).not.toHaveBeenCalled();
    expect(mocked.push).not.toHaveBeenCalled();
  });
});
