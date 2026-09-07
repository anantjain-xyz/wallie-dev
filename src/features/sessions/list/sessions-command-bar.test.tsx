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
      <SessionsCommandBar queryState={queryState} stageFacets={stageFacets} workspaceSlug="acme" />
    </OverlayProvider>,
  );
}

describe("SessionsCommandBar sticky filters", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setListUrl();
    mocked.push.mockReset();
    mocked.refresh.mockReset();
    mocked.replace.mockReset();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    setListUrl();
  });

  it("persists All to localStorage and pushes scope=all", async () => {
    const user = userEvent.setup();
    renderCommandBar();

    await user.click(screen.getByRole("button", { name: "All" }));

    expect(mocked.push).toHaveBeenLastCalledWith("/w/acme/sessions?scope=all", { scroll: false });
    expect(readSessionListPreferences("acme")).toEqual({
      scope: "all",
      sort: "updated",
      stageSlug: null,
    });
  });

  it("restores stored All, stage, and sort on a bare URL without inventing q or cursor", async () => {
    writeSessionListPreferences("acme", {
      scope: "all",
      sort: "oldest",
      stageSlug: "build",
    });
    renderCommandBar();

    await waitFor(() =>
      expect(mocked.replace).toHaveBeenCalledWith(
        "/w/acme/sessions?stage=build&scope=all&sort=oldest",
        { scroll: false },
      ),
    );
    expect(mocked.replace.mock.calls[0]?.[0]).not.toMatch(/(?:^|[?&])q=/);
    expect(mocked.replace.mock.calls[0]?.[0]).not.toMatch(/(?:^|[?&])cursor=/);
  });

  it("does not restore when the URL already has a sticky key", async () => {
    writeSessionListPreferences("acme", {
      scope: "all",
      sort: "updated",
      stageSlug: null,
    });
    setListUrl("scope=archived");
    renderCommandBar({ ...defaultQueryState, scope: "archived" });

    await screen.findByRole("button", { name: "Archived", pressed: true });
    expect(mocked.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "All", pressed: false })).toBeInTheDocument();
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
    expect(window.localStorage.getItem(sessionListPreferencesStorageKey("acme"))).not.toBeNull();
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
    expect(
      JSON.parse(window.localStorage.getItem(sessionListPreferencesStorageKey("acme"))!),
    ).not.toHaveProperty("query");
  });

  it("keeps create=1 when restoring sticky filters", async () => {
    writeSessionListPreferences("acme", {
      scope: "all",
      sort: "updated",
      stageSlug: null,
    });
    setListUrl("create=1");
    renderCommandBar();

    await waitFor(() =>
      expect(mocked.replace).toHaveBeenCalledWith("/w/acme/sessions?create=1&scope=all", {
        scroll: false,
      }),
    );
  });
});
