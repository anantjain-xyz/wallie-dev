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
  const commandBar = (state: SessionListQueryState) => (
    <OverlayProvider>
      <SessionsCommandBar
        queryState={state}
        scopeFacets={scopeFacets}
        stageFacets={stageFacets}
        workspaceSlug="acme"
      />
    </OverlayProvider>
  );
  const result = render(commandBar(queryState));
  return {
    ...result,
    rerenderQueryState: (state: SessionListQueryState) => result.rerender(commandBar(state)),
  };
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

  it("marks a draft as unapplied without requesting results while typing", async () => {
    const user = userEvent.setup();
    renderCommandBar();

    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
    await user.type(
      screen.getByRole("searchbox", { name: "Search prompts, titles, or Linear IDs" }),
      "#42",
    );

    expect(screen.getByRole("button", { name: "Search" })).toBeEnabled();
    expect(screen.getByRole("status", { name: "Sessions search status" })).toHaveTextContent(
      "Search not applied. Press Enter or click Search.",
    );
    expect(screen.getByRole("status", { name: "Sessions search status" })).toHaveTextContent(
      "Showing sessions without a search filter.",
    );
    expect(mocked.push).not.toHaveBeenCalled();
  });

  it.each(["mouse", "keyboard"])(
    "submits once by %s, preserves filters, and resets pagination",
    async (method) => {
      const user = userEvent.setup();
      const filters: SessionListQueryState = {
        ...defaultQueryState,
        cursor: "page-2",
        scope: "all",
        sort: "oldest",
        stageSlug: "build",
      };
      const { rerenderQueryState } = renderCommandBar(filters);
      const search = screen.getByRole("searchbox", {
        name: "Search prompts, titles, or Linear IDs",
      });
      await user.type(search, "auth");

      if (method === "mouse") {
        await user.click(screen.getByRole("button", { name: "Search" }));
      } else {
        await user.keyboard("{Enter}");
      }

      expect(mocked.push).toHaveBeenCalledExactlyOnceWith(
        "/w/acme/sessions?stage=build&q=auth&scope=all&sort=oldest",
        { scroll: false },
      );

      rerenderQueryState({ ...filters, query: "auth", cursor: null });
      expect(screen.getByRole("status", { name: "Sessions search status" })).toHaveTextContent(
        "Showing results for “auth”.",
      );
      expect(screen.getByRole("status", { name: "Sessions search status" })).not.toHaveTextContent(
        "Search not applied",
      );
      expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
      await user.click(search);
      await user.keyboard("{Enter}{Enter}");
      expect(mocked.push).toHaveBeenCalledTimes(1);
    },
  );

  it("treats surrounding whitespace as the applied query without another request", async () => {
    const user = userEvent.setup();
    renderCommandBar({ ...defaultQueryState, query: "auth" });
    const search = screen.getByRole("searchbox", {
      name: "Search prompts, titles, or Linear IDs",
    });

    await user.clear(search);
    await user.type(search, " auth {Enter}");

    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
    expect(screen.getByRole("status", { name: "Sessions search status" })).not.toHaveTextContent(
      "Search not applied",
    );
    expect(mocked.push).not.toHaveBeenCalled();
  });

  it("clears only an unapplied draft without navigation and restores input focus", async () => {
    const user = userEvent.setup();
    renderCommandBar({ ...defaultQueryState, scope: "all", stageSlug: "build" });
    const search = screen.getByRole("searchbox", {
      name: "Search prompts, titles, or Linear IDs",
    });
    await user.type(search, "draft");

    await user.click(screen.getByRole("button", { name: "Clear search" }));

    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
    expect(screen.getByRole("status", { name: "Sessions search status" })).not.toHaveTextContent(
      "Search not applied",
    );
    expect(screen.getByRole("radio", { name: "All 5" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("combobox", { name: "Filter by stage" })).toHaveTextContent("Build");
    expect(mocked.push).not.toHaveBeenCalled();
  });

  it("clears an applied search while preserving scope, stage, and sort", async () => {
    const user = userEvent.setup();
    renderCommandBar({
      ...defaultQueryState,
      cursor: "page-2",
      query: "auth",
      scope: "all",
      sort: "oldest",
      stageSlug: "build",
    });

    await user.click(screen.getByRole("button", { name: "Clear search" }));

    expect(mocked.push).toHaveBeenCalledExactlyOnceWith(
      "/w/acme/sessions?stage=build&scope=all&sort=oldest",
      { scroll: false },
    );
    expect(
      screen.getByRole("searchbox", { name: "Search prompts, titles, or Linear IDs" }),
    ).toHaveValue("");
    expect(
      screen.getByRole("searchbox", { name: "Search prompts, titles, or Linear IDs" }),
    ).toHaveFocus();
  });

  it("marks an emptied field as unapplied until keyboard submission", async () => {
    const user = userEvent.setup();
    renderCommandBar({ ...defaultQueryState, query: "auth", scope: "all" });
    const search = screen.getByRole("searchbox", {
      name: "Search prompts, titles, or Linear IDs",
    });

    await user.clear(search);
    expect(screen.getByRole("status", { name: "Sessions search status" })).toHaveTextContent(
      "Search not applied",
    );
    expect(screen.getByRole("status", { name: "Sessions search status" })).toHaveTextContent(
      "Showing results for “auth”.",
    );
    expect(mocked.push).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");
    expect(mocked.push).toHaveBeenCalledExactlyOnceWith("/w/acme/sessions?scope=all", {
      scroll: false,
    });
  });

  it("allows Clear to discard a draft and reset every filter", async () => {
    const user = userEvent.setup();
    renderCommandBar({ ...defaultQueryState, scope: "all", sort: "oldest", stageSlug: "build" });
    await user.type(
      screen.getByRole("searchbox", { name: "Search prompts, titles, or Linear IDs" }),
      "draft",
    );

    await user.click(screen.getByRole("button", { name: "Clear" }));

    expect(mocked.push).toHaveBeenCalledExactlyOnceWith("/w/acme/sessions", { scroll: false });
    expect(
      screen.getByRole("searchbox", { name: "Search prompts, titles, or Linear IDs" }),
    ).toHaveValue("");
  });

  it("synchronizes a focused search and its visible summary with history results", async () => {
    const user = userEvent.setup();
    const { rerenderQueryState } = renderCommandBar({ ...defaultQueryState, query: "new" });
    const search = screen.getByRole("searchbox", {
      name: "Search prompts, titles, or Linear IDs",
    });
    await user.click(search);

    rerenderQueryState({ ...defaultQueryState, query: "old", scope: "all" });

    expect(search).toHaveValue("old");
    expect(search).toHaveFocus();
    expect(screen.getByRole("status", { name: "Sessions search status" })).toHaveTextContent(
      "Showing results for “old”.",
    );
    expect(screen.getByRole("status", { name: "Sessions search status" })).not.toHaveTextContent(
      "Search not applied",
    );
    expect(mocked.push).not.toHaveBeenCalled();
  });

  it.each(["Clear search", "Clear"])(
    "restores history results after %s discards a draft without navigation",
    async (action) => {
      const user = userEvent.setup();
      const { rerenderQueryState } = renderCommandBar();
      const search = screen.getByRole("searchbox", {
        name: "Search prompts, titles, or Linear IDs",
      });
      await user.type(search, "discarded");
      await user.click(screen.getByRole("button", { name: action }));
      expect(mocked.push).not.toHaveBeenCalled();
      await user.type(search, "another draft");

      rerenderQueryState({ ...defaultQueryState, query: "history" });

      expect(search).toHaveValue("history");
      expect(screen.getByRole("status", { name: "Sessions search status" })).toHaveTextContent(
        "Showing results for “history”.",
      );
      expect(screen.getByRole("status", { name: "Sessions search status" })).not.toHaveTextContent(
        "Search not applied",
      );
      expect(mocked.push).not.toHaveBeenCalled();
    },
  );

  it("restores history when it differs from a submitted query whose results never arrived", async () => {
    const user = userEvent.setup();
    const { rerenderQueryState } = renderCommandBar();
    const search = screen.getByRole("searchbox", {
      name: "Search prompts, titles, or Linear IDs",
    });
    await user.type(search, "auth{Enter}entication");

    rerenderQueryState({ ...defaultQueryState, query: "history" });

    expect(search).toHaveValue("history");
    expect(screen.getByRole("status", { name: "Sessions search status" })).toHaveTextContent(
      "Showing results for “history”.",
    );
    expect(screen.getByRole("status", { name: "Sessions search status" })).not.toHaveTextContent(
      "Search not applied",
    );
    expect(mocked.push).toHaveBeenCalledTimes(1);
  });

  it("keeps later draft edits unapplied when the submitted results arrive", async () => {
    const user = userEvent.setup();
    const { rerenderQueryState } = renderCommandBar();
    const search = screen.getByRole("searchbox", {
      name: "Search prompts, titles, or Linear IDs",
    });
    await user.type(search, "auth{Enter}entication");

    rerenderQueryState({ ...defaultQueryState, query: "auth" });

    expect(search).toHaveValue("authentication");
    expect(screen.getByRole("status", { name: "Sessions search status" })).toHaveTextContent(
      "Search not applied",
    );
    expect(screen.getByRole("status", { name: "Sessions search status" })).toHaveTextContent(
      "Showing results for “auth”.",
    );
    expect(mocked.push).toHaveBeenCalledTimes(1);
  });
});
